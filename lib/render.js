'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const ffmpegPath = require('ffmpeg-static');
const cfg = require('./config');

// アップロード HTML が外部へ勝手にアクセスしないよう、許可ホスト以外は遮断
const ALLOWED_HOSTS = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com',
]);
const ORIGIN = 'http://motion.invalid';

function encode(listFile, out, { width, height }, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `fps=${cfg.fps},scale=${width}:${height},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(cfg.fps),
      '-movflags', '+faststart', '-an', '-progress', 'pipe:1', '-nostats', out];
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d));
      if (m) onProgress(Number(m[1]) / 1e6);
    });
    signal.addEventListener('abort', () => p.kill('SIGKILL'));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err))));
  });
}

/**
 * HTML を実ブラウザで再生し、画面の変化を JPEG フレームとして記録 → 30fps の MP4 にする。
 * @param {object} o { htmlPath, outPath, workDir, size:{width,height}, durationSec (0=自動), onProgress(pct,msg), signal }
 */
async function renderHtmlToMp4(o) {
  const { htmlPath, outPath, workDir, size, durationSec, onProgress, signal } = o;
  const maxSec = durationSec > 0 ? Math.min(durationSec, cfg.maxDurationSec) : cfg.maxDurationSec;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const framesDir = path.join(workDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: cfg.chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const frames = []; // { file, ts }
  let tooMany = false;
  try {
    signal.addEventListener('abort', () => browser.close().catch(() => {}));
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.origin === ORIGIN) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      }
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue();
      if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)) return route.continue();
      return route.abort();
    });

    const cdp = await ctx.newCDPSession(page);
    let pending = Promise.resolve();
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const idx = frames.length;
      if (idx >= cfg.maxFrames) { tooMany = true; cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); return; }
      const file = path.join(framesDir, `f${String(idx).padStart(6, '0')}.jpg`);
      frames.push({ file, ts: metadata.timestamp });
      pending = pending.then(() => fs.promises.writeFile(file, Buffer.from(data, 'base64')));
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 92, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1,
    });

    const startWall = Date.now();
    await page.goto(ORIGIN + '/', { waitUntil: 'load', timeout: 20000 }).catch(() => {});

    // 記録ループ
    let lastCount = 0; let lastChange = Date.now();
    while (!signal.aborted && !tooMany) {
      await new Promise((r) => setTimeout(r, 200));
      const elapsed = (Date.now() - startWall) / 1000;
      if (frames.length !== lastCount) { lastCount = frames.length; lastChange = Date.now(); }
      if (durationSec > 0) {
        onProgress(Math.min(85, (elapsed / maxSec) * 85), `録画中 ${Math.min(elapsed, maxSec).toFixed(0)}/${maxSec}秒`);
        if (elapsed >= maxSec) break;
      } else {
        // 自動: 画面変化が 2 秒止まれば終了（ループ系は最大秒数で打ち切り）
        onProgress(Math.min(80, (elapsed / maxSec) * 85), `録画中 ${elapsed.toFixed(0)}秒`);
        if (elapsed > 1.5 && Date.now() - lastChange > 2000) break;
        if (elapsed >= maxSec) break;
      }
    }
    await cdp.send('Page.stopScreencast').catch(() => {});
    await pending;
    if (signal.aborted) throw new Error('タイムアウトしました');
  } finally {
    await browser.close().catch(() => {});
  }

  if (frames.length === 0) throw new Error('フレームを取得できませんでした（HTML が空、または描画されませんでした）');

  // 各フレームの表示時間から concat リストを作成
  const t0 = frames[0].ts;
  const lastTs = frames[frames.length - 1].ts;
  const endTs = durationSec > 0 ? Math.max(t0 + maxSec, lastTs + 0.1) : lastTs + 0.5;
  const lines = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : endTs;
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${Math.max(next - f.ts, 0.001).toFixed(6)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  const listFile = path.join(workDir, 'list.txt');
  fs.writeFileSync(listFile, lines.join('\n'));

  const total = endTs - t0;
  onProgress(88, 'MP4 に変換中');
  await encode(listFile, outPath, size, (sec) => onProgress(88 + Math.min(11, (sec / total) * 11), 'MP4 に変換中'), signal);
  fs.rmSync(framesDir, { recursive: true, force: true });
}

module.exports = { renderHtmlToMp4 };
