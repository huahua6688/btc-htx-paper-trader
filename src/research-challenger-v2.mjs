import { PAPER_CONFIG } from "./config.mjs";
import { observationSourceFor, resolveObservationExecution } from "./execution-timing.mjs";
import { buildMultiScaleContext } from "./indicator-profiles.mjs";
import { hashObject, mean, quantile, round } from "./research-utils.mjs";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const PAYLOAD_INTERVALS = Object.freeze({ kline15m: 15 * 60_000, kline1h: 60 * 60_000, kline4h: 4 * 60 * 60_000, kline1d: 24 * 60 * 60_000 });
const contextCache = new Map();

export const RESEARCH_CHALLENGER_V2_PARAMETERS = Object.freeze({
  version: "research-challenger-v2.0.0",
  indicatorProfile: "AUTO",
  minimumIndependentDirectionDimensions: 2,
  minimumDirectionStrength: 11,
  minimumNetTradableEdgePct: 0.18,
  minimumNetRr: 2,
  maximumExtensionAtr15m: 1.7,
  maximumExtensionAtr1h: 1.35,
  maximumImpulseAtr15m: 2.2,
  uncertaintyBasePct: 0.08,
  executionDelayCostPct: 0.03,
  structureTargetQuantile: 0.35,
  profileSearchSpace: ["SHORT_SWING", "STANDARD_SWING", "LONG_SWING", "AUTO"],
  researchOnly: true
});

