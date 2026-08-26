const number = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const profitFactor = (value) => value === Infinity ? "∞" : value === null ? "—" : number(value, 2);
const pct = (value, digits = 2) => value === null || value === undefined ? "—" : `${number(Number(value) * 100, digits)}%`;

// 与 telegram-notifier 的 shanghaiClock 用同一个偏移，避免同一条消息里
// 出现两种时区读数。返回 UTC+8 的「月-日 时:分」。
function timeText(timestamp) {
  const local = new Date(new Date(timestamp).getTime() + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(local.getTime())) return "—";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} `
    + `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

function durationText(openedAt, closedAt) {
  const milliseconds = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function classifyCloseTelegram(position) {
  if (["TP", "EARLY_PROFIT"].includes(position.exit_reason)) return "PROFIT";
  if (position.exit_reason !== "SL") return "RISK_CONTROL";

  const entry = Number(position.entry_price);
  const stop = Number(position.stop_loss);
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return "RISK_STOP";
  const configuredTick = Number(position.price_tick ?? position.price_tick_size);
  const tick = Number.isFinite(configuredTick) && configuredTick > 0 ? configuredTick : 0.1;
  const tolerance = Math.max(tick, Math.abs(entry) * 1e-8, Number.EPSILON * Math.abs(entry) * 8);
  const distance = stop - entry;
  if (Math.abs(distance) <= tolerance) return "BREAKEVEN_STOP";
  const protectsProfit = position.side === "LONG" ? distance > tolerance : distance < -tolerance;
  return protectsProfit ? "PROFIT_PROTECT_STOP" : "RISK_STOP";
}

function closeReason(position, exit, classification) {
  if (classification === "PROFIT_PROTECT_STOP") return "价格触及盈利保护止损";
  if (classification === "BREAKEVEN_STOP") return "价格触及保本止损";
  if (classification === "RISK_STOP") return "价格触及风险止损";
  if (exit?.managementReason) return exit.managementReason;
  const labels = {
    TP: "价格触及模拟止盈",
    LIQUIDATION: "价格触及 Paper 估算强平区域",
    EARLY_PROFIT: "市场结构明显变化，提前保护利润",
    SIGNAL_INVALIDATED: "原开仓逻辑连续确认失效，提前控制亏损"
  };
  return labels[position.exit_reason] ?? position.exit_reason ?? "模拟仓位结束";
}

export function formatOpenTelegram(position) {
  const long = position.side === "LONG";
  const portfolio = position.portfolioAfter ?? {};
  const costs = Number(position.fee_estimate_cny ?? 0)
    + Number(position.funding_estimate_cny ?? 0)
    + Number(position.slippage_estimate_cny ?? 0);
  return [
    // 编号必须出现在开仓消息里：平仓消息用 #id 指认是哪一笔，
    // 如果开仓时从未印出编号，收到平仓通知时就只能回去翻数据库。
    `${long ? "🟢 模拟开多" : "🔴 模拟开空"} #${position.id}`,
    `BTC 当前价格：${number(position.signal_entry_price ?? position.entry_price, 1)} USDT`,
    `方向：${long ? "做多" : "做空"}；机会评分 ${number(position.opportunity_score, 1)}`,
    `账户权益：${number(position.account_equity_cny)} CNY`,
    `本次保证金：${number(position.margin_cny)} CNY（账户 ${pct(position.margin_usage_pct)}）`,
    `本次实际杠杆：${number(position.leverage, 2)}x`,
    `名义仓位：${number(position.notional_cny)} CNY`,
    `BTC 数量：${number(position.quantity_btc, 8)}`,
    `模拟入场：${number(position.entry_price, 1)} USDT`,
    `止损：${number(position.stop_loss, 1)} USDT（${number(position.stop_distance_pct, 2)}%）`,
    `止盈：${number(position.take_profit, 1)} USDT（${number(position.take_profit_distance_pct, 2)}%）`,
    `净 RR：1 : ${number(position.net_rr ?? position.rr, 2)}`,
    `预计止损亏损：${number(position.expected_loss_cny ?? position.risk_cny)} CNY（账户 ${pct(position.risk_pct)}）`,
    `预计止盈盈利：${number(position.expected_profit_cny)} CNY`,
    `预计手续费 / Funding / 滑点：${number(position.fee_estimate_cny)} / ${number(position.funding_estimate_cny, 4)} / ${number(position.slippage_estimate_cny, 4)} CNY`,
    `预计总成本：${number(costs, 4)} CNY`,
    `当前组合总风险：${number(portfolio.totalRiskCny ?? position.expected_loss_cny)} CNY（${pct(portfolio.totalRiskPct ?? position.risk_pct)}）`,
    `Paper 估算强平：${number(position.liquidation_price_estimate, 1)} USDT（距离 ${number(position.liquidation_distance_pct, 2)}%，非 HTX 实际强平价）`,
    "开仓原因：",
    ...(position.openingReasons?.length ? position.openingReasons.slice(0, 5).map((item) => `- ${item}`) : ["- 无"]),
    "仅为 Paper Trading；不会真实下单。"
  ].join("\n");
}

export function formatCloseTelegram(position, exit = null) {
  const classification = classifyCloseTelegram(position);
  const heading = {
    PROFIT: "✅ 模拟平仓（盈利）",
    PROFIT_PROTECT_STOP: "🟢 模拟平仓（盈利保护）",
    BREAKEVEN_STOP: "🟡 模拟平仓（保本保护）",
    RISK_STOP: "🛑 模拟平仓（风险止损）",
    RISK_CONTROL: "🛑 模拟平仓（风险控制）"
  }[classification];
  const fees = Number(position.entry_fee_cny) + Number(position.exit_fee_cny);
  const slippage = Number(position.entry_slippage_cny ?? 0) + Number(position.exit_slippage_cny ?? 0);
  const returnPct = Number(position.account_equity_cny) > 0
    ? Number(position.net_pnl_cny) / Number(position.account_equity_cny)
    : null;
  return [
    `${heading} #${position.id}`,
    // 光有 #id 还不够对上号：把开仓消息里那几个一眼能认出来的字段一起带上，
    // 这样即使翻不到原始开仓消息，也能直接认出平掉的是哪一笔。
    `对应开仓：${position.side === "LONG" ? "🟢 开多" : "🔴 开空"} #${position.id}`
      + `　${number(position.quantity_btc, 8)} BTC　${number(position.leverage, 2)}x`,
    `开仓时间：${timeText(position.opened_at)}`,
    `平仓原因：${closeReason(position, exit, classification)}`,
    ...(classification === "PROFIT_PROTECT_STOP" ? [`保护止损：${number(position.stop_loss, 1)} USDT`] : []),
    `入场价：${number(position.entry_price, 1)} USDT`,
    `平仓价：${number(position.exit_price, 1)} USDT`,
    `持仓时间：${durationText(position.opened_at, position.closed_at)}`,
    `毛收益：${number(position.gross_pnl_cny)} CNY`,
    `手续费：-${number(fees)} CNY`,
    `滑点成本：-${number(slippage, 4)} CNY`,
    `Funding：${number(position.funding_cny, 4)} CNY`,
    `净收益：${number(position.net_pnl_cny)} CNY`,
    `本次账户收益率：${returnPct === null ? "—" : pct(returnPct)}`,
    "仅为 Paper Trading；不会真实下单。"
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
    "现有模拟仓位仍由动态仓位管理继续控制；不会真实下单。"
  ].join("\n");
}

export function formatHealthTelegram(result, recovered = false) {
  if (recovered) {
    return [
      "✅ 程序恢复正常",
      `时间：${result.checkedAt}`,
      `最近 monitor：${result.monitor?.status ?? "UNKNOWN"}`,
      `快照数：${result.snapshot?.count ?? "—"}`,
      "Telegram 和健康检查不会改变市场方向逻辑。"
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

export function formatDailySummaryTelegram({ performance, dailyRisk, openPosition, generatedAt, accountState = null }) {
  return [
    "📊 BTC/USDT Paper Trading 每日汇总",
    `时间：${generatedAt}`,
    `当前模拟资金/权益：${number(accountState?.equityCny ?? performance.cashCny)} CNY`,
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
