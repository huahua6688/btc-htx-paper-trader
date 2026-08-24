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
import { applyDynamicLimits, selectRiskPct } from "./runtime-settings.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

// 杠杆按 0.01 步进存储和展示。计算保证金时必须使用“满足约束的最小可表示杠杆”，
// 也就是向上取整；向下四舍五入会让 notional/leverage 略高于可用保证金，
// 从而把本来完全合法的仓位误判成违规并静默丢弃。
const LEVERAGE_STEP = 0.01;
const LEVERAGE_EPSILON = 1e-9;
const ceilToLeverageStep = (value) => Math.ceil(value / LEVERAGE_STEP - LEVERAGE_EPSILON) * LEVERAGE_STEP;
const floorToLeverageStep = (value) => Math.floor(value / LEVERAGE_STEP + LEVERAGE_EPSILON) * LEVERAGE_STEP;
const normalizeLeverage = (value) => Number(value.toFixed(2));

/**
 * 仓位计算的拒绝原因码。每一种拒绝都必须能被 monitor、Telegram 和研究回放分别统计，
 * 不允许再把「合约步进不够」「保证金上限」「净 RR 不足」混成同一句话。
 */
export const SIZING_REJECTION_CODES = Object.freeze({
  DECISION_NOT_DIRECTIONAL: "当前决策不是 LONG/SHORT",
  PLAN_INCOMPLETE: "缺少可用的价格或止损计划",
  STOP_ON_WRONG_SIDE: "止损方向与开仓方向不一致",
  EQUITY_NOT_POSITIVE: "账户权益不为正",
  PORTFOLIO_RISK_BUDGET_EXHAUSTED: "组合总风险预算已用尽",
  PORTFOLIO_MARGIN_BUDGET_EXHAUSTED: "组合保证金预算已用尽",
  PORTFOLIO_NOTIONAL_BUDGET_EXHAUSTED: "组合名义仓位预算已用尽",
  RISK_BUDGET_ZERO: "本轮单笔风险预算为 0",
  NO_TARGET_MEETS_NET_RR: "没有止盈目标能达到成本后净 RR 门槛",
  BELOW_MIN_CONTRACT_STEP: "按风险/保证金算出的数量不足一个最小合约步进",
  LEVERAGE_CAP_BINDING: "达到杠杆上限后仍无法构造合法仓位",
  MARGIN_CAP_BINDING: "达到保证金上限后仍无法构造合法仓位",
  NET_RR_BELOW_MINIMUM: "合约步进取整后净 RR 低于门槛",
  RISK_BUDGET_EXCEEDED: "合约步进取整后预计亏损超过风险预算",
  LIQUIDATION_ESTIMATE_UNAVAILABLE: "无法估算 Paper 强平价",
  STOP_BEYOND_LIQUIDATION_BUFFER: "止损没有先于 Paper 强平缓冲触发",
  PORTFOLIO_LIQUIDATION_ESTIMATE_UNAVAILABLE: "无法估算加仓后的组合 Paper 强平价",
  PORTFOLIO_STOP_BEYOND_LIQUIDATION_BUFFER: "加仓后整体止损没有先于 Paper 强平缓冲触发"
});

