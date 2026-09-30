'use strict';
// コスト暴走防止のための上限値。環境変数で調整できます。
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

module.exports = {
  port: num(process.env.PORT, 3000),
  appPassword: process.env.APP_PASSWORD || '',     // 設定すると全体に Basic 認証
  trustProxy: process.env.TRUST_PROXY || '',       // 例: 1（リバースプロキシ配下のとき）
  chromiumPath: process.env.CHROMIUM_PATH || undefined,

  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
  maxDurationSec: num(process.env.MAX_DURATION_SEC, 60),  // 1 本あたりの最大長
  defaultDurationSec: 0,                                   // 0 = 自動検出
  maxFrames: num(process.env.MAX_FRAMES, 3600),
  jobTimeoutMs: num(process.env.JOB_TIMEOUT_SEC, 180) * 1000,

  maxConcurrentJobs: num(process.env.MAX_CONCURRENT_JOBS, 1),
  maxQueue: num(process.env.MAX_QUEUE, 3),
  maxJobsPerIpPerHour: num(process.env.MAX_JOBS_PER_IP_PER_HOUR, 10),
  maxJobsPerDay: num(process.env.MAX_JOBS_PER_DAY, 200),   // サービス全体の 1 日上限
  maxRequestsPerIpPerMin: num(process.env.MAX_REQ_PER_IP_PER_MIN, 120),

  fileTtlMs: num(process.env.FILE_TTL_MIN, 10) * 60 * 1000, // 一時ファイル自動削除
  fps: 30,
};
