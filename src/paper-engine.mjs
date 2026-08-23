import {
  PAPER_CONFIG,
  PAPER_EXCHANGE_CONSTRAINTS,
  RUNTIME_SETTINGS_DEFAULTS
} from "./config.mjs";
import {
  estimatePaperLiquidation,
  minimumMarginForStopBeforeLiquidation,
  resolveExchangeConstraints
} from "./exchange-constraints.mjs";
import { selectRiskPct } from "./runtime-settings.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function shanghaiDayStartIso(timestamp = new Date().toISOString()) {
  const utcMs = new Date(timestamp).getTime();
  if (!Number.isFinite(utcMs)) throw new Error("Invalid timestamp");
  const shanghai = new Date(utcMs + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate()
  ) - 8 * 60 * 60 * 1000).toISOString();
}

function candidateTargets(report) {
  const targets = report.plan?.takeProfit;
  return Array.isArray(targets) ? targets.map(Number).filter(Number.isFinite) : [];
}

function adverseFill(side, price, action, slippageRate) {
  const buy = (side === "LONG" && action === "ENTRY") || (side === "SHORT" && action === "EXIT");
  return price * (buy ? 1 + slippageRate : 1 - slippageRate);
}

function unitEconomics(side, signalEntry, stopLoss, takeProfit, fundingRate, config) {
  const direction = side === "LONG" ? 1 : -1;
  const entryFill = adverseFill(side, signalEntry, "ENTRY", config.slippageRate);
  const stopFill = adverseFill(side, stopLoss, "EXIT", config.slippageRate);
  const targetFill = adverseFill(side, takeProfit, "EXIT", config.slippageRate);
  const grossLoss = Math.max(0, -direction * (stopLoss - signalEntry)) * config.usdtCnyRate;
  const grossProfit = Math.max(0, direction * (takeProfit - signalEntry)) * config.usdtCnyRate;
  const entryFee = entryFill * config.feeRatePerSide * config.usdtCnyRate;
  const stopFee = stopFill * config.feeRatePerSide * config.usdtCnyRate;
  const targetFee = targetFill * config.feeRatePerSide * config.usdtCnyRate;
  const entrySlippage = Math.abs(entryFill - signalEntry) * config.usdtCnyRate;
  const stopSlippage = Math.abs(stopFill - stopLoss) * config.usdtCnyRate;
  const targetSlippage = Math.abs(targetFill - takeProfit) * config.usdtCnyRate;
  const funding = Math.abs(fundingRate) * signalEntry * config.usdtCnyRate;
  const expectedLoss = grossLoss + entryFee + stopFee + entrySlippage + stopSlippage + funding;
  const expectedProfit = grossProfit - entryFee - targetFee - entrySlippage - targetSlippage - funding;
  return {
    entryFill,
    stopFill,
    targetFill,
    expectedLoss,
    expectedProfit,
    netRr: expectedLoss > 0 ? expectedProfit / expectedLoss : null,
    entryFee,
    targetFee,
    targetSlippage,
    entrySlippage,
    funding
  };
}

function opportunityRiskFactor(report, side) {
  const score = Number(report.opportunities?.[side]?.score ?? 0);
  return clamp(0.7 + Math.max(0, score - 60) / 40 * 0.3, 0.7, 1);
}

function floorToContract(quantity, contractSize) {
  const contracts = Math.floor((quantity + 1e-12) / contractSize);
  return round(contracts * contractSize, 8);
}

export function calculateUnrealized(position, currentPrice, config = PAPER_CONFIG) {
  if (!position || !finite(currentPrice)) return null;
  const direction = position.side === "LONG" ? 1 : -1;
  const referenceEntry = Number(position.signal_entry_price ?? position.entry_price);
  return round(direction * (Number(currentPrice) - referenceEntry)
    * Number(position.quantity_btc) * config.usdtCnyRate, 4);
}

