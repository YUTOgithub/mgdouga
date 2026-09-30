'use strict';
// 簡易動作確認: サーバーを起動して sample.html を変換し、MP4 が得られるか確認
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const port = 3999;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: port }, stdio: 'inherit', cwd: path.join(__dirname, '..') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(1500);
  const base = `http://localhost:${port}`;
  const UA = { 'user-agent': 'Mozilla/5.0 smoke' };
  const fd = new FormData();
  fd.append('size', '9x16'); fd.append('duration', '0');
  fd.append('html', new Blob([fs.readFileSync(path.join(__dirname, 'sample.html'))]), 'sample.html');
  let j = await (await fetch(base + '/api/jobs', { method: 'POST', body: fd, headers: UA })).json();
  while (j.status !== 'done' && j.status !== 'error') { await sleep(500); j = await (await fetch(`${base}/api/jobs/${j.id}`, { headers: UA })).json(); }
  if (j.status === 'error') throw new Error(j.error);
  const buf = Buffer.from(await (await fetch(`${base}/api/jobs/${j.id}/download`, { headers: UA })).arrayBuffer());
  fs.writeFileSync(process.env.OUT || '/tmp/smoke.mp4', buf);
  console.log('MP4 bytes:', buf.length, 'ftyp:', buf.slice(4, 8).toString());
  const bot = await fetch(base + '/', { headers: { 'user-agent': 'GPTBot/1.0' } });
  console.log('bot status:', bot.status);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => srv.kill());
