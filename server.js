'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./lib/config');
const SIZES = require('./lib/sizes');
const guards = require('./lib/guards');
const { renderHtmlToMp4 } = require('./lib/render');

const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'html2mp4-'));
const jobs = new Map();
const queue = [];
let running = 0;

// --- 入口ガード（課金暴走対策） ---
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, noai, noimageai'); next(); });
app.use(guards.blockBots);
app.use(guards.limitRequests);
app.use(guards.basicAuth);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ROOT),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.html'),
  }),
  limits: { fileSize: cfg.maxUploadBytes, files: 1 },
});

const publicJob = (j) => ({
  id: j.id, status: j.status, progress: Math.round(j.progress), message: j.message, error: j.error,
  queuePosition: j.status === 'queued' ? queue.indexOf(j.id) + 1 : 0,
});

function cleanup(j) {
  fs.rmSync(j.workDir, { recursive: true, force: true });
  if (j.htmlPath) fs.rmSync(j.htmlPath, { force: true });
}

async function runJob(j) {
  running += 1;
  j.status = 'rendering';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.jobTimeoutMs);
  try {
    await renderHtmlToMp4({
      htmlPath: j.htmlPath, outPath: j.outPath, workDir: j.workDir, size: SIZES[j.size],
      durationSec: j.durationSec, signal: ac.signal,
      onProgress: (p, msg) => { j.progress = p; j.message = msg; if (p >= 88) j.status = 'encoding'; },
    });
    j.status = 'done'; j.progress = 100; j.message = '完了';
    j.filename = `youtube-gemini-motion-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${j.size}.mp4`;
  } catch (e) {
    j.status = 'error';
    j.error = ac.signal.aborted ? '処理時間の上限を超えました' : String(e.message || e).slice(0, 300);
    console.error('job failed', j.id, e);
  } finally {
    clearTimeout(timer);
    fs.rmSync(j.htmlPath, { force: true }); // アップロード HTML は処理後すぐ削除
    j.htmlPath = null;
    running -= 1;
    setTimeout(() => { cleanup(j); jobs.delete(j.id); }, cfg.fileTtlMs).unref();
    pump();
  }
}

function pump() {
  while (running < cfg.maxConcurrentJobs && queue.length) {
    const id = queue.shift();
    const j = jobs.get(id);
    if (j) runJob(j);
  }
}

app.post('/api/jobs', guards.limitJobs, (req, res) => {
  if (queue.length >= cfg.maxQueue) return res.status(503).json({ error: '混み合っています。少し待ってからお試しください。' });
  upload.single('html')(req, res, (err) => {
    if (err) {
      const big = err.code === 'LIMIT_FILE_SIZE';
      return res.status(big ? 413 : 400).json({ error: big ? `ファイルが大きすぎます（上限 ${cfg.maxUploadBytes / 1048576}MB）` : 'アップロードに失敗しました' });
    }
    if (!req.file) return res.status(400).json({ error: 'HTML ファイルを選択してください' });
    const size = SIZES[req.body.size] ? req.body.size : '9x16';
    const d = parseInt(req.body.duration, 10);
    const id = crypto.randomUUID();
    const workDir = path.join(ROOT, id);
    fs.mkdirSync(workDir);
    const j = {
      id, size, durationSec: Number.isFinite(d) && d > 0 ? Math.min(d, cfg.maxDurationSec) : cfg.defaultDurationSec,
      htmlPath: req.file.path, workDir, outPath: path.join(workDir, 'out.mp4'),
      status: 'queued', progress: 0, message: '順番待ち', error: null,
    };
    jobs.set(id, j); queue.push(id);
    pump();
    res.status(202).json(publicJob(j));
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'ジョブが見つかりません（期限切れの可能性）' });
  res.json(publicJob(j));
});

app.get('/api/jobs/:id/download', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'ファイルがありません' });
  res.download(j.outPath, j.filename, (e) => { if (!e) { cleanup(j); jobs.delete(j.id); } });
});

app.get('/api/config', (req, res) => res.json({
  maxDurationSec: cfg.maxDurationSec, maxUploadMB: cfg.maxUploadBytes / 1048576,
  sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v.label])),
}));

const server = app.listen(cfg.port, () => console.log(`http://localhost:${cfg.port}`));
server.requestTimeout = 60000;
const bye = () => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