export function calculateAccountState(db, currentPrice = db.getLatestSnapshot()?.price, config = PAPER_CONFIG) {
  const account = db.getAccount();
  const positions = db.getOpenPositions();
  const unrealizedPnlCny = positions.reduce((sum, position) => sum + (calculateUnrealized(position, currentPrice, config) ?? 0), 0);
  const cashCny = Number(account.cash_cny);
  const equityCny = cashCny + unrealizedPnlCny;
  const marginUsedCny = positions.reduce((sum, position) => sum + Number(position.margin_cny ?? position.notional_cny), 0);
  const totalNotionalCny = positions.reduce((sum, position) => sum + Number(position.notional_cny), 0);
  const totalQuantityBtc = positions.reduce((sum, position) => sum + Number(position.quantity_btc), 0);
  const weightedEntry = totalQuantityBtc > 0
    ? positions.reduce((sum, position) => sum + Number(position.entry_price) * Number(position.quantity_btc), 0) / totalQuantityBtc
    : null;
  const weightedStop = totalQuantityBtc > 0
    ? positions.reduce((sum, position) => sum + Number(position.stop_loss) * Number(position.quantity_btc), 0) / totalQuantityBtc
    : null;
  const weightedTarget = totalQuantityBtc > 0
    ? positions.reduce((sum, position) => sum + Number(position.take_profit) * Number(position.quantity_btc), 0) / totalQuantityBtc
    : null;
  const totalRiskCny = positions.reduce((sum, position) => {
    if (!finite(currentPrice)) return sum + Number(position.expected_loss_cny ?? position.risk_cny);
    const direction = position.side === "LONG" ? 1 : -1;
    const priceRisk = Math.max(0, direction * (Number(currentPrice) - Number(position.stop_loss)))
      * Number(position.quantity_btc) * config.usdtCnyRate;
    const exitCost = Number(position.take_profit) * Number(position.quantity_btc)
      * config.usdtCnyRate * (config.feeRatePerSide + config.slippageRate);
    return sum + priceRisk + exitCost;
  }, 0);
  return {
    initialCapitalCny: Number(account.initial_capital_cny),
    cashCny: round(cashCny, 4),
    equityCny: round(equityCny, 4),
    availableFundsCny: round(Math.max(0, equityCny - marginUsedCny), 4),
    realizedPnlCny: round(cashCny - Number(account.initial_capital_cny), 4),
    unrealizedPnlCny: round(unrealizedPnlCny, 4),
    marginUsedCny: round(marginUsedCny, 4),
    totalNotionalCny: round(totalNotionalCny, 4),
    effectiveLeverage: marginUsedCny > 0 ? round(totalNotionalCny / marginUsedCny, 4) : 0,
    totalRiskCny: round(totalRiskCny, 4),
    totalRiskPct: equityCny > 0 ? round(totalRiskCny / equityCny, 6) : 0,
    totalQuantityBtc: round(totalQuantityBtc, 8),
    averageEntryPrice: finite(weightedEntry) ? round(weightedEntry, 2) : null,
    overallStopLoss: finite(weightedStop) ? round(weightedStop, 2) : null,
    overallTakeProfit: finite(weightedTarget) ? round(weightedTarget, 2) : null,
    positions
  };
}