function rejection(code, metrics = {}) {
  return { code, message: SIZING_REJECTION_CODES[code] ?? code, metrics };
}

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
  const longNotionalCny = positions.filter((position) => position.side === "LONG")
    .reduce((sum, position) => sum + Number(position.notional_cny), 0);
  const shortNotionalCny = positions.filter((position) => position.side === "SHORT")
    .reduce((sum, position) => sum + Number(position.notional_cny), 0);
  const totalQuantityBtc = positions.reduce((sum, position) => sum + Number(position.quantity_btc), 0);
  const groupMap = new Map();
  for (const position of positions) {
    const key = `${position.side}:${position.position_group_id}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(position);
  }
  const positionGroups = [...groupMap.values()].map((legs) => {
    const quantityBtc = legs.reduce((sum, leg) => sum + Number(leg.quantity_btc), 0);
    const weighted = (field) => quantityBtc > 0
      ? legs.reduce((sum, leg) => sum + Number(leg[field]) * Number(leg.quantity_btc), 0) / quantityBtc
      : null;
    return {
      groupId: Number(legs[0].position_group_id),
      side: legs[0].side,
      positionCount: legs.length,
      quantityBtc: round(quantityBtc, 8),
      averageEntryPrice: finite(weighted("entry_price")) ? round(weighted("entry_price"), 2) : null,
      overallStopLoss: finite(weighted("stop_loss")) ? round(weighted("stop_loss"), 2) : null,
      overallTakeProfit: finite(weighted("take_profit")) ? round(weighted("take_profit"), 2) : null,
      marginCny: round(legs.reduce((sum, leg) => sum + Number(leg.margin_cny ?? leg.notional_cny), 0), 4),
      notionalCny: round(legs.reduce((sum, leg) => sum + Number(leg.notional_cny), 0), 4),
      positions: legs
    };
  });
  const oneGroupOnly = positionGroups.length === 1 ? positionGroups[0] : null;
  const totalRiskCny = positions.reduce((sum, position) => {
    if (!finite(currentPrice)) return sum + Number(position.expected_loss_cny ?? position.risk_cny);
    const direction = position.side === "LONG" ? 1 : -1;
    const priceRisk = Math.max(0, direction * (Number(currentPrice) - Number(position.stop_loss)))
      * Number(position.quantity_btc) * config.usdtCnyRate;
    // 剩余风险是「被止损出场」的情形，退出成本必须按止损成交价估算，
    // 而不是按永远不会在这条路径上成交的止盈价。
    const stopExitFill = adverseFill(position.side, Number(position.stop_loss), "EXIT", config.slippageRate);
    const exitCost = stopExitFill * Number(position.quantity_btc)
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
    longNotionalCny: round(longNotionalCny, 4),
    shortNotionalCny: round(shortNotionalCny, 4),
    grossNotionalCny: round(totalNotionalCny, 4),
    totalNotionalCny: round(totalNotionalCny, 4),
    effectiveLeverage: marginUsedCny > 0 ? round(totalNotionalCny / marginUsedCny, 4) : 0,
    totalRiskCny: round(totalRiskCny, 4),
    totalRiskPct: equityCny > 0 ? round(totalRiskCny / equityCny, 6) : 0,
    totalQuantityBtc: round(totalQuantityBtc, 8),
    averageEntryPrice: oneGroupOnly?.averageEntryPrice ?? null,
    overallStopLoss: oneGroupOnly?.overallStopLoss ?? null,
    overallTakeProfit: oneGroupOnly?.overallTakeProfit ?? null,
    legacyFallbackCount: positions.filter((position) => position.legacy_contract_math_status === "LEGACY_UNKNOWN").length,
    positionGroups,
    positions
  };
}

export function buildPaperCandidate(...args) {
  return buildPaperCandidateResult(...args).candidate;
}

export function buildPaperCandidateResult(
  report,
  accountOrState,
  runtimeSettings = RUNTIME_SETTINGS_DEFAULTS,
  exchangeConstraints = resolveExchangeConstraints({}, PAPER_EXCHANGE_CONSTRAINTS),
  openPositions = [],
  config = PAPER_CONFIG,
  portfolioPositions = openPositions
) {
  const reject = (code, metrics) => ({ candidate: null, rejection: rejection(code, metrics) });
  const side = report.decision;
  if (!["LONG", "SHORT"].includes(side)) return reject("DECISION_NOT_DIRECTIONAL", { decision: report.decision ?? null });
  if (!report.plan || !finite(report.currentPrice) || !finite(report.plan.stopLoss)) {
    return reject("PLAN_INCOMPLETE", {
      currentPrice: report.currentPrice ?? null,
      stopLoss: report.plan?.stopLoss ?? null
    });
  }
  const signalEntry = Number(report.currentPrice);
  const stopLoss = Number(report.plan.stopLoss);
  const stopIsValid = side === "LONG" ? stopLoss < signalEntry : stopLoss > signalEntry;
  if (!stopIsValid) return reject("STOP_ON_WRONG_SIDE", { side, signalEntry, stopLoss });

  const accountEquityCny = Number(accountOrState.equityCny ?? accountOrState.cash_cny);
  if (!(accountEquityCny > 0)) return reject("EQUITY_NOT_POSITIVE", { accountEquityCny });
  const portfolioMargin = portfolioPositions.reduce((sum, item) => sum + Number(item.margin_cny ?? item.notional_cny), 0);
  const portfolioNotional = portfolioPositions.reduce((sum, item) => sum + Number(item.notional_cny), 0);
  const portfolioRisk = portfolioPositions.reduce((sum, item) => sum + Number(item.expected_loss_cny ?? item.risk_cny), 0);
  const groupMargin = openPositions.reduce((sum, item) => sum + Number(item.margin_cny ?? item.notional_cny), 0);
  const groupNotional = openPositions.reduce((sum, item) => sum + Number(item.notional_cny), 0);
  const groupRisk = openPositions.reduce((sum, item) => sum + Number(item.expected_loss_cny ?? item.risk_cny), 0);
  const availableRisk = Math.max(0, accountEquityCny * runtimeSettings.maxTotalRiskPct - portfolioRisk);
  const availableMargin = Math.max(0, accountEquityCny * runtimeSettings.maxMarginUsagePct - portfolioMargin);
  const availableNotional = Math.max(0, accountEquityCny * runtimeSettings.maxTotalNotionalMultiple - portfolioNotional);
  if (!(availableRisk > 0)) return reject("PORTFOLIO_RISK_BUDGET_EXHAUSTED", { availableRisk, portfolioRisk, accountEquityCny });
  if (!(availableMargin > 0)) return reject("PORTFOLIO_MARGIN_BUDGET_EXHAUSTED", { availableMargin, portfolioMargin, accountEquityCny });
  if (!(availableNotional > 0)) return reject("PORTFOLIO_NOTIONAL_BUDGET_EXHAUSTED", { availableNotional, portfolioNotional, accountEquityCny });

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
  // AUTO 的动态单笔风险上限必须是真正的硬上限，而不是只在 Telegram 上显示。
  // materializeRuntimeSettings/applyDynamicLimits 把它写进 riskPerTradePct。
  const dynamicRiskCeiling = finite(runtimeSettings.riskPerTradePct)
    ? Number(runtimeSettings.riskPerTradePct)
    : config.absoluteMaxRiskPerTradePct;
  // 先按用户区间夹紧，再施加动态上限：上限必须赢过 riskMin 下限，
  // 否则一个比下限还低的动态上限会被下限顶回去，等于没生效。
  const boundedRiskPct = Math.min(
    clamp(requestedRiskPct, runtimeSettings.riskMinPct, config.absoluteMaxRiskPerTradePct),
    dynamicRiskCeiling
  );
  // 数据降级的风险系数必须真正收缩仓位。它作用在 riskMin 下限之后：
  // 证据不足时允许低于平常的最小风险，这是收紧而不是放宽。
  const dataRiskMultiplier = finite(report.dataPolicy?.riskMultiplier)
    ? clamp(Number(report.dataPolicy.riskMultiplier), 0, 1)
    : 1;
  const riskPct = boundedRiskPct * dataRiskMultiplier;
  const riskBudgetCny = Math.min(accountEquityCny * riskPct, availableRisk);
  if (!(riskBudgetCny > 0)) {
    return reject("RISK_BUDGET_ZERO", {
      riskPct,
      requestedRiskPct: round(requestedRiskPct, 8),
      dynamicRiskCeiling: round(dynamicRiskCeiling, 8),
      dataRiskMultiplier,
      availableRisk,
      accountEquityCny
    });
  }

  const fundingRate = finite(report.derivatives?.fundingRatePct) ? Number(report.derivatives.fundingRatePct) / 100 : 0;
  const viableTargets = candidateTargets(report).map((takeProfit) => ({
    takeProfit,
    economics: unitEconomics(side, signalEntry, stopLoss, takeProfit, fundingRate, config)
  })).filter(({ takeProfit, economics }) => {
    const validDirection = side === "LONG" ? takeProfit > signalEntry : takeProfit < signalEntry;
    return validDirection && finite(economics.netRr) && economics.netRr >= config.minimumRiskReward;
  });
  if (!viableTargets.length) {
    const attempted = candidateTargets(report).map((takeProfit) => {
      const economics = unitEconomics(side, signalEntry, stopLoss, takeProfit, fundingRate, config);
      return { takeProfit, netRr: finite(economics.netRr) ? round(economics.netRr, 4) : null };
    });
    return reject("NO_TARGET_MEETS_NET_RR", {
      minimumRiskReward: config.minimumRiskReward,
      attemptedTargets: attempted,
      bestNetRr: attempted.reduce((best, item) => item.netRr !== null && item.netRr > best ? item.netRr : best, 0)
    });
  }
  const selected = opportunityScore >= 80 ? viableTargets.at(-1) : viableTargets[0];
  const perBtc = selected.economics;
  const quantityByRisk = riskBudgetCny / perBtc.expectedLoss;

  // AUTO 下必须使用动态解出的 userMaxLeverage，而不是静态的区间上限 leverageMax，
  // 否则 Telegram 显示的「本轮杠杆上限」和实际用于建仓的上限会不一致。
  // 动态值永远 <= leverageMax，这里再取一次 min 作为防御。
  const configuredLeverageMaximum = runtimeSettings.leverageMode === "MANUAL"
    ? Number(runtimeSettings.leverageManual)
    : Math.min(
        Number(runtimeSettings.leverageMax),
        finite(runtimeSettings.userMaxLeverage) ? Number(runtimeSettings.userMaxLeverage) : Number(runtimeSettings.leverageMax)
      );
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
  // 名义仓位只能用「可以被 0.01 步进精确表示」的杠杆去撬动，否则向上取整后的杠杆
  // 会越过上限。先把上限向下对齐到步进，requiredLeverage 就一定落在可表示范围内。
  const usableLeverageCap = Math.max(LEVERAGE_STEP, floorToLeverageStep(leverageCap));
  const marginBoundNotional = availableMargin * usableLeverageCap;
  const quantityByNotional = Math.min(availableNotional, marginBoundNotional) / unitNotional;
  const contractSize = Number(exchangeConstraints.contractSizeBtc);
  const targetQuantity = Math.min(quantityByRisk, quantityByNotional);
  let quantityBtc = floorToContract(targetQuantity, contractSize);
  if (!(quantityBtc >= contractSize)) {
    return reject("BELOW_MIN_CONTRACT_STEP", {
      contractSizeBtc: contractSize,
      quantityByRisk: round(quantityByRisk, 10),
      quantityByNotional: round(quantityByNotional, 10),
      bindingConstraint: quantityByRisk <= quantityByNotional ? "RISK_BUDGET" : "MARGIN_OR_NOTIONAL",
      riskBudgetCny: round(riskBudgetCny, 6),
      expectedLossPerBtcCny: round(perBtc.expectedLoss, 6),
      accountEquityCny: round(accountEquityCny, 4),
      minimumContractNotionalCny: round(contractSize * unitNotional, 4)
    });
  }

  // 杠杆必须是「满足可用保证金约束的最小可表示杠杆」。向上取整保证
  // marginCny = notional / leverage <= availableMargin；如果向上取整后越过上限，
  // 就按合约步进缩小数量重算，绝不放行一个越界的仓位。
  let notionalCny = quantityBtc * perBtc.entryFill * config.usdtCnyRate;
  let leverage = null;
  let marginCny = null;
  let leverageBlocked = null;
  for (let attempt = 0; quantityBtc >= contractSize; attempt += 1) {
    notionalCny = quantityBtc * perBtc.entryFill * config.usdtCnyRate;
    const requiredLeverage = notionalCny / availableMargin;
    const desiredLeverage = runtimeSettings.leverageMode === "MANUAL"
      ? Math.max(Number(runtimeSettings.leverageManual), requiredLeverage)
      : Math.max(hardMinLeverage, requiredLeverage);
    const candidateLeverage = ceilToLeverageStep(clamp(desiredLeverage, hardMinLeverage, Math.max(hardMinLeverage, leverageCap)));
    if (candidateLeverage > leverageCap + LEVERAGE_EPSILON) {
      leverageBlocked = { requiredLeverage, candidateLeverage, leverageCap };
      quantityBtc = round(quantityBtc - contractSize, 8);
      continue;
    }
    const candidateMargin = notionalCny / candidateLeverage;
    if (candidateMargin > availableMargin + LEVERAGE_EPSILON) {
      leverageBlocked = { requiredLeverage, candidateLeverage, candidateMargin, availableMargin };
      quantityBtc = round(quantityBtc - contractSize, 8);
      continue;
    }
    leverage = normalizeLeverage(candidateLeverage);
    marginCny = notionalCny / leverage;
    if (marginCny > availableMargin + 0.01) {
      // normalizeLeverage 只做两位小数展示化，理论上不会放大保证金；保留防御分支。
      leverageBlocked = { requiredLeverage, candidateLeverage, marginCny, availableMargin };
      leverage = null;
      marginCny = null;
      quantityBtc = round(quantityBtc - contractSize, 8);
      continue;
    }
    break;
  }
  if (leverage === null || marginCny === null || !(quantityBtc >= contractSize)) {
    const code = leverageBlocked?.candidateLeverage > leverageCap ? "LEVERAGE_CAP_BINDING" : "MARGIN_CAP_BINDING";
    return reject(code, {
      contractSizeBtc: contractSize,
      leverageCap: round(leverageCap, 4),
      usableLeverageCap: round(usableLeverageCap, 4),
      availableMarginCny: round(availableMargin, 4),
      ...leverageBlocked
    });
  }

  const expectedLossCny = perBtc.expectedLoss * quantityBtc;
  const expectedProfitCny = perBtc.expectedProfit * quantityBtc;
  const netRr = expectedLossCny > 0 ? expectedProfitCny / expectedLossCny : null;
  if (!(netRr >= config.minimumRiskReward)) {
    return reject("NET_RR_BELOW_MINIMUM", { netRr: finite(netRr) ? round(netRr, 4) : null, minimumRiskReward: config.minimumRiskReward });
  }
  if (expectedLossCny > riskBudgetCny + 0.01) {
    return reject("RISK_BUDGET_EXCEEDED", { expectedLossCny: round(expectedLossCny, 4), riskBudgetCny: round(riskBudgetCny, 4) });
  }
  const liquidation = estimatePaperLiquidation({
    side,
    entry: perBtc.entryFill,
    quantityBtc,
    marginCny,
    usdtCnyRate: config.usdtCnyRate,
    maintenanceMarginRate: exchangeConstraints.maintenanceMarginRate
  });
  if (!liquidation) return reject("LIQUIDATION_ESTIMATE_UNAVAILABLE", { quantityBtc, marginCny: round(marginCny, 4) });
  const stopBeforeLiquidation = side === "LONG"
    ? stopLoss > liquidation.price + signalEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
    : stopLoss < liquidation.price - signalEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct;
  if (!stopBeforeLiquidation) {
    return reject("STOP_BEYOND_LIQUIDATION_BUFFER", {
      stopLoss,
      liquidationPrice: liquidation.price,
      bufferPct: PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
    });
  }

  const existingQuantity = openPositions.reduce((sum, item) => sum + Number(item.quantity_btc), 0);
  const totalQuantity = existingQuantity + quantityBtc;
  const averageEntry = totalQuantity > 0
    ? (openPositions.reduce((sum, item) => sum + Number(item.entry_price) * Number(item.quantity_btc), 0)
      + perBtc.entryFill * quantityBtc) / totalQuantity
    : perBtc.entryFill;
  const totalRiskCny = groupRisk + expectedLossCny;
  const totalMarginCny = groupMargin + marginCny;
  const totalNotionalCny = groupNotional + notionalCny;
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
  if (!portfolioLiquidation) {
    return reject("PORTFOLIO_LIQUIDATION_ESTIMATE_UNAVAILABLE", { totalQuantity, totalMarginCny: round(totalMarginCny, 4) });
  }
  const portfolioStopBeforeLiquidation = side === "LONG"
    ? weightedStop > portfolioLiquidation.price + averageEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct
    : weightedStop < portfolioLiquidation.price - averageEntry * PAPER_EXCHANGE_CONSTRAINTS.liquidationSafetyBufferPct;
  if (!portfolioStopBeforeLiquidation) {
    return reject("PORTFOLIO_STOP_BEYOND_LIQUIDATION_BUFFER", {
      weightedStop: round(weightedStop, 2),
      portfolioLiquidationPrice: portfolioLiquidation.price
    });
  }
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
  const accountAfter = {
    positionCount: portfolioPositions.length + 1,
    totalRiskCny: round(portfolioRisk + expectedLossCny, 4),
    totalRiskPct: round((portfolioRisk + expectedLossCny) / accountEquityCny, 6),
    totalMarginCny: round(portfolioMargin + marginCny, 4),
    totalMarginPct: round((portfolioMargin + marginCny) / accountEquityCny, 6),
    totalNotionalCny: round(portfolioNotional + notionalCny, 4),
    effectiveLeverage: round((portfolioNotional + notionalCny) / (portfolioMargin + marginCny), 4),
    longNotionalCny: round(
      portfolioPositions.filter((item) => item.side === "LONG").reduce((sum, item) => sum + Number(item.notional_cny), 0)
        + (side === "LONG" ? notionalCny : 0), 4
    ),
    shortNotionalCny: round(
      portfolioPositions.filter((item) => item.side === "SHORT").reduce((sum, item) => sum + Number(item.notional_cny), 0)
        + (side === "SHORT" ? notionalCny : 0), 4
    )
  };
  const directionReasons = (side === "LONG" ? report.bullishReasons : report.bearishReasons) ?? [];
  const candidate = {
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
    accountAfter,
    groupAfter: portfolioAfter,
    portfolioAfter,
    isAddOn: openPositions.length > 0,
    // 仓位计算的中间量。测试用它断言「这是约束允许的最大合法仓位」，
    // 研究报告用它区分是被风险预算、名义仓位还是保证金/杠杆卡住。
    sizing: {
      contractSizeBtc: contractSize,
      quantityByRisk: round(quantityByRisk, 10),
      quantityByNotional: round(quantityByNotional, 10),
      unitNotionalCny: round(unitNotional, 8),
      expectedLossPerBtcCny: round(perBtc.expectedLoss, 8),
      availableRiskCny: round(availableRisk, 6),
      availableMarginCny: round(availableMargin, 6),
      availableNotionalCny: round(availableNotional, 6),
      leverageCap: round(leverageCap, 6),
      usableLeverageCap: round(usableLeverageCap, 6),
      hardMinLeverage: round(hardMinLeverage, 6),
      bindingConstraint: quantityByRisk <= quantityByNotional ? "RISK_BUDGET" : "MARGIN_OR_NOTIONAL"
    },
    openingReasons: [
      ...(report.entryAssessment?.methodLabel ? [`动态入场：${report.entryAssessment.methodLabel}`] : []),
      ...directionReasons.slice(0, 4),
      `仓位按权益、${round(expectedLossCny / accountEquityCny * 100, 2)}%净风险、止损距离和保证金上限计算`,
      `实际 ${leverage}x 仅用于分配 ${round(marginCny, 2)} CNY 保证金，不增加允许亏损`
    ].slice(0, 6)
  };
  return { candidate, rejection: null };
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

/**
 * 从数据库与当轮报告拼出 AUTO 限额需要的账户/市场上下文。
 * 全部来自已经发生的事实，不使用任何未来数据。
 */
export function buildExposureContext(db, report, accountState, dailyRisk, config = PAPER_CONFIG) {
  const side = report.decision;
  const equityCny = Number(accountState.equityCny);
  const signalEntry = Number(report.currentPrice);
  const stopLoss = Number(report.plan?.stopLoss);
  const stopDistancePct = finite(signalEntry) && finite(stopLoss) && signalEntry > 0
    ? Math.abs(signalEntry - stopLoss) / signalEntry
    : null;
  const volatilityPct = finite(report.timeframes?.["1h"]?.atr14) && signalEntry > 0
    ? Number(report.timeframes["1h"].atr14) / signalEntry
    : stopDistancePct;
  const peakBalanceCny = typeof db.getPeakBalanceCny === "function"
    ? Number(db.getPeakBalanceCny())
    : Number(accountState.initialCapitalCny);
  const peak = Math.max(peakBalanceCny, Number(accountState.initialCapitalCny), equityCny);
  const sameSideNotionalCny = side === "LONG" ? Number(accountState.longNotionalCny)
    : side === "SHORT" ? Number(accountState.shortNotionalCny) : 0;
  return {
    equityCny,
    initialCapitalCny: Number(accountState.initialCapitalCny),
    opportunityScore: Number(report.opportunities?.[side]?.score ?? 0),
    volatilityPct: finite(volatilityPct) ? Number(volatilityPct) : 0.02,
    stopDistancePct: finite(stopDistancePct) ? Number(stopDistancePct) : 0.02,
    marginUsedCny: Number(accountState.marginUsedCny),
    totalRiskCny: Number(accountState.totalRiskCny),
    grossNotionalCny: Number(accountState.grossNotionalCny),
    sameSideNotionalCny,
    drawdownPct: peak > 0 ? Math.max(0, (peak - equityCny) / peak) : 0,
    dailyLossPct: Number(dailyRisk.dayStartBalanceCny) > 0
      ? Math.max(0, Number(dailyRisk.dailyLossCny) / Number(dailyRisk.dayStartBalanceCny))
      : 0,
    lossStreak: Number(dailyRisk.consecutiveLosses ?? 0),
    positionCount: accountState.positions.length
  };
}

export function evaluatePaperEntry(db, report, config = PAPER_CONFIG, marketData = {}) {
  const blocks = [];
  const block = (code, message) => blocks.push({ code, message });
  const storedSettings = db.getRuntimeSettings();
  const openPositions = db.getOpenPositions();
  const sameSidePositions = openPositions.filter((position) => position.side === report.decision);
  const oppositeSidePositions = openPositions.filter((position) => position.side !== report.decision);
  if (!["LONG", "SHORT"].includes(report.decision)) block("DECISION_NOT_DIRECTIONAL", "当前决策不是 LONG/SHORT");
  for (const gate of report.riskGates ?? []) block("MARKET_RISK_GATE", gate);
  const dailyRisk = getDailyRiskState(db, report.generatedAt, storedSettings);
  if (dailyRisk.paused) {
    for (const reason of dailyRisk.pauseReasons) block("ACCOUNT_PAUSED", reason);
  }
  if (openPositions.length >= storedSettings.maxOpenPositions) block("MAX_OPEN_POSITIONS", "已达到最大同时仓位数");
  if (storedSettings.positionMode === "NET" && oppositeSidePositions.length) {
    block("NET_MODE_OPPOSITE_POSITION", "NET 模式已有相反方向仓位，本轮禁止开仓");
  }
  if (sameSidePositions.length) {
    if (!storedSettings.allowPyramiding) block("PYRAMIDING_DISABLED", "已有同方向 BTC 模拟仓位，加仓已关闭");
    const aggregate = aggregateOpenPosition(sameSidePositions);
    const favorable = report.decision === "LONG"
      ? report.currentPrice > aggregate.averageEntry + aggregate.averageInitialRiskDistance * 0.5
      : report.currentPrice < aggregate.averageEntry - aggregate.averageInitialRiskDistance * 0.5;
    const score = Number(report.opportunities?.[report.decision]?.score ?? 0);
    if (!favorable) block("ADD_ON_NOT_FAVORABLE", "已有仓位尚未获得足够有利进展，禁止加仓");
    if (score < config.minimumImmediateEntryScore + 5) block("ADD_ON_QUALITY_TOO_LOW", "新机会质量不足以支持受控加仓");
    const newestBar = Math.max(...sameSidePositions.map((item) => Number(item.entry_bar_ts)));
    if (Number(report.latest15mBar?.timestamp) <= newestBar) block("ADD_ON_SAME_BAR", "同一行情周期禁止重复加仓");
  }
  let candidate = null;
  let sizing = null;
  let dynamic = null;
  let settings = storedSettings;
  if (!blocks.length) {
    const accountState = calculateAccountState(db, report.currentPrice, config);
    const exposureContext = buildExposureContext(db, report, accountState, dailyRisk, config);
    dynamic = applyDynamicLimits(storedSettings, exposureContext);
    settings = dynamic.settings;
    const constraints = resolveExchangeConstraints(marketData);
    sizing = buildPaperCandidateResult(report, accountState, settings, constraints, sameSidePositions, config, openPositions);
    candidate = sizing.candidate;
    if (!candidate) block(sizing.rejection.code, sizing.rejection.message);
  }
  const seen = new Set();
  const rejections = blocks.filter((item) => {
    const key = `${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    allowed: rejections.length === 0,
    reasons: rejections.map((item) => item.message),
    reasonCodes: rejections.map((item) => item.code),
    rejections,
    sizingRejection: sizing?.rejection ?? null,
    dynamicLimits: dynamic?.limits ?? null,
    exposure: dynamic?.exposure ?? null,
    dailyRisk,
    // openPosition 的原子复核使用已写入 SQLite 的天花板，因此这里必须回传 storedSettings
    // 的 revision/updatedAt；动态限额只会更严，永远不会突破天花板。
    settings: { ...settings, revision: storedSettings.revision, updatedAt: storedSettings.updatedAt },
    storedSettings,
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
  // 移动止损之后，同一根 K 线在止损生效之前已经走出的 high/low 属于过去，
  // 不能用来触发新的止损。只有开始时间晚于止损生效时刻的 K 线才可回溯。
  const stopEffectiveBarTs = finite(position.stop_effective_bar_ts)
    ? Number(position.stop_effective_bar_ts)
    : Number(position.entry_bar_ts);
  const canUseBarForStop = canUseBar && Number(bar.timestamp) > stopEffectiveBarTs;
  const currentPrice = Number(report.currentPrice);
  const liquidation = Number(position.liquidation_price_estimate);
  const hasLiquidation = finite(position.liquidation_price_estimate);
  let exitReason = forcedReason;
  let triggerPrice = currentPrice;
  const barHitStop = canUseBarForStop && (position.side === "LONG"
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
      ? (canUseBarForStop ? Number(bar.low) <= Number(position.stop_loss) : currentPrice <= Number(position.stop_loss))
      : (canUseBarForStop ? Number(bar.high) >= Number(position.stop_loss) : currentPrice >= Number(position.stop_loss));
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
