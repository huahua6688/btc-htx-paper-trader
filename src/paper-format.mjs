import { calculatePerformance, calculateUnrealized, getDailyRiskState } from "./paper-engine.mjs";
import { PAPER_ASSUMPTIONS, PAPER_CONFIG } from "./config.mjs";

const n = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pf = (value) => value === Infinity ? "∞" : value === null ? "—" : n(value, 2);

export function formatCycle(result) {
  const lines = [
    `V1.1 monitor 完成：${result.report.generatedAt}`,
    `行情：BTC/USDT ${n(result.report.currentPrice, 1)} USDT`,
    `决策：${result.report.decision}（置信度 ${result.report.confidencePct}%）`,
    `策略状态：${result.report.strategy?.marketRegime ?? "—"} / ${result.report.strategy?.state ?? "—"} / 偏好 ${result.report.strategy?.bias ?? result.report.candidateDecision}`
  ];
  for (const action of result.actions) {
    if (action.type === "OPEN") {
      const p = action.position;
      lines.push(`模拟开仓：${p.side} #${p.id}，entry ${n(p.entry_price, 1)} / SL ${n(p.stop_loss, 1)} / TP ${n(p.take_profit, 1)} / RR ${n(p.rr, 2)}`);
    } else if (action.type === "CLOSE") {
      lines.push(`模拟平仓：${action.exit.exitReason}，净收益 ${n(action.position.net_pnl_cny)} CNY`);
    } else if (action.type === "FUNDING") {
      const impact = action.settlements.reduce((sum, item) => sum + item.cashflowCny, 0);
      lines.push(`Funding 模拟结算：${action.settlements.length} 次，影响 ${n(impact, 4)} CNY`);
    } else if (action.type === "NO_ENTRY") {
      lines.push(`未开仓：${action.reasons.join("；")}`);
    } else if (action.type === "SETUP_CREATED") {
      lines.push(`建立待触发计划：#${action.setup.id} ${action.setup.side} ${action.setup.setup_type}，状态 ${action.setup.status}`);
    } else if (action.type === "SETUP_ARMED") {
      lines.push(`计划已进入触发区：#${action.setup.id}，等待15分钟收盘确认`);
    } else if (action.type === "SETUP_WAITING") {
      lines.push(`计划等待中：#${action.setup.id} ${action.setup.side}，触发价 ${n(action.setup.plan.triggerPrice, 1)} / 失效价 ${n(action.setup.plan.invalidationPrice, 1)}`);
    } else if (["SETUP_EXPIRED", "SETUP_INVALIDATED", "SETUP_BLOCKED", "SETUP_CANCELLED"].includes(action.type)) {
      lines.push(`计划结束：#${action.setup.id} ${action.setup.status}，${action.setup.finish_reason}`);
    }
  }
  lines.push("安全：仅公开行情 + 本地模拟账本，交易所写操作保持关闭。");
  return lines.join("\n");
}

export function formatStatus(db) {
  const account = db.getAccount();
  const snapshot = db.getLatestSnapshot();
  const position = db.getOpenPosition();
  const setup = db.getActiveSetup();
  const run = db.getLatestMonitorRun();
  const risk = getDailyRiskState(db, snapshot?.captured_at ?? new Date().toISOString());
  const lines = [
    "BTC/USDT V1.1 Paper Trading 状态",
    `模拟现金：${n(account.cash_cny)} CNY（初始 ${n(account.initial_capital_cny)}）`,
    `行情快照：${db.countSnapshots()} 次`,
    `最近监控：${run ? `${run.status} / ${run.finished_at} / ${run.message}` : "尚未运行"}`,
    `今日已实现损益：${n(risk.dailyPnlCny)} CNY；连亏 ${risk.consecutiveLosses} 笔；${risk.paused ? "暂停新交易" : "可评估新交易"}`
  ];
  if (snapshot) {
    lines.push(`最近决策：${snapshot.decision}，方向偏好 ${snapshot.report?.strategy?.bias ?? snapshot.candidate_decision}，BTC ${n(snapshot.price, 1)} USDT，置信度 ${n(snapshot.confidence_pct, 0)}%`);
  }
  if (position) {
    const unrealized = calculateUnrealized(position, snapshot?.price);
    lines.push(`当前模拟仓位：#${position.id} ${position.side}，entry ${n(position.entry_price, 1)} / SL ${n(position.stop_loss, 1)} / TP ${n(position.take_profit, 1)} / 未实现 ${n(unrealized)} CNY`);
  } else lines.push("当前模拟仓位：无");
  if (setup) {
    lines.push(`待触发计划：#${setup.id} ${setup.side} ${setup.setup_type} / ${setup.status}`);
    lines.push(`观察区：${n(setup.plan.entryZone?.[0], 1)}–${n(setup.plan.entryZone?.[1], 1)} / 触发 ${n(setup.plan.triggerPrice, 1)} / 失效 ${n(setup.plan.invalidationPrice, 1)} / 到期 ${setup.expires_at}`);
    if (setup.warnings.length) lines.push(`降级提示：${setup.warnings.join("；")}`);
  } else lines.push("待触发计划：无");
  lines.push("安全：没有 API Key、私有接口或真实下单能力。");
  return lines.join("\n");
}

export function formatReport(db) {
  const report = calculatePerformance(db);
  return [
    "BTC/USDT V1.1 Paper Trading 绩效报告",
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
    `Risk Gate：单笔风险 ≤ ${PAPER_CONFIG.maxRiskPerTradePct * 100}%，日损失 ≤ ${PAPER_CONFIG.maxDailyLossPct * 100}%，连亏 ${PAPER_CONFIG.maxConsecutiveLosses} 笔暂停，净 RR ≥ ${PAPER_CONFIG.minimumRiskReward}。`,
    "安全：所有结果仅写入本地 SQLite；不会连接交易账户。"
  ].join("\n");
}