export function buildPaperCandidate(
  report,
  accountOrState,
  runtimeSettings = RUNTIME_SETTINGS_DEFAULTS,
  exchangeConstraints = resolveExchangeConstraints({}, PAPER_EXCHANGE_CONSTRAINTS),
  openPositions = [],
  config = PAPER_CONFIG
) {
  const side = report.decision;
  if (!["LONG", "SHORT"].includes(side)) return null;
  if (!report.plan || !finite(report.currentPrice) || !finite(report.plan.stopLoss)) return null;
  const signalEntry = Number(report.currentPrice);
  const stopLoss = Number(report.plan.stopLoss);
  const stopIsValid = side === "LONG" ? stopLoss < signalEntry : stopLoss > signalEntry;
  if (!stopIsValid) return null;

  const accountEquityCny = Number(accountOrState.equityCny ?? accountOrState.cash_cny);
  if (!(accountEquityCny > 0)) return null;
  const existingMargin = openPositions.reduce((sum, item) => sum + Number(item.margin_cny ?? item.notional_cny), 0);
  const existingNotional = openPositions.reduce((sum, item) => sum + Number(item.notional_cny), 0);
  const existingRisk = openPositions.reduce((sum, item) => sum + Number(item.expected_loss_cny ?? item.risk_cny), 0);
  const availableRisk = Math.max(0, accountEquityCny * runtimeSettings.maxTotalRiskPct - existingRisk);
  const availableMargin = Math.max(0, accountEquityCny * runtimeSettings.maxMarginUsagePct - existingMargin);
  const availableNotional = Math.max(0, accountEquityCny * runtimeSettings.maxTotalNotionalMultiple - existingNotional);
  if (!(availableRisk > 0) || !(availableMargin > 0) || !(availableNotional > 0)) return null;

  const opportunityScore = Number(report.opportunities?.[side]?.score ?? 0);
  const volatilityPct = finite(report.timeframes?.["1h"]?.atr14)
    ? Number(report.timeframes["1h"].atr14) / signalEntry
    : Math.abs(signalEntry - stopLoss) / signalEntry;
  const marketRiskPct = finite(report.strategy?.riskPct) ? Number(report.strategy.riskPct) : config.maxRiskPerTradePct;
  const marketRiskFactor = config.maxRiskPerTradePct > 0
    ? clamp(marketRiskPct / config.maxRiskPerTradePct, 0.5, 1)
    : 1;
  const requestedRiskPct = selectRiskPct(runtimeSettings, {
    opportunityScore,
    volatilityPct,
    marketRiskFactor
  }) * opportunityRiskFactor(report, side);
  const riskPct = clamp(requestedRiskPct, runtimeSettings.riskMinPct, config.absoluteMaxRiskPerTradePct);
  const riskBudgetCny = Math.min(accountEquityCny * riskPct, availableRisk);
  if (!(riskBudgetCny > 0)) return null;

  const fundingRate = finite(report.derivatives?.fundingRatePct) ? Number(report.derivatives.fundingRatePct) / 100 : 0;
  const viableTargets = candidateTargets(report).map((takeProfit) => ({
    takeProfit,
    economics: unitEconomics(side, signalEntry, stopLoss, takeProfit, fundingRate, config)
  })).filter(({ takeProfit, economics }) => {
    const validDirection = side === "LONG" ? takeProfit > signalEntry : takeProfit < signalEntry;
    return validDirection && finite(economics.netRr) && economics.netRr >= config.minimumRiskReward;
  });
  if (!viableTargets.length) return null;
  const selected = opportunityScore >= 80 ? viableTargets.at(-1) : viableTargets[0];
  const perBtc = selected.economics;
  const quantityByRisk = riskBudgetCny / perBtc.expectedLoss;

  const configuredLeverageMaximum = runtimeSettings.leverageMode === "MANUAL"
    ? runtimeSettings.leverageManual
    : runtimeSettings.leverageMax;
  const hardMaxLeverage = Math.min(configuredLeverageMaximum, exchangeConstraints.hardMaxLeverage);
  const hardMinLeverage = Math.max(1, Math.min(runtimeSettings.leverageMin, hardMaxLeverage));
  const unitSafeMargin = minimumMarginForStopBeforeLiquidation({
    side,
    entry: perBtc.entryFill,
    stopLoss,
    quantityBtc: 1,
    usdtCnyRate: config.usdtCnyRate,
    maintenanceMarginRate: exchangeConstraints.maintenanceMarginRate,
    safetyBufferPct: PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
  });
  const unitNotional = perBtc.entryFill * config.usdtCnyRate;
  const liquidationSafeMaxLeverage = unitSafeMargin > 0 ? unitNotional / unitSafeMargin : hardMaxLeverage;
  const leverageCap = Math.max(1, Math.min(hardMaxLeverage, liquidationSafeMaxLeverage));
  const quantityByNotional = Math.min(availableNotional, availableMargin * leverageCap) / unitNotional;
  const contractSize = Number(exchangeConstraints.contractSizeBtc);
  const quantityBtc = floorToContract(Math.min(quantityByRisk, quantityByNotional), contractSize);
  if (!(quantityBtc >= contractSize)) return null;

  const notionalCny = quantityBtc * perBtc.entryFill * config.usdtCnyRate;
  const requiredLeverage = notionalCny / availableMargin;
  const desiredLeverage = runtimeSettings.leverageMode === "MANUAL"
    ? Number(runtimeSettings.leverageManual)
    : Math.max(hardMinLeverage, requiredLeverage);
  const leverage = round(clamp(desiredLeverage, hardMinLeverage, leverageCap), 2);
  const marginCny = notionalCny / leverage;
  if (marginCny > availableMargin + 0.01) return null;

  const expectedLossCny = perBtc.expectedLoss * quantityBtc;
  const expectedProfitCny = perBtc.expectedProfit * quantityBtc;
  const netRr = expectedLossCny > 0 ? expectedProfitCny / expectedLossCny : null;
  if (!(netRr >= config.minimumRiskReward) || expectedLossCny > riskBudgetCny + 0.01) return null;
  const liquidation = estimatePaperLiquidation({
    side,
    entry: perBtc.entryFill,
    quantityBtc,
    marginCny,
    usdtCnyRate: config.usdtCnyRate,
    maintenanceMarginRate: exchangeConstraints.maintenanceMarginRate
  });
  if (!liquidation) return null;
  const stopBeforeLiquidation = side === "LONG"
    ? stopLoss > liquidation.price + signalEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
    : stopLoss < liquidation.price - signalEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct;
  if (!stopBeforeLiquidation) return null;

  const existingQuantity = openPositions.reduce((sum, item) => sum + Number(item.quantity_btc), 0);
  const totalQuantity = existingQuantity + quantityBtc;
  const averageEntry = totalQuantity > 0
    ? (openPositions.reduce((sum, item) => sum + Number(item.entry_price) * Number(item.quantity_btc), 0)
      + perBtc.entryFill * quantityBtc) / totalQuantity
    : perBtc.entryFill;
  const totalRiskCny = existingRisk + expectedLossCny;
  const totalMarginCny = existingMargin + marginCny;
  const totalNotionalCny = existingNotional + notionalCny;
  const weightedStop = totalQuantity > 0
    ? (openPositions.reduce((sum, item) => sum + Number(item.stop_loss) * Number(item.quantity_btc), 0)
      + stopLoss * quantityBtc) / totalQuantity
    : stopLoss;
  const weightedTarget = totalQuantity > 0
    ? (openPositions.reduce((sum, item) => sum + Number(item.take_profit) * Number(item.quantity_btc), 0)
      + selected.takeProfit * quantityBtc) / totalQuantity
    : selected.takeProfit;
  const portfolioLiquidation = estimatePaperLiquidation({
    side,
    entry: averageEntry,
    quantityBtc: totalQuantity,
    marginCny: totalMarginCny,
    usdtCnyRate: config.usdtCnyRate,
    maintenanceMarginRate: exchangeConstraints.maintenanceMarginRate
  });
  if (!portfolioLiquidation) return null;
  const portfolioStopBeforeLiquidation = side === "LONG"
    ? weightedStop > portfolioLiquidation.price + averageEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
    : weightedStop < portfolioLiquidation.price - averageEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct;
  if (!portfolioStopBeforeLiquidation) return null;
  const portfolioAfter = {
    positionCount: openPositions.length + 1,
    totalQuantityBtc: round(totalQuantity, 8),
    averageEntryPrice: round(averageEntry, 2),
    overallStopLoss: round(weightedStop, 2),
    overallTakeProfit: round(weightedTarget, 2),
    totalRiskCny: round(totalRiskCny, 4),
    totalRiskPct: round(totalRiskCny / accountEquityCny, 6),
    totalMarginCny: round(totalMarginCny, 4),
    totalMarginPct: round(totalMarginCny / accountEquityCny, 6),
    totalNotionalCny: round(totalNotionalCny, 4),
    effectiveLeverage: round(totalNotionalCny / totalMarginCny, 4),
    liquidationPriceEstimate: portfolioLiquidation.price,
    liquidationDistancePct: portfolioLiquidation.distancePct,
    liquidationSource: portfolioLiquidation.source
  };
  const directionReasons = (side === "LONG" ? report.bullishReasons : report.bearishReasons) ?? [];
  return {
    symbol: report.symbol,
    side,
    openedAt: report.generatedAt,
    entryBarTs: Number(report.latest15mBar?.timestamp ?? new Date(report.generatedAt).getTime()),
    signalEntryPrice: round(signalEntry, 2),
    entry: round(perBtc.entryFill, 2),
    stopLoss: round(stopLoss, 2),
    takeProfit: round(selected.takeProfit, 2),
    stopDistancePct: round(Math.abs(perBtc.entryFill - stopLoss) / perBtc.entryFill * 100, 4),
    takeProfitDistancePct: round(Math.abs(selected.takeProfit - perBtc.entryFill) / perBtc.entryFill * 100, 4),
    rr: round(netRr, 4),
    netRr: round(netRr, 4),
    quantityBtc,
    accountEquityCny: round(accountEquityCny, 4),
    leverage,
    marginCny: round(marginCny, 4),
    marginUsagePct: round(marginCny / accountEquityCny, 6),
    notionalCny: round(notionalCny, 4),
    expectedLossCny: round(expectedLossCny, 4),
    expectedProfitCny: round(expectedProfitCny, 4),
    riskCny: round(expectedLossCny, 4),
    riskPct: round(expectedLossCny / accountEquityCny, 6),
    riskBudgetCny: round(riskBudgetCny, 4),
    entryFeeCny: round(perBtc.entryFee * quantityBtc, 4),
    feeEstimateCny: round((perBtc.entryFee + perBtc.targetFee) * quantityBtc, 4),
    fundingEstimateCny: round(perBtc.funding * quantityBtc, 4),
    entrySlippageCny: round(perBtc.entrySlippage * quantityBtc, 4),
    slippageEstimateCny: round((perBtc.entrySlippage + perBtc.targetSlippage) * quantityBtc, 4),
    liquidationPriceEstimate: portfolioLiquidation.price,
    liquidationDistancePct: portfolioLiquidation.distancePct,
    liquidationSource: portfolioLiquidation.source,
    opportunityScore,
    exchangeConstraints,
    portfolioAfter,
    isAddOn: openPositions.length > 0,
    openingReasons: [
      ...(report.entryAssessment?.methodLabel ? [`动态入场：${report.entryAssessment.methodLabel}`] : []),
      ...directionReasons.slice(0, 4),
      `仓位按权益、${round(expectedLossCny / accountEquityCny * 100, 2)}%净风险、止损距离和保证金上限计算`,
      `实际 ${leverage}x 仅用于分配 ${round(marginCny, 2)} CNY 保证金，不增加允许亏损`
    ].slice(0, 6)
  };
}

