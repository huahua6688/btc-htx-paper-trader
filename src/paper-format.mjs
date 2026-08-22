import { calculatePerformance, calculateUnrealized, getDailyRiskState } from "./paper-engine.mjs";
import { PAPER_ASSUMPTIONS, PAPER_CONFIG } from "./config.mjs";

const n = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pf = (value) => value === Infinity ? "∞" : value === null ? "—" : n(value, 2);

export function formatCycle(result) {
  const report = result.report;
  const lines = [
    `V1.2 monitor 完成：${report.generatedAt}`,
    `当前 BTC：${n(report.currentPrice, 1)} USDT`,
    `系统判断：${report.decision}（置信度 ${report.confidencePct}%）`,
    `双向机会：做多 ${report.opportunities?.LONG?.score ?? "—"} / 做空 ${report.opportunities?.SHORT?.score ?? "—"}`,
    `是否现在入场：${report.entryAssessment?.enterNow ? "是" : "否"}；${report.entryAssessment?.methodLabel ?? "继续等待"}`,
    ...((report.entryAssessment?.reasons ?? []).slice(0, 5).map((item) => `- ${item}`))
  ];
  for (const action of result.actions) {
    if (action.type === "OPEN") {
      const p = action.position;
      lines.push(`模拟开仓：${p.side} #${p.id}，entry ${n(p.entry_price, 1)} / SL ${n(p.stop_loss, 1)} / TP ${n(p.take_profit, 1)} / 净 RR ${n(p.rr, 2)} / 风险 ${n(p.risk_cny)} CNY`);
    } else if (action.type === "CLOSE") {
      lines.push(`模拟平仓：${action.exit.exitReason}，净收益 ${n(action.position.net_pnl_cny)} CNY`);
    } else if (action.type === "FUNDING") {
      const impact = action.settlements.reduce((sum, item) => sum + item.cashflowCny, 0);
      lines.push(`Funding 模拟结算：${action.settlements.length} 次，影响 ${n(impact, 4)} CNY`);
    } else if (action.type === "NO_ENTRY") {
      lines.push(`未开仓：${action.reasons.join("；")}`);
    } else if (action.type === "LEGACY_SETUP_CANCELLED") {
      lines.push(`已停用旧版固定计划：#${action.setup.id}，以后每轮按当前行情重新判断。`);
    }
  }
  lines.push("安全：仅公开行情 + 本地模拟账本，交易所写操作保持关闭。");
  return lines.join("\n");
}

export function formatStatus(db) {
  const account = db.getAccount();
  const snapshot = db.getLatestSnapshot();
  const position = db.getOpenPosition();
  const legacySetup = db.getActiveSetup();
  const run = db.getLatestMonitorRun();
  const risk = getDailyRiskState(db, snapshot?.captured_at ?? new Date().toISOString());
  const report = snapshot?.report;
  const lines = [
    "BTC/USDT V1.2 Dynamic Paper Trading 状态",
    `模拟现金：${n(account.cash_cny)} CNY（初始 ${n(account.initial_capital_cny)}）`,
    `行情快照：${db.countSnapshots()} 次`,
    `最近监控：${run ? `${run.status} / ${run.finished_at} / ${run.message}` : "尚未运行"}`,
    `今日已实现损益：${n(risk.dailyPnlCny)} CNY；连亏 ${risk.consecutiveLosses} 笔；${risk.paused ? "暂停新交易" : "可评估新交易"}`
  ];
  if (snapshot) {
    lines.push(
      `最近判断：${snapshot.decision}，偏好 ${report?.strategy?.bias ?? snapshot.candidate_decision}，BTC ${n(snapshot.price, 1)} USDT`,
      `双向机会：做多 ${report?.opportunities?.LONG?.score ?? "—"} / 做空 ${report?.opportunities?.SHORT?.score ?? "—"}`,
      `是否现在入场：${report?.entryAssessment?.enterNow ? "是" : "否"}；${report?.entryAssessment?.methodLabel ?? "—"}`
    );
    if (!report?.entryAssessment?.enterNow && report?.entryAssessment?.missingConditions?.length) {
      lines.push(`目前缺少：${report.entryAssessment.missingConditions.join("；")}`);
    }
  }
  if (position) {
    const unrealized = calculateUnrealized(position, snapshot?.price);
    lines.push(`当前模拟仓位：#${position.id} ${position.side}，entry ${n(position.entry_price, 1)} / SL ${n(position.stop_loss, 1)} / TP ${n(position.take_profit, 1)} / 未实现 ${n(unrealized)} CNY`);
  } else lines.push("当前模拟仓位：无");
  lines.push(legacySetup
    ? `旧版固定计划：#${legacySetup.id} 尚在数据库，将在下一轮 monitor 自动取消。`
    : "固定待触发计划：已停用；每轮都按最新行情重新判断方向和入场方式。");
  lines.push("安全：没有 API Key、私有接口或真实下单能力。");
  return lines.join("\n");
}

export function formatReport(db) {
  const report = calculatePerformance(db);
  return [
    "BTC/USDT V1.2 Dynamic Paper Trading 绩效报告",
    `初始资金：${n(report.initialCapitalCny)} CNY`,
    `当前现金：${n(report.cashCny)} CNY`,
    `总交易次数：${report.totalTrades}`,
    `胜率：${n(report.winRatePct)}%（${report.wins} 胜 / ${report.losses} 负）`,
    `Profit Factor：${pf(report.profitFactor)}`,
    `Expectancy：${n(report.expectancyCny, 4)} CNY/笔`,
    `最大回撤：${n(report.maxDrawdownCny, 4)} CNY（${n(report.maxDrawdownPct, 4)}%）`,
    `累计收益：${n(report.cumulativePnlCny, 4)} CNY（${n(report.cumulativeReturnPct, 4)}%）`,
    `已计手续费：${n(report.feesCny, 4)} CNY`,
    `Funding 净影响：${n(report.fundingCny, 4)} CNY`,
    "",
    "固定模拟假设：",
    ...Object.values(PAPER_ASSUMPTIONS).map((item) => `- ${item}`),
    "",
    `Risk Gate：单笔风险 ≤ ${PAPER_CONFIG.maxRiskPerTradePct * 100}%，高风险降至 ${PAPER_CONFIG.reducedRiskPerTradePct * 100}%，日损失 ≤ ${PAPER_CONFIG.maxDailyLossPct * 100}%，连亏 ${PAPER_CONFIG.maxConsecutiveLosses} 笔暂停，净 RR ≥ ${PAPER_CONFIG.minimumRiskReward}。`,
    "安全：所有结果仅写入本地 SQLite；不会连接交易账户。"
  ].join("\n");
}
