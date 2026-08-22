const increment = (map, key = "UNKNOWN") => map.set(key, (map.get(key) ?? 0) + 1);
const asObject = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

function blockerCategory(text) {
  if (/4h RSI/i.test(text)) return "4h RSI";
  if (/日线 RSI/i.test(text)) return "日线 RSI";
  if (/拥挤/i.test(text)) return "衍生品拥挤";
  if (/squeeze|挤压/i.test(text)) return "Squeeze";
  if (/数据|缺少|过期|Order Book|Funding|OI|Mark|Basis/i.test(text)) return "行情数据异常";
  if (/RR/i.test(text)) return "净 RR";
  if (/连续亏损/i.test(text)) return "连续亏损";
  if (/当日损失/i.test(text)) return "当日损失";
  if (/已有.*仓位/i.test(text)) return "已有持仓";
  return text || "未分类";
}

export function calculateGateReport(db, { since } = {}) {
  const snapshots = db.getSnapshots({ since });
  const setups = db.getSetups({ since });
  const decisions = new Map();
  const biases = new Map();
  const regimes = new Map();
  const entryMethods = new Map();
  const hardBlocks = new Map();
  const historicalHardBlocks = new Map();
  const softWarnings = new Map();
  const historicalSoftWarnings = new Map();
  let legacySnapshots = 0;
  let v11Snapshots = 0;
  let v12Snapshots = 0;
  let immediateEntries = 0;
  let longScoreTotal = 0;
  let shortScoreTotal = 0;
  let scoredSnapshots = 0;

  for (const snapshot of snapshots) {
    const report = snapshot.report ?? {};
    increment(decisions, snapshot.decision);
    increment(biases, report.strategy?.bias ?? snapshot.candidate_decision);
    if (report.version === "V1.2") {
      v12Snapshots += 1;
      increment(regimes, report.strategy?.marketRegime);
      increment(entryMethods, report.entryAssessment?.method);
      if (report.entryAssessment?.enterNow) immediateEntries += 1;
      if (Number.isFinite(report.opportunities?.LONG?.score) && Number.isFinite(report.opportunities?.SHORT?.score)) {
        longScoreTotal += report.opportunities.LONG.score;
        shortScoreTotal += report.opportunities.SHORT.score;
        scoredSnapshots += 1;
      }
      for (const item of report.riskGates ?? []) increment(hardBlocks, blockerCategory(item));
      for (const item of report.strategy?.softWarnings ?? []) increment(softWarnings, blockerCategory(item));
    } else if (report.strategy) {
      v11Snapshots += 1;
      increment(regimes, report.strategy.marketRegime);
      for (const item of report.strategy.hardBlocks ?? report.riskGates ?? []) increment(historicalHardBlocks, blockerCategory(item));
      for (const item of report.strategy.softWarnings ?? []) increment(historicalSoftWarnings, blockerCategory(item));
    } else {
      legacySnapshots += 1;
      for (const item of snapshot.riskGates ?? []) increment(historicalHardBlocks, blockerCategory(item));
    }
  }

  const setupStatuses = new Map();
  for (const setup of setups) increment(setupStatuses, setup.status);
  return {
    since: since ?? null,
    snapshotCount: snapshots.length,
    legacySnapshots,
    v11Snapshots,
    v12Snapshots,
    decisions: asObject(decisions),
    biases: asObject(biases),
    regimes: asObject(regimes),
    entryMethods: asObject(entryMethods),
    hardBlocks: asObject(hardBlocks),
    historicalHardBlocks: asObject(historicalHardBlocks),
    softWarnings: asObject(softWarnings),
    historicalSoftWarnings: asObject(historicalSoftWarnings),
    immediateEntries,
    averageLongScore: scoredSnapshots ? Number((longScoreTotal / scoredSnapshots).toFixed(1)) : null,
    averageShortScore: scoredSnapshots ? Number((shortScoreTotal / scoredSnapshots).toFixed(1)) : null,
    legacySetupCount: setups.length,
    legacySetupStatuses: asObject(setupStatuses),
    activeLegacySetup: db.getActiveSetup()
  };
}

function rows(object) {
  const entries = Object.entries(object);
  return entries.length ? entries.map(([key, value]) => `- ${key}: ${value}`) : ["- 无"];
}

export function formatGateReport(report) {
  return [
    "BTC/USDT V1.2 Dynamic Gate 统计",
    `统计起点：${report.since ?? "全部历史"}`,
    `行情快照：${report.snapshotCount}（旧版 ${report.legacySnapshots} / V1.1 ${report.v11Snapshots} / V1.2 ${report.v12Snapshots}）`,
    `V1.2 平均机会分：做多 ${report.averageLongScore ?? "—"} / 做空 ${report.averageShortScore ?? "—"}；即时入场判断 ${report.immediateEntries} 次`,
    "",
    "最终决策",
    ...rows(report.decisions),
    "",
    "每轮方向偏好",
    ...rows(report.biases),
    "",
    "动态入场方式",
    ...rows(report.entryMethods),
    "",
    "市场状态",
    ...rows(report.regimes),
    "",
    "V1.2 行情数据硬拦截",
    ...rows(report.hardBlocks),
    "",
    "旧版历史硬拦截（不再控制 V1.2）",
    ...rows(report.historicalHardBlocks),
    "",
    "0.5% 风险降级提示",
    ...rows(report.softWarnings),
    "",
    "旧版历史风险降级（不再控制 V1.2）",
    ...rows(report.historicalSoftWarnings),
    "",
    `旧版固定计划历史记录：${report.legacySetupCount}`,
    ...rows(report.legacySetupStatuses),
    `当前活动旧计划：${report.activeLegacySetup ? `#${report.activeLegacySetup.id}（下一轮自动取消）` : "无"}`,
    "",
    "说明：V1.2 不创建固定待触发计划；方向、入场方式和价格在每轮都按最新行情重新计算。"
  ].join("\n");
}