export function getDailyRiskState(db, at = new Date().toISOString(), runtimeSettings = db.getRuntimeSettings?.() ?? RUNTIME_SETTINGS_DEFAULTS) {
  const dayStart = shanghaiDayStartIso(at);
  const events = db.getAccountEvents({ since: dayStart });
  const dailyPnlCny = events.reduce((sum, event) => sum + Number(event.amount_cny), 0);
  const cashCny = Number(db.getAccount().cash_cny);
  const dayStartBalanceCny = cashCny - dailyPnlCny;
  const dailyLossCny = Math.max(0, -dailyPnlCny);
  const maxDailyLossCny = dayStartBalanceCny * runtimeSettings.maxDailyLossPct;
  const closed = db.getClosedPositions({ since: dayStart });
  let consecutiveLosses = 0;
  for (let index = closed.length - 1; index >= 0; index -= 1) {
    if (Number(closed[index].net_pnl_cny) < 0) consecutiveLosses += 1;
    else break;
  }
  const lossLimitReached = dailyLossCny >= maxDailyLossCny;
  const streakLimitReached = consecutiveLosses >= runtimeSettings.maxConsecutiveLosses;
  return {
    dayStart,
    dayStartBalanceCny: round(dayStartBalanceCny, 4),
    dailyPnlCny: round(dailyPnlCny, 4),
    dailyLossCny: round(dailyLossCny, 4),
    maxDailyLossCny: round(maxDailyLossCny, 4),
    consecutiveLosses,
    manualPause: runtimeSettings.newEntriesPaused,
    paused: runtimeSettings.newEntriesPaused || lossLimitReached || streakLimitReached,
    pauseReasons: [
      ...(runtimeSettings.newEntriesPaused ? ["管理员已暂停新开仓"] : []),
      ...(lossLimitReached ? [`当日损失已达到 ${runtimeSettings.maxDailyLossPct * 100}% 上限`] : []),
      ...(streakLimitReached ? [`当日已连续亏损 ${consecutiveLosses} 笔`] : [])
    ]
  };
}

