const number = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const profitFactor = (value) => value === Infinity ? "∞" : value === null ? "—" : number(value, 2);

export function formatOpenTelegram(position) {
  const long = position.side === "LONG";
  return [
    `${long ? "🟢 模拟开多" : "🔴 模拟开空"} #${position.id}`,
    `时间：${position.opened_at}`,
    `Entry：${number(position.entry_price, 1)} USDT`,
    `Stop Loss：${number(position.stop_loss, 1)} USDT`,
    `Take Profit：${number(position.take_profit, 1)} USDT`,
    `净 RR：${number(position.rr, 2)}`,
    `数量：${number(position.quantity_btc, 8)} BTC`,
    `最大风险：${number(position.risk_cny)} CNY`,
    "开仓理由：",
    ...(position.openingReasons?.length ? position.openingReasons.slice(0, 5).map((item) => `- ${item}`) : ["- 无"]),
    "模式：Paper Trading；不会真实下单。"
  ].join("\n");
}

export function formatCloseTelegram(position) {
  const takeProfit = position.exit_reason === "TP";
  const fees = Number(position.entry_fee_cny) + Number(position.exit_fee_cny);
  return [
    `${takeProfit ? "✅ 模拟止盈" : "🛑 模拟止损"} #${position.id} ${position.side}`,
    `时间：${position.closed_at}`,
    `Entry / Exit：${number(position.entry_price, 1)} / ${number(position.exit_price, 1)} USDT`,
    `毛收益：${number(position.gross_pnl_cny)} CNY`,
    `手续费：-${number(fees)} CNY`,
    `Funding：${number(position.funding_cny, 4)} CNY`,
    `净收益：${number(position.net_pnl_cny)} CNY`,
    "模式：Paper Trading；不会真实下单。"
  ].join("\n");
}

export function formatRiskPauseTelegram(dailyRisk) {
  return [
    "⏸ 风控暂停新交易",
    `上海自然日：${dailyRisk.dayStart}`,
    `今日盈亏：${number(dailyRisk.dailyPnlCny)} CNY`,
    `每日最大损失：${number(dailyRisk.maxDailyLossCny)} CNY`,
    `连续亏损：${dailyRisk.consecutiveLosses} 笔`,
    "原因：",
    ...dailyRisk.pauseReasons.map((item) => `- ${item}`),
    "现有模拟仓位仍按原 SL/TP 管理；不会真实下单。"
  ].join("\n");
}

export function formatHealthTelegram(result, recovered = false) {
  if (recovered) {
    return [
      "✅ 程序恢复正常",
      `时间：${result.checkedAt}`,
      `最近 monitor：${result.monitor?.status ?? "UNKNOWN"}`,
      `快照数：${result.snapshot?.count ?? "—"}`,
      "Telegram 和健康检查不会改变 Paper Trading 逻辑。"
    ].join("\n");
  }
  return [
    "🚨 程序健康检查失败",
    `时间：${result.checkedAt}`,
    "原因：",
    ...result.failures.map((item) => `- ${item}`),
    `最近 monitor：${result.monitor?.status ?? "无记录"}`,
    "请检查 systemd、网络和 SQLite。"
  ].join("\n");
}

export function formatDailySummaryTelegram({ performance, dailyRisk, openPosition, generatedAt }) {
  return [
    "📊 BTC/USDT Paper Trading 每日汇总",
    `时间：${generatedAt}`,
    `当前模拟资金：${number(performance.cashCny)} CNY`,
    `今日盈亏：${number(dailyRisk.dailyPnlCny)} CNY`,
    `累计盈亏：${number(performance.cumulativePnlCny)} CNY（${number(performance.cumulativeReturnPct)}%）`,
    `总交易次数：${performance.totalTrades}`,
    `胜率：${number(performance.winRatePct)}%`,
    `Profit Factor：${profitFactor(performance.profitFactor)}`,
    `最大回撤：${number(performance.maxDrawdownCny)} CNY（${number(performance.maxDrawdownPct)}%）`,
    `当前持仓：${openPosition ? `有，#${openPosition.id} ${openPosition.side}` : "无"}`,
    "模式：Paper Trading；不会真实下单。"
  ].join("\n");
}
