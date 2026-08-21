import { HEALTH_CONFIG } from "./config.mjs";

const validDateMs = (value) => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function evaluateHealth(db, {
  nowMs = Date.now(),
  maxAgeMs = HEALTH_CONFIG.maxAgeMs
} = {}) {
  const failures = [];
  const account = db.getAccount();
  const run = db.getLatestMonitorRun();
  const snapshot = db.getLatestSnapshot();

  if (!account || !Number.isFinite(Number(account.cash_cny))) failures.push("模拟账户状态不可读");
  if (!run) failures.push("尚无 monitor 运行记录");
  if (!snapshot) failures.push("尚无行情快照");
  if (run?.status !== "OK") failures.push(`最近 monitor 状态为 ${run?.status ?? "UNKNOWN"}`);

  const finishedAtMs = validDateMs(run?.finished_at);
  const ageMs = finishedAtMs === null ? null : nowMs - finishedAtMs;
  if (run && finishedAtMs === null) failures.push("最近 monitor 时间无效");
  if (ageMs !== null && ageMs > maxAgeMs) failures.push(`最近 monitor 已超过 ${Math.round(maxAgeMs / 60_000)} 分钟`);
  if (ageMs !== null && ageMs < -60_000) failures.push("系统时间早于 monitor 记录");

  return {
    healthy: failures.length === 0,
    checkedAt: new Date(nowMs).toISOString(),
    failures,
    monitor: run ? {
      status: run.status,
      finishedAt: run.finished_at,
      ageSeconds: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
      message: run.message
    } : null,
    snapshot: snapshot ? {
      count: db.countSnapshots(),
      capturedAt: snapshot.captured_at,
      decision: snapshot.decision,
      price: snapshot.price
    } : null,
    account: account ? {
      cashCny: Number(account.cash_cny),
      initialCapitalCny: Number(account.initial_capital_cny),
      openPosition: Boolean(db.getOpenPosition())
    } : null
  };
}

export function formatHealth(result) {
  const lines = [
    `BTC/USDT V1 health：${result.healthy ? "HEALTHY" : "UNHEALTHY"}`,
    `检查时间：${result.checkedAt}`
  ];
  if (result.monitor) lines.push(`最近 monitor：${result.monitor.status} / ${result.monitor.finishedAt} / ${result.monitor.ageSeconds}s 前`);
  if (result.snapshot) lines.push(`快照：${result.snapshot.count} 次 / ${result.snapshot.decision} / ${result.snapshot.price} USDT`);
  if (result.account) lines.push(`模拟现金：${result.account.cashCny} CNY / 模拟持仓：${result.account.openPosition ? "有" : "无"}`);
  if (result.failures.length) lines.push("失败原因：", ...result.failures.map((item) => `- ${item}`));
  lines.push("安全：health 只读取本地 SQLite，不调用交易所接口。");
  return lines.join("\n");
}