function aggregateOpenPosition(openPositions) {
  const quantity = openPositions.reduce((sum, item) => sum + Number(item.quantity_btc), 0);
  return {
    quantity,
    averageEntry: quantity > 0
      ? openPositions.reduce((sum, item) => sum + Number(item.entry_price) * Number(item.quantity_btc), 0) / quantity
      : null,
    averageInitialRiskDistance: quantity > 0
      ? openPositions.reduce((sum, item) => sum + Math.abs(Number(item.entry_price) - Number(item.initial_stop_loss ?? item.stop_loss)) * Number(item.quantity_btc), 0) / quantity
      : null
  };
}

export function evaluatePaperEntry(db, report, config = PAPER_CONFIG, marketData = {}) {
  const reasons = [];
  const settings = db.getRuntimeSettings();
  const openPositions = db.getOpenPositions();
  if (!["LONG", "SHORT"].includes(report.decision)) reasons.push("当前决策不是 LONG/SHORT");
  if (report.riskGates?.length) reasons.push(...report.riskGates);
  const dailyRisk = getDailyRiskState(db, report.generatedAt, settings);
  if (dailyRisk.paused) reasons.push(...dailyRisk.pauseReasons);
  if (openPositions.length) {
    if (!settings.allowPyramiding) reasons.push("已有 BTC 模拟仓位，加仓已关闭");
    if (openPositions.length >= settings.maxOpenPositions) reasons.push("已达到最大同时仓位数");
    if (openPositions.some((position) => position.side !== report.decision)) reasons.push("已有相反方向仓位，本轮禁止机械反手");
    const aggregate = aggregateOpenPosition(openPositions);
    const favorable = report.decision === "LONG"
      ? report.currentPrice > aggregate.averageEntry + aggregate.averageInitialRiskDistance * 0.5
      : report.currentPrice < aggregate.averageEntry - aggregate.averageInitialRiskDistance * 0.5;
    const score = Number(report.opportunities?.[report.decision]?.score ?? 0);
    if (!favorable) reasons.push("已有仓位尚未获得足够有利进展，禁止加仓");
    if (score < config.minimumImmediateEntryScore + 5) reasons.push("新机会质量不足以支持受控加仓");
    const newestBar = Math.max(...openPositions.map((item) => Number(item.entry_bar_ts)));
    if (Number(report.latest15mBar?.timestamp) <= newestBar) reasons.push("同一行情周期禁止重复加仓");
  }
  let candidate = null;
  if (!reasons.length) {
    const accountState = calculateAccountState(db, report.currentPrice, config);
    const constraints = resolveExchangeConstraints(marketData);
    candidate = buildPaperCandidate(report, accountState, settings, constraints, openPositions, config);
    if (!candidate) reasons.push("没有满足净 RR、合约步进、总风险、保证金、名义仓位与强平缓冲的有效仓位");
  }
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    dailyRisk,
    settings,
    candidate
  };
}

