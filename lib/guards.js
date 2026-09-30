'use strict';
const crypto = require('crypto');
const cfg = require('./config');

// AI / 大量取得系クローラーは入口で遮断（帯域・CPU 課金の予防）
const BOT_UA = /(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|CCBot|Google-Extended|Bytespider|PerplexityBot|Amazonbot|Applebot-Extended|FacebookBot|meta-externalagent|cohere-ai|Diffbot|ImagesiftBot|omgili|Timpibot|YouBot|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|Scrapy|python-requests|curl\/|wget\/)/i;

function blockBots(req, res, next) {
  if (req.path === '/robots.txt') return next();
  if (BOT_UA.test(req.get('user-agent') || '')) return res.status(403).type('text').send('Forbidden');
  next();
}

// 固定ウィンドウのシンプルなレート制限（依存パッケージなし）
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000)).unref();
  return function take(key) {
    const now = Date.now();
    let v = hits.get(key);
    if (!v || v.reset <= now) { v = { count: 0, reset: now + windowMs }; hits.set(key, v); }
    v.count += 1;
    return { ok: v.count <= max, retryAfterSec: Math.ceil((v.reset - now) / 1000) };
  };
}

const reqLimiter = makeLimiter({ windowMs: 60000, max: cfg.maxRequestsPerIpPerMin });
const jobLimiter = makeLimiter({ windowMs: 3600000, max: cfg.maxJobsPerIpPerHour });
const dayLimiter = makeLimiter({ windowMs: 86400000, max: cfg.maxJobsPerDay });

function limitRequests(req, res, next) {
  const r = reqLimiter(req.ip);
  if (!r.ok) { res.set('Retry-After', r.retryAfterSec); return res.status(429).json({ error: 'アクセスが多すぎます。しばらくしてからお試しください。' }); }
  next();
}

function limitJobs(req, res, next) {
  const d = dayLimiter('all');
  if (!d.ok) { res.set('Retry-After', d.retryAfterSec); return res.status(429).json({ error: '本日の変換上限に達しました。明日またお試しください。' }); }
  const r = jobLimiter(req.ip);
  if (!r.ok) { res.set('Retry-After', r.retryAfterSec); return res.status(429).json({ error: '1 時間あたりの変換回数の上限に達しました。' }); }
  next();
}

function basicAuth(req, res, next) {
  if (!cfg.appPassword || req.path === '/robots.txt') return next();
  const m = /^Basic (.+)$/.exec(req.get('authorization') || '');
  if (m) {
    const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(cfg.appPassword).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="html-to-mp4"');
  res.status(401).send('Authentication required');
}

module.exports = { blockBots, limitRequests, limitJobs, basicAuth };