function rows(payload) {
  return (payload?.data ?? []).map((item) => ({
    timestamp: Number(item.id) * 1000,
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close),
    volume: Number(item.amount ?? item.vol ?? 0)
  })).filter((item) => [item.timestamp, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function closedMarketView(market) {
  const visibleAt = Number(market.ticker?.ts);
  const output = { ...market };
  for (const [key, interval] of Object.entries(PAYLOAD_INTERVALS)) {
    output[key] = {
      ...(market[key] ?? {}),
      data: (market[key]?.data ?? []).filter((item) => Number(item.id) * 1000 + interval <= visibleAt)
    };
  }
  return output;
}

function directionDimensions(context, market) {
  const { frames } = context;
  const weights = context.profile.selected === "SHORT_SWING"
    ? { "15m": 0.34, "1h": 0.42, "4h": 0.20, "1d": 0.04 }
    : context.profile.selected === "LONG_SWING"
      ? { "15m": 0.06, "1h": 0.20, "4h": 0.42, "1d": 0.32 }
      : { "15m": 0.16, "1h": 0.36, "4h": 0.36, "1d": 0.12 };
  const trendRaw = Object.entries(weights).reduce((sum, [key, weight]) => {
    const frame = frames[key];
    return sum + weight * (frame.ema.alignment * 15 + frame.structure.direction * 10
      + clamp(frame.ema.mediumSlopePct * 6, -7, 7));
  }, 0);
  const trend = clamp(trendRaw, -30, 30);
  const momentumRaw = Object.entries(weights).reduce((sum, [key, weight]) => {
    const frame = frames[key];
    const standardRsi = frame.rsi[Object.keys(frame.rsi)[1]] ?? Object.values(frame.rsi)[0];
    const histogramDirection = Math.sign(frame.macd.histogram);
    const histogramEvolution = Math.sign(frame.macd.change) * (frame.macd.expanding ? 1 : 0.45);
    const rsiDirection = clamp((Number(standardRsi?.value ?? 50) - 50) / 12, -1, 1);
    const rsiEvolution = clamp(Number(standardRsi?.change ?? 0) / 8, -1, 1);
    return sum + weight * (histogramDirection * 8 + histogramEvolution * 5 + rsiDirection * 4 + rsiEvolution * 3);
  }, 0);
  const momentum = clamp(momentumRaw, -20, 20);
  const participationRaw = Object.entries(weights).reduce((sum, [key, weight]) => {
    const frame = frames[key];
    const candle = frame.candles.at(-1);
    const direction = Math.sign(candle.close - candle.open);
    return sum + weight * direction * clamp((Number(frame.volume.ratio20 ?? 1) - 0.8) * 10, -3, 12);
  }, 0);
  const participation = clamp(participationRaw, -12, 12);
  const funding = Number(market.fundingCurrent?.data?.funding_rate);
  const oiNow = Number(market.oiCurrent?.data?.[0]?.value);
  const oiRows = market.oiHistory?.data?.tick ?? [];
  const oiPrior = Number(oiRows[0]?.value);
  const oiChange = finite(oiNow) && finite(oiPrior) && oiPrior !== 0 ? (oiNow / oiPrior - 1) * 100 : null;
  const derivativesAvailable = Number.isFinite(funding) || Number.isFinite(oiChange);
  const trendDirection = Math.sign(trend + momentum);
  let derivatives = 0;
  if (Number.isFinite(funding)) derivatives += clamp(-funding / 0.0001 * 1.2, -5, 5);
  if (Number.isFinite(oiChange) && trendDirection) derivatives += clamp(trendDirection * oiChange * 0.7, -7, 7);
  derivatives = clamp(derivatives, -12, 12);
  return {
    trendStructure: round(trend, 4), momentumProcess: round(momentum, 4),
    participation: round(participation, 4), derivativesContext: round(derivatives, 4),
    availability: { trendStructure: true, momentumProcess: true, participation: true, derivativesContext: derivativesAvailable },
    caps: { trendStructure: 30, momentumProcess: 20, participation: 12, derivativesContext: 12 },
    note: "EMA/价格结构只计入趋势结构一类；RSI/MACD过程只计入动量一类，禁止把同一上涨重复当成多份独立证据。"
  };
}

function sideRead(side, dimensions) {
  const direction = side === "LONG" ? 1 : -1;
  const independent = ["trendStructure", "momentumProcess", "participation", "derivativesContext"]
    .filter((key) => dimensions.availability[key])
    .map((key) => ({ key, signed: direction * dimensions[key] }));
  const supportive = independent.filter((item) => item.signed >= 2.5);
  const opposing = independent.filter((item) => item.signed <= -2.5);
  const raw = independent.reduce((sum, item) => sum + item.signed, 0);
  const opportunityScore = clamp(50 + raw, 0, 100);
  const label = raw >= 30 ? "强" : raw >= 11 ? "偏" : raw <= -30 ? "明显不支持" : raw <= -11 ? "较弱" : "中性";
  return {
    side, raw: round(raw, 3), opportunityScore: round(opportunityScore, 1),
    supportiveDimensions: supportive.map((item) => item.key), opposingDimensions: opposing.map((item) => item.key),
    independentSupportCount: supportive.length, independentOppositionCount: opposing.length, label
  };
}

function pivotLevels(candles, side, currentPrice) {
  const levels = [];
  for (let index = 2; index < candles.length - 2; index += 1) {
    const value = side === "LONG" ? candles[index].high : candles[index].low;
    const local = candles.slice(index - 2, index + 3).map((item) => side === "LONG" ? item.high : item.low);
    const pivot = side === "LONG" ? value === Math.max(...local) : value === Math.min(...local);
    if (pivot && (side === "LONG" ? value > currentPrice : value < currentPrice)) levels.push(value);
  }
  return levels.sort((a, b) => side === "LONG" ? a - b : b - a);
}

export function entryGeometry(side, context, market, parameters) {
  const direction = side === "LONG" ? 1 : -1;
  const currentPrice = Number(market.ticker?.tick?.close);
  const c15 = rows(market.kline15m);
  const c1h = rows(market.kline1h);
  const f15 = context.frames["15m"];
  const f1h = context.frames["1h"];
  const last = c15.at(-1);
  const prior = c15.slice(-25, -1);
  const priorHigh = Math.max(...prior.map((item) => item.high));
  const priorLow = Math.min(...prior.map((item) => item.low));
  const rangePosition = priorHigh > priorLow ? (currentPrice - priorLow) / (priorHigh - priorLow) : 0.5;
  const extension15m = direction * (currentPrice - Number(f15.ema.medium)) / Number(f15.atr.value);
  const extension1h = direction * (currentPrice - Number(f1h.ema.medium)) / Number(f1h.atr.value);
  const impulse15m = direction * (last.close - (c15.at(-5)?.close ?? last.open)) / Number(f15.atr.value);
  const breakoutLevel = side === "LONG" ? priorHigh : priorLow;
  const beyondBreakout = direction * (currentPrice - breakoutLevel) >= 0;
  const breakoutDistanceAtr = Math.abs(currentPrice - breakoutLevel) / Number(f15.atr.value);
  const volumeRatio = Number(f15.volume.ratio20 ?? 0);
  const freshBreakout = beyondBreakout && breakoutDistanceAtr <= 0.65 && volumeRatio >= 1.15;
  const falseBreakReclaim = side === "LONG"
    ? last.low < priorLow && last.close > priorLow && last.close > last.open
    : last.high > priorHigh && last.close < priorHigh && last.close < last.open;
  const nearMean = Math.abs(currentPrice - Number(f1h.ema.medium)) / Number(f1h.atr.value) <= 0.55;
  const reaccelerating = nearMean && direction * (last.close - last.open) > 0 && direction * Number(f15.macd.change) > 0;
  const pullback = extension1h >= -0.25 && extension1h <= 0.65 && direction * (last.close - last.open) <= 0;
  const clusteredChase = extension15m > parameters.maximumExtensionAtr15m
    && extension1h > parameters.maximumExtensionAtr1h
    && impulse15m > parameters.maximumImpulseAtr15m
    && (side === "LONG" ? rangePosition > 0.88 : rangePosition < 0.12);
  const method = falseBreakReclaim ? "FALSE_BREAK_RECLAIM"
    : freshBreakout ? "BREAKOUT_CONFIRMATION"
      : reaccelerating ? "PULLBACK_REACCELERATION"
        : pullback ? "PULLBACK_SUPPORT_WAIT"
          : clusteredChase ? "WAIT_PRICE_EXTENDED" : "DIRECT_BALANCED_PRICE";
  const enterable = !["PULLBACK_SUPPORT_WAIT", "WAIT_PRICE_EXTENDED"].includes(method);
  const recentStopRows = c15.slice(-16);
  const structuralStop = side === "LONG"
    ? Math.min(...recentStopRows.map((item) => item.low)) - Number(f15.atr.value) * 0.12
    : Math.max(...recentStopRows.map((item) => item.high)) + Number(f15.atr.value) * 0.12;
  const volatilityStop = currentPrice - direction * Math.max(Number(f15.atr.value) * 1.1, Number(f1h.atr.value) * 0.5);
  const stopLoss = side === "LONG" ? Math.min(structuralStop, volatilityStop) : Math.max(structuralStop, volatilityStop);
  const riskDistance = Math.abs(currentPrice - stopLoss);
  const levels = [...pivotLevels(c1h.slice(-120), side, currentPrice), ...pivotLevels(rows(market.kline4h).slice(-80), side, currentPrice)]
    .filter((value) => Math.abs(value - currentPrice) >= Number(f1h.atr.value) * 0.55);
  const uniqueLevels = [...new Set(levels.map((value) => round(value, 2)))].sort((a, b) => side === "LONG" ? a - b : b - a);
  const targetIndex = Math.min(uniqueLevels.length - 1, Math.max(0, Math.floor(uniqueLevels.length * parameters.structureTargetQuantile)));
  const structureTarget = uniqueLevels[targetIndex] ?? null;
  const atrProjection = currentPrice + direction * Number(f1h.atr.value) * (context.regime.primary.startsWith("STRONG") ? 1.8 : 1.25);
  const takeProfit = structureTarget ?? atrProjection;
  const remainingSpace = Math.max(0, direction * (takeProfit - currentPrice));
  return {
    method, enterable, currentPrice, stopLoss, takeProfit, targetSource: structureTarget ? "VISIBLE_PIVOT_STRUCTURE" : "REGIME_ATR_PROJECTION_NO_VISIBLE_PIVOT",
    riskDistance, remainingSpace, extension15mAtr: round(extension15m, 4), extension1hAtr: round(extension1h, 4),
    impulse15mAtr: round(impulse15m, 4), rangePositionPct: round(rangePosition * 100, 2),
    breakoutLevel: round(breakoutLevel, 2), breakoutDistanceAtr: round(breakoutDistanceAtr, 4),
    freshBreakout, falseBreakReclaim, reaccelerating, pullback, clusteredChase,
    distanceToSupportResistancePct: round(remainingSpace / currentPrice * 100, 6)
  };
}

export function tradableEdge(side, geometry, context, market, config, parameters, similarity = null) {
  const direction = side === "LONG" ? 1 : -1;
  const currentPrice = geometry.currentPrice;
  const structureSpacePct = geometry.remainingSpace / currentPrice * 100;
  const atrSpacePct = Number(context.frames["1h"].atr.pctOfPrice) * (context.regime.primary.startsWith("STRONG") ? 1.35 : 0.95);
  const similarityMfePct = finite(similarity?.weightedMedianMfePct) ? Number(similarity.weightedMedianMfePct) : null;
  const grossEdgePct = Math.max(0, Math.min(structureSpacePct, atrSpacePct, similarityMfePct ?? Number.POSITIVE_INFINITY));
  const feePct = Number(config.feeRatePerSide) * 2 * 100;
  const slippagePct = Number(config.slippageRate) * 2 * 100;
  const fundingRatePct = Number(market.fundingCurrent?.data?.funding_rate) * 100;
  const fundingPct = Number.isFinite(fundingRatePct) ? Math.max(0, direction * fundingRatePct) : 0;
  const dataPenalty = market.replay ? 0.04 : 0.02;
  const regimePenalty = ["TRANSITION", "EXTREME"].includes(context.regime.primary) ? 0.12 : context.regime.primary === "RANGE" ? 0.07 : 0.03;
  const extensionPenaltyPct = Math.max(0, geometry.extension1hAtr - 0.55) * 0.08
    + Math.max(0, geometry.impulse15mAtr - 1) * 0.04;
  const uncertaintyBufferPct = parameters.uncertaintyBasePct + dataPenalty + regimePenalty;
  const executionCostPct = parameters.executionDelayCostPct;
  const netTradableEdgePct = grossEdgePct - feePct - slippagePct - fundingPct - executionCostPct - uncertaintyBufferPct - extensionPenaltyPct;
  return {
    grossEdgePct: round(grossEdgePct, 6), remainingTradableSpacePct: round(structureSpacePct, 6),
    atrOpportunitySpacePct: round(atrSpacePct, 6), similarityMfePct,
    feesPct: round(feePct, 6), slippagePct: round(slippagePct, 6), fundingPct: round(fundingPct, 6),
    executionCostPct: round(executionCostPct, 6), uncertaintyBufferPct: round(uncertaintyBufferPct, 6),
    priceExtensionPenaltyPct: round(extensionPenaltyPct, 6), netTradableEdgePct: round(netTradableEdgePct, 6),
    formula: "gross opportunity - fees - slippage - funding - execution cost - uncertainty - extension penalty",
    empiricalStatus: similarityMfePct === null ? "HEURISTIC_RESEARCH_ONLY_NOT_CALIBRATED" : "POINT_IN_TIME_SIMILARITY_CONSTRAINED"
  };
}

export function coreDataQuality(market, context) {
  const now = Number(market.ticker?.ts);
  const failures = [];
  for (const [key, interval] of Object.entries({ "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000 })) {
    const last = context.frames[key].candles.at(-1);
    if (!last || last.timestamp + interval > now) failures.push(`${key}没有已收盘K线`);
  }
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(currentPrice > 0)) failures.push("核心价格缺失");
  const referencePrices = (market.crossSourcePrices ?? []).map(Number).filter((value) => value > 0);
  const medianReference = quantile(referencePrices, 0.5);
  const discrepancyPct = medianReference ? Math.abs(currentPrice / medianReference - 1) * 100 : null;
  if (discrepancyPct !== null && discrepancyPct > 1.2) failures.push(`HTX价格与跨源中位数偏差${round(discrepancyPct, 3)}%`);
  return {
    validForEntry: failures.length === 0, failures, score: failures.length ? 0 : referencePrices.length ? 100 : 85,
    crossSourceReferenceCount: referencePrices.length, crossSourceDiscrepancyPct: round(discrepancyPct, 6),
    secondaryDataMode: market.replay ? "HISTORICAL_COMPATIBLE_MISSING_DERIVATIVES_NOT_FILLED" : "DEGRADED_ALLOWED"
  };
}

function reasonForDimension(side, key, value) {
  const direction = side === "LONG" ? 1 : -1;
  const signed = direction * value;
  const label = key === "trendStructure" ? "趋势与高低点结构" : key === "momentumProcess" ? "动量变化过程"
    : key === "participation" ? "成交参与" : "衍生品背景";
  return `${label}${signed >= 0 ? "支持" : "反对"}${side === "LONG" ? "做多" : "做空"}（独立贡献 ${round(signed, 1)}）`;
}

export function analyzeResearchChallengerV2(market, parameters = RESEARCH_CHALLENGER_V2_PARAMETERS, config = PAPER_CONFIG, options = {}) {
  const now = Number(market.ticker?.ts);
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(now > 0) || !(currentPrice > 0)) throw new Error("V2 Challenger requires point-in-time market time and price");
  const visibleMarket = closedMarketView(market);
  const requestedProfile = options.indicatorProfile ?? parameters.indicatorProfile;
  const cacheKey = `${now}:${currentPrice}:${requestedProfile}`;
  let context = options.useCache === false ? null : contextCache.get(cacheKey);
  if (!context) {
    context = buildMultiScaleContext(visibleMarket, requestedProfile);
    if (options.useCache !== false) {
      contextCache.set(cacheKey, context);
      if (contextCache.size > 512) contextCache.delete(contextCache.keys().next().value);
    }
  }
  const dimensions = directionDimensions(context, visibleMarket);
  const longRead = sideRead("LONG", dimensions);
  const shortRead = sideRead("SHORT", dimensions);
  const leader = longRead.raw >= shortRead.raw ? longRead : shortRead;
  const directionEligible = leader.raw >= parameters.minimumDirectionStrength
    && leader.independentSupportCount >= parameters.minimumIndependentDirectionDimensions
    && leader.independentSupportCount > leader.independentOppositionCount;
  const candidateDecision = directionEligible ? leader.side : "WAIT";
  const strengthState = !directionEligible ? "NEUTRAL" : leader.raw >= 30
    ? (leader.side === "LONG" ? "STRONG_LONG" : "STRONG_SHORT")
    : leader.side === "LONG" ? "LEAN_LONG" : "LEAN_SHORT";
  const dataQuality = coreDataQuality(visibleMarket, context);
  const latest15mBar = context.frames["15m"].candles.at(-1) ?? null;
  const geometry = candidateDecision === "WAIT" ? null : entryGeometry(candidateDecision, context, visibleMarket, parameters);
  const edge = geometry ? tradableEdge(candidateDecision, geometry, context, visibleMarket, config, parameters, options.similarity) : null;
  const riskDistance = geometry?.riskDistance ?? 0;
  const rawRr = riskDistance > 0 ? geometry.remainingSpace / riskDistance : null;
  const costDistance = edge ? currentPrice * (edge.feesPct + edge.slippagePct + edge.fundingPct + edge.executionCostPct + edge.uncertaintyBufferPct) / 100 : 0;
  const netRewardDistance = Math.max(0, Number(geometry?.remainingSpace ?? 0) - costDistance);
  const netRiskDistance = riskDistance + costDistance;
  const netRr = netRiskDistance > 0 ? netRewardDistance / netRiskDistance : null;
  const entryAllowed = candidateDecision !== "WAIT" && dataQuality.validForEntry && geometry.enterable
    && edge.netTradableEdgePct >= parameters.minimumNetTradableEdgePct && netRr >= parameters.minimumNetRr;
  const decision = entryAllowed ? candidateDecision : "WAIT";
  const supporting = candidateDecision === "WAIT" ? [] : Object.entries(dimensions)
    .filter(([key, value]) => typeof value === "number" && (candidateDecision === "LONG" ? value : -value) > 0)
    .map(([key, value]) => reasonForDimension(candidateDecision, key, value));
  const opposing = candidateDecision === "WAIT" ? ["至少两个相互独立的方向维度尚未形成一致优势"] : Object.entries(dimensions)
    .filter(([key, value]) => typeof value === "number" && (candidateDecision === "LONG" ? value : -value) < 0)
    .map(([key, value]) => reasonForDimension(candidateDecision, key, value));
  const missingConditions = [];
  if (!dataQuality.validForEntry) missingConditions.push(...dataQuality.failures);
  if (!directionEligible) missingConditions.push("方向强度或独立证据数量不足");
  if (geometry && !geometry.enterable) missingConditions.push(geometry.method === "WAIT_PRICE_EXTENDED" ? "价格延伸过大，等待而不追价" : "等待回调后的重新转强/转弱");
  if (edge && edge.netTradableEdgePct < parameters.minimumNetTradableEdgePct) missingConditions.push(`净可交易优势 ${edge.netTradableEdgePct}% 低于研究门槛 ${parameters.minimumNetTradableEdgePct}%`);
  if (finite(netRr) && netRr < parameters.minimumNetRr) missingConditions.push(`结构目标扣成本后净RR ${round(netRr, 2)} 不足 1:${parameters.minimumNetRr}`);
  const methodLabels = {
    FALSE_BREAK_RECLAIM: "假跌破/假突破收回后的入场",
    BREAKOUT_CONFIRMATION: "有量且未过度延伸的突破确认",
    PULLBACK_REACCELERATION: "回调后重新转强/转弱",
    PULLBACK_SUPPORT_WAIT: "方向成立，等待支撑/压力附近重新确认",
    WAIT_PRICE_EXTENDED: "方向成立但价格过度延伸，拒绝追涨杀跌",
    DIRECT_BALANCED_PRICE: "价格位置与剩余空间合理，允许直接入场"
  };
  const opportunity = (read) => ({
    side: read.side, score: read.opportunityScore, opportunityScore: read.opportunityScore,
    scoreMeaning: "未经概率校准的 Opportunity Score，不是置信度/胜率",
    directionalScore: read.opportunityScore,
    timingScore: read.side === candidateDecision && geometry?.enterable ? 70 : 40,
    supportingReasons: read.side === candidateDecision ? supporting.slice(0, 5) : [],
    opposingReasons: read.side === candidateDecision ? opposing.slice(0, 5) : [`独立维度更支持${leader.side === "LONG" ? "多头" : "空头"}`]
  });
  return {
    version: parameters.version,
    strategyHash: hashObject(parameters),
    mode: "RESEARCH_CHALLENGER_V2_SHADOW_PAPER_ONLY",
    symbol: "BTC-USDT", generatedAt: new Date(now).toISOString(), currentPrice: round(currentPrice, 2),
    latest15mBar,
    completed15mBar: latest15mBar,
    execution: resolveObservationExecution({
      observationTimestamp: now,
      fillReferencePrice: currentPrice,
      observationSource: observationSourceFor(market)
    }),
    decision, candidateDecision, directionState: strengthState,
    confidencePct: 0,
    scoreTerminology: "OPPORTUNITY_SCORE_NOT_PROBABILITY",
    finalScore: round(longRead.raw - shortRead.raw, 2),
    riskGates: dataQuality.failures,
    plan: entryAllowed ? {
      entryPrice: round(currentPrice, 2), stopLoss: round(geometry.stopLoss, 2), takeProfit: [round(geometry.takeProfit, 2)],
      riskReward: [round(rawRr, 4)], netRiskReward: [round(netRr, 4)], targetSource: geometry.targetSource
    } : { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null, netRiskReward: null, targetSource: geometry?.targetSource ?? null },
    entryAssessment: {
      enterNow: entryAllowed, method: geometry?.method ?? "NO_DIRECTION",
      methodLabel: geometry ? methodLabels[geometry.method] : "多空独立证据尚未形成优势",
      reasons: [...supporting, geometry ? methodLabels[geometry.method] : null, edge ? `净可交易优势 ${edge.netTradableEdgePct}%` : null].filter(Boolean).slice(0, 5),
      missingConditions, riskPct: entryAllowed ? (leader.opportunityScore >= 78 ? config.maxRiskPerTradePct : config.reducedRiskPerTradePct) : 0
    },
    opportunities: { LONG: opportunity(longRead), SHORT: opportunity(shortRead) },
    scores: {
      longOpportunity: longRead.opportunityScore, shortOpportunity: shortRead.opportunityScore,
      scoreGap: round(Math.abs(longRead.opportunityScore - shortRead.opportunityScore), 2), dimensions
    },
    multiScaleContext: {
      profile: context.profile, regime: context.regime,
      naturalWindows: context.frames["4h"].naturalReturnsPct,
      process: Object.fromEntries(Object.entries(context.frames).map(([key, frame]) => [key, {
        ema: frame.ema, rsi: frame.rsi, macd: frame.macd, atr: frame.atr, volume: frame.volume, structure: frame.structure,
        naturalReturnsPct: frame.naturalReturnsPct
      }]))
    },
    strategy: {
      version: parameters.version, marketRegime: context.regime.primary, volatilityRegime: context.regime.volatility,
      indicatorProfile: context.profile.selected, bias: candidateDecision, state: entryAllowed ? "ENTER_NOW" : "WAIT",
      riskPct: entryAllowed ? (leader.opportunityScore >= 78 ? config.maxRiskPerTradePct : config.reducedRiskPerTradePct) : 0,
      riskTier: leader.opportunityScore >= 78 ? "NORMAL" : "REDUCED", hardBlocks: dataQuality.failures,
      softWarnings: missingConditions, entryMethod: geometry?.method ?? "NO_DIRECTION",
      directionEntryRiskSeparated: true, frozenChampionModified: false
    },
    entryGeometry: geometry,
    tradableEdge: edge ? { estimates: { [candidateDecision]: edge }, selected: edge, minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct } : null,
    timeframes: Object.fromEntries(Object.entries(context.frames).map(([key, frame]) => [key, {
      score: null, close: frame.close, ema20: frame.ema.medium, ema50: frame.ema.slow,
      ema20SlopePct: frame.ema.mediumSlopePct, rsi14: Object.values(frame.rsi)[1]?.value ?? Object.values(frame.rsi)[0]?.value,
      atr14: frame.atr.value, adx14: frame.adx, macdHistogram: frame.macd.histogram,
      momentum20Pct: frame.naturalReturnsPct.day1, volumeRatio: frame.volume.ratio20
    }])),
    derivatives: {
      fundingRatePct: finite(visibleMarket.fundingCurrent?.data?.funding_rate) ? Number(visibleMarket.fundingCurrent.data.funding_rate) * 100 : null,
      fundingSource: visibleMarket.fundingCurrent?.data?.source ?? "UNAVAILABLE_NOT_FILLED",
      oiUsd: finite(visibleMarket.oiCurrent?.data?.[0]?.value) ? Number(visibleMarket.oiCurrent.data[0].value) : null
    },
    bullishReasons: longRead.raw > 0 ? supporting : [], bearishReasons: shortRead.raw > 0 ? supporting : [],
    dataQuality,
    historicalCompatibility: {
      compatible: Boolean(market.replay), usesOnlyPointInTimeFeatures: Boolean(market.replay),
      allowedSources: market.replay ? ["HTX closed OHLCV", "timestamp-visible HTX Funding"] : ["current public HTX market data"],
      forbiddenAndAbsent: market.replay?.unavailableSources ?? [],
      futureDataFilled: false
    },
    safety: { apiKeyUsed: false, privateEndpointUsed: false, exchangeWriteEnabled: false, paperTradingOnly: true }
  };
}