export function evaluatePaperExit(position, report, config = PAPER_CONFIG, {
  checkStop = true,
  checkTarget = true,
  forcedReason = null,
  managementReason = null
} = {}) {
  if (!finite(report.currentPrice)) return null;
  const bar = report.latest15mBar;
  const canUseBar = finite(bar?.timestamp) && Number(bar.timestamp) > Number(position.entry_bar_ts);
  const currentPrice = Number(report.currentPrice);
  const liquidation = Number(position.liquidation_price_estimate);
  const hasLiquidation = finite(position.liquidation_price_estimate);
  let exitReason = forcedReason;
  let triggerPrice = currentPrice;
  const barHitStop = canUseBar && (position.side === "LONG"
    ? Number(bar.low) <= Number(position.stop_loss)
    : Number(bar.high) >= Number(position.stop_loss));
  const barHitTarget = canUseBar && (position.side === "LONG"
    ? Number(bar.high) >= Number(position.take_profit)
    : Number(bar.low) <= Number(position.take_profit));

  if (!exitReason && hasLiquidation) {
    const gappedThrough = position.side === "LONG"
      ? currentPrice <= liquidation || (canUseBar && finite(bar.open) && Number(bar.open) <= liquidation)
      : currentPrice >= liquidation || (canUseBar && finite(bar.open) && Number(bar.open) >= liquidation);
    if (gappedThrough) {
      exitReason = "LIQUIDATION";
      triggerPrice = liquidation;
    }
  }
  if (!exitReason && checkStop) {
    const hitStop = position.side === "LONG"
      ? (canUseBar ? Number(bar.low) <= Number(position.stop_loss) : currentPrice <= Number(position.stop_loss))
      : (canUseBar ? Number(bar.high) >= Number(position.stop_loss) : currentPrice >= Number(position.stop_loss));
    if (hitStop) {
      exitReason = "SL";
      triggerPrice = Number(position.stop_loss);
    }
  }
  if (!exitReason && checkTarget) {
    const hitTarget = position.side === "LONG"
      ? (canUseBar ? Number(bar.high) >= Number(position.take_profit) : currentPrice >= Number(position.take_profit))
      : (canUseBar ? Number(bar.low) <= Number(position.take_profit) : currentPrice <= Number(position.take_profit));
    if (hitTarget) {
      exitReason = "TP";
      triggerPrice = Number(position.take_profit);
    }
  }
  if (!exitReason) return null;
  const exitPrice = adverseFill(position.side, triggerPrice, "EXIT", config.slippageRate);
  const direction = position.side === "LONG" ? 1 : -1;
  const signalEntry = Number(position.signal_entry_price ?? position.entry_price);
  const grossPnlCny = direction * (triggerPrice - signalEntry) * Number(position.quantity_btc) * config.usdtCnyRate;
  const exitFeeCny = exitPrice * Number(position.quantity_btc) * config.usdtCnyRate * config.feeRatePerSide;
  const exitSlippageCny = Math.abs(exitPrice - triggerPrice) * Number(position.quantity_btc) * config.usdtCnyRate;
  return {
    closedAt: report.generatedAt,
    exitPrice: round(exitPrice, 2),
    exitTriggerPrice: round(triggerPrice, 2),
    exitReason,
    grossPnlCny: round(grossPnlCny, 4),
    exitFeeCny: round(exitFeeCny, 4),
    exitSlippageCny: round(exitSlippageCny, 4),
    managementReason,
    conservativeSameBar: Boolean(checkStop && checkTarget && barHitStop && barHitTarget)
  };
}

