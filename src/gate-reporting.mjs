const increment = (map, key = "UNKNOWN") => map.set(key, (map.get(key) ?? 0) + 1);
const asObject = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

function blockerCategory(text) {
  if (/4h RSI/i.test(text)) return "4h RSI";
  if (/日线 RSI/i.test(text)) return "日线 RSI";
  if (/拥挤/i.test(text)) return "衍生品拥挤";
  if (/squeeze|挤压/i.test(text)) return "Squeeze";
  if (/RR/i.test(text)) return "净 RR";
  if (/连续亏损/i.test(text)) return "连续亏损";
  if (/当日损失/i.test(text)) return "当日损失";
  return text || "未分类";
}

export function calculateGateReport(db, { since } = {}) {
  const snapshots = db.getSnapshots({ since });
  const setups = db.getSetups({ since });
  const decisions = new Map();
  const biases = new Map();
  const regimes = new Map();
  const strategyStates = new Map();
  const hardBlocks = new Map();
  const softWarnings = new Map();
  let legacySnapshots = 0;
  let v11Snapshots = 0;

  for (const snapshot of snapshots) {
    const report = snapshot.report ?? {};
    increment(decisions, snapshot.decision);
    increment(biases, report.strategy?.bias ?? snapshot.candidate_decision);
    if (report.strategy) {
      v11Snapshots += 1;
      increment(regimes, report.strategy.marketRegime);
      increment(strategyStates, report.strategy.state);
      for (const item of report.strategy.hardBlocks ?? []) increment(hardBlocks, blockerCategory(item));
      for (const item of report.strategy.softWarnings ?? []) increment(softWarnings, blockerCategory(item));
    } else {
      legacySnapshots += 1;
      for (const item of snapshot.riskGates ?? []) increment(hardBlocks, blockerCategory(item));
    }
  }

  const setupStatuses = new Map();
  const setupTypes = new Map();
  for (const setup of setups) {
    increment(setupStatuses, setup.status);
    increment(setupTypes, setup.setup_type);
  }
  return {
    since: since ?? null,
    snapshotCount: snapshots.length,
    legacySnapshots,
    v11Snapshots,
    decisions: asObject(decisions),
    biases: asObject(biases),
    regimes: asObject(regimes),
    strategyStates: asObject(strategyStates),
    hardBlocks: asObject(hardBlocks),
    softWarnings: asObject(softWarnings),
    setupCount: setups.length,
    setupStatuses: asObject(setupStatuses),
    setupTypes: asObject(setupTypes),
    activeSetup: db.getActiveSetup()
  };
}

function rows(object) {
  const entries = Object.entries(object);
  return entries.length ? entries.map(([key, value]) => `- ${key}: ${value}`) : ["- 无"];
}

export function formatGateReport(report) {
  return [
    "BTC/USDT V1.1 Gate 统计",
    `统计起点：${report.since ?? "全部历史"}`,
    `行情快照：${report.snapshotCount}（旧版 ${report.legacySnapshots} / V1.1 ${report.v11Snapshots}）`,
    "",
    "最终决策",
    ...rows(report.decisions),
    "",
    "方向偏好",
    ...rows(report.biases),
    "",
    "市场状态",
    ...rows(report.regimes),
    "",
    "硬性拦截次数",
    ...rows(report.hardBlocks),
    "",
    "0.5% 风险降级次数",
    ...rows(report.softWarnings),
    "",
    `待触发计划：${report.setupCount}`,
    ...rows(report.setupStatuses),
    ...rows(report.setupTypes),
    `当前活动计划：${report.activeSetup ? `#${report.activeSetup.id} ${report.activeSetup.side} ${report.activeSetup.status}` : "无"}`,
    "",
    "说明：风险降级按快照计数，不等于成交次数；旧版快照会继续保留用于诊断，但不控制 V1.1 入场。"
  ].join("\n");
}