export function fundingBoundaries(lastFundingAt, now) {
  const start = new Date(lastFundingAt).getTime();
  const end = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const boundaries = [];
  let boundary = Math.floor(start / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS + FUNDING_INTERVAL_MS;
  while (boundary <= end) {
    boundaries.push(new Date(boundary).toISOString());
    boundary += FUNDING_INTERVAL_MS;
  }
  return boundaries;
}

export function applyDueFunding(db, position, report) {
  if (!finite(report.derivatives?.fundingRatePct)) {
    return { position, settlements: [], skipped: "Funding 数据不可用，本轮不模拟结算" };
  }
  const rate = Number(report.derivatives.fundingRatePct) / 100;
  const settlements = [];
  let current = position;
  const boundaries = fundingBoundaries(position.last_funding_at, report.generatedAt);
  const reportMs = new Date(report.generatedAt).getTime();
  const eligible = boundaries.filter((item) => reportMs - new Date(item).getTime() <= 15 * 60 * 1000);
  const missed = boundaries.filter((item) => !eligible.includes(item));
  if (missed.length) current = db.recordFundingGap(current.id, missed, missed.at(-1));
  for (const settledAt of eligible) {
    const payerSign = current.side === "LONG" ? -1 : 1;
    const cashflowCny = round(Number(current.notional_cny) * rate * payerSign, 4);
    current = db.applyFunding(current.id, cashflowCny, settledAt, {
      fundingRate: rate,
      side: current.side,
      source: report.derivatives?.fundingSource ?? "HTX_CURRENT_PUBLIC_RATE_SIMULATION"
    });
    settlements.push({ settledAt, rate, cashflowCny });
  }
  return {
    position: current,
    settlements,
    skipped: missed.length ? `跳过 ${missed.length} 个历史 Funding 结算点：没有对应时点费率，禁止用当前值回填` : null
  };
}

export function calculatePerformance(db) {
  const account = db.getAccount();
  const trades = db.getClosedPositions();
  const events = db.getAccountEvents();
  const netResults = trades.map((trade) => Number(trade.net_pnl_cny));
  const wins = netResults.filter((value) => value > 0);
  const losses = netResults.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const initialCapital = Number(account.initial_capital_cny);
  let peak = initialCapital;
  let maxDrawdownCny = 0;
  let maxDrawdownPct = 0;
  for (const event of events) {
    const balance = Number(event.balance_after_cny);
    peak = Math.max(peak, balance);
    const drawdown = peak - balance;
    if (drawdown > maxDrawdownCny) {
      maxDrawdownCny = drawdown;
      maxDrawdownPct = peak > 0 ? drawdown / peak * 100 : 0;
    }
  }
  const cashCny = Number(account.cash_cny);
  const cumulativePnlCny = cashCny - initialCapital;
  const leverageValues = trades.map((item) => Number(item.leverage)).filter(Number.isFinite);
  const marginValues = trades.map((item) => Number(item.margin_usage_pct)).filter(Number.isFinite);
  const rrValues = trades.map((item) => Number(item.net_rr ?? item.rr)).filter(Number.isFinite);
  const feesCny = trades.reduce((sum, item) => sum + Number(item.entry_fee_cny ?? 0) + Number(item.exit_fee_cny ?? 0), 0);
  const slippageCny = trades.reduce((sum, item) => sum + Number(item.entry_slippage_cny ?? 0) + Number(item.exit_slippage_cny ?? 0), 0);
  const fundingCny = trades.reduce((sum, item) => sum + Number(item.funding_cny ?? 0), 0);
  return {
    initialCapitalCny: round(initialCapital, 2),
    cashCny: round(cashCny, 2),
    totalTrades: trades.length,
    longTrades: trades.filter((item) => item.side === "LONG").length,
    shortTrades: trades.filter((item) => item.side === "SHORT").length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? round(wins.length / trades.length * 100, 2) : 0,
    averageProfitCny: wins.length ? round(grossProfit / wins.length, 4) : 0,
    averageLossCny: losses.length ? round(-grossLoss / losses.length, 4) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : (grossProfit > 0 ? Infinity : null),
    expectancyCny: trades.length ? round(netResults.reduce((sum, value) => sum + value, 0) / trades.length, 4) : 0,
    maxDrawdownCny: round(maxDrawdownCny, 4),
    maxDrawdownPct: round(maxDrawdownPct, 4),
    averageRr: rrValues.length ? round(rrValues.reduce((sum, value) => sum + value, 0) / rrValues.length, 4) : null,
    averageLeverage: leverageValues.length ? round(leverageValues.reduce((sum, value) => sum + value, 0) / leverageValues.length, 4) : null,
    maxLeverage: leverageValues.length ? round(Math.max(...leverageValues), 4) : null,
    averageMarginUsagePct: marginValues.length ? round(marginValues.reduce((sum, value) => sum + value, 0) / marginValues.length * 100, 4) : null,
    grossPnlCny: round(trades.reduce((sum, item) => sum + Number(item.gross_pnl_cny ?? 0), 0), 4),
    feesCny: round(feesCny, 4),
    slippageCny: round(slippageCny, 4),
    fundingCny: round(fundingCny, 4),
    totalCostsCny: round(feesCny + slippageCny - fundingCny, 4),
    cumulativePnlCny: round(cumulativePnlCny, 4),
    cumulativeReturnPct: round(cumulativePnlCny / initialCapital * 100, 4)
  };
}

export const PAPER_TIME = Object.freeze({ DAY_MS, FUNDING_INTERVAL_MS });
