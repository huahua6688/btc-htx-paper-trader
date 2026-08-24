import { PAPER_CONFIG } from "./config.mjs";
import { atr, ema } from "./indicators.mjs";
import { closedMarketView } from "./research-challenger-v2.mjs";
import { hashObject, round } from "./research-utils.mjs";

const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * HOUR_MS;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export const BREAKOUT_V4_PARAMETERS = Object.freeze({
  version: "breakout-challenger-v4.0.0",
  breakoutLookback4h: 40,
  trendEma4h: 50,
  trendSlopeBars4h: 6,
  trendFilter: "EMA50_DIRECTION_SLOPE",
  atrPeriod4h: 14,
  stopAtrMultiple: 2.5,
  targetRiskMultiple: 4,
  minimumBreakoutAtr: 0,
  positionManagementProfile: "HARD_BRACKET_HOLD_V1",
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

function waitReportBase(now, price, parameters, fundingRatePct, fundingSource) {
  return {
    version: parameters.version,
    strategyHash: hashObject(parameters),
    mode: "BREAKOUT_V4_SHADOW_PAPER_ONLY",
    symbol: "BTC-USDT",
    generatedAt: new Date(now).toISOString(),
    currentPrice: round(price, 2),
    confidencePct: 0,
    scoreTerminology: "BREAKOUT_EVIDENCE_SCORE_NOT_PROBABILITY",
    riskGates: [],
    derivatives: { fundingRatePct, fundingSource, oiUsd: null, pressureScore: null },
    dataQuality: { validForEntry: true, failures: [], score: 100 },
    historicalCompatibility: { compatible: true, usesOnlyPointInTimeFeatures: true, futureDataFilled: false },
    safety: { apiKeyUsed: false, privateEndpointUsed: false, exchangeWriteEnabled: false, paperTradingOnly: true }
  };
}

export function analyzeBreakoutChallenger(market, parameters = BREAKOUT_V4_PARAMETERS, config = PAPER_CONFIG) {
  const now = Number(market.ticker?.ts);
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(now > 0) || !(currentPrice > 0)) throw new Error("Breakout V4 requires point-in-time market time and price");
  const visibleMarket = closedMarketView(market);
  const h4 = rows(visibleMarket.kline4h);
  const h1 = rows(visibleMarket.kline1h);
  const minimum = Math.max(parameters.breakoutLookback4h + 1, parameters.trendEma4h + parameters.trendSlopeBars4h + 1, parameters.atrPeriod4h + 2);
  if (h4.length < minimum || h1.length < 20) throw new Error("Breakout V4 completed candle history is too short");
  const fundingRatePct = finite(visibleMarket.fundingCurrent?.data?.funding_rate)
    ? Number(visibleMarket.fundingCurrent.data.funding_rate) * 100
    : null;
  const base = waitReportBase(now, currentPrice, parameters, fundingRatePct, visibleMarket.fundingCurrent?.data?.source ?? "UNAVAILABLE_NOT_FILLED");
  const latest = h4.at(-1);
  const closes = h4.map((item) => item.close);
  const trendLine = ema(closes, parameters.trendEma4h);
  const trendNow = trendLine.at(-1);
  const trendPrior = trendLine.at(-(parameters.trendSlopeBars4h + 1));
  const prior = h4.slice(-(parameters.breakoutLookback4h + 1), -1);
  const priorHigh = Math.max(...prior.map((item) => item.high));
  const priorLow = Math.min(...prior.map((item) => item.low));
  const atr4h = atr(h4, parameters.atrPeriod4h);
  const atr1h = atr(h1, 14);
  // `closedMarketView` has already removed every still-open candle.  The live
  // monitor normally observes a 4h close a few seconds/minutes after the wall
  // clock boundary, so the signal identity must be the completed candle rather
  // than an exact ticker timestamp modulo check.
  const signalBarTimestamp = latest.timestamp;
  const signalBarClosedAt = signalBarTimestamp + FOUR_HOURS_MS;
  const signalBarAvailable = signalBarClosedAt <= now;
  const isExactWallClockBoundary = now % FOUR_HOURS_MS === 0 && signalBarClosedAt === now;
  const signalKey = `${base.strategyHash}:BTC-USDT:4h:${signalBarTimestamp}`;
  const longBreakoutDistanceAtr = atr4h > 0 ? (latest.close - priorHigh) / atr4h : 0;
  const shortBreakoutDistanceAtr = atr4h > 0 ? (priorLow - latest.close) / atr4h : 0;
  const requireSlope = parameters.trendFilter !== "EMA50_PRICE_ALIGNMENT";
  const longTrend = latest.close > trendNow && (!requireSlope || trendNow > trendPrior);
  const shortTrend = latest.close < trendNow && (!requireSlope || trendNow < trendPrior);
  const longSignal = signalBarAvailable && latest.close > priorHigh && longTrend && longBreakoutDistanceAtr >= parameters.minimumBreakoutAtr;
  const shortSignal = signalBarAvailable && latest.close < priorLow && shortTrend && shortBreakoutDistanceAtr >= parameters.minimumBreakoutAtr;
  const candidateDecision = longSignal ? "LONG" : shortSignal ? "SHORT" : "WAIT";
  const direction = candidateDecision === "LONG" ? 1 : candidateDecision === "SHORT" ? -1 : 0;
  const riskDistance = atr4h * parameters.stopAtrMultiple;
  const stopLoss = direction ? currentPrice - direction * riskDistance : null;
  const takeProfit = direction ? currentPrice + direction * riskDistance * parameters.targetRiskMultiple : null;
  const longSupport = (longTrend ? 30 : 0) + clamp(longBreakoutDistanceAtr * 25, 0, 25) + (longSignal ? 25 : 0);
  const shortSupport = (shortTrend ? 30 : 0) + clamp(shortBreakoutDistanceAtr * 25, 0, 25) + (shortSignal ? 25 : 0);
  const longScore = clamp(20 + longSupport - (shortTrend ? 20 : 0), 0, 100);
  const shortScore = clamp(20 + shortSupport - (longTrend ? 20 : 0), 0, 100);
  const riskPct = direction ? config.reducedRiskPerTradePct : 0;
  const reason = candidateDecision === "WAIT"
    ? "最近完整 4h signal bar 尚未突破前高/前低并满足 EMA50 斜率"
    : `${parameters.breakoutLookback4h} 根4h区间突破，EMA${parameters.trendEma4h}方向一致`;
  return {
    ...base,
    decision: candidateDecision,
    candidateDecision,
    directionState: candidateDecision === "WAIT" ? "NEUTRAL" : `BREAKOUT_${candidateDecision}`,
    finalScore: round(longScore - shortScore, 2),
    plan: direction ? {
      entryPrice: round(currentPrice, 2), stopLoss: round(stopLoss, 2), takeProfit: [round(takeProfit, 2)],
      riskReward: [parameters.targetRiskMultiple], netRiskReward: null,
      initialRiskDistance: round(riskDistance, 8),
      targetSource: `FIXED_${parameters.targetRiskMultiple}R_FROM_4H_ATR_BRACKET`,
      managementContract: { profile: parameters.positionManagementProfile, hardStopAlwaysActive: true, hardTargetAlwaysActive: true, dynamicExitEnabled: false }
    } : { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null, netRiskReward: null, targetSource: null },
    entryAssessment: {
      enterNow: Boolean(direction), method: direction ? "4H_DONCHIAN_BREAKOUT" : "WAIT_4H_BREAKOUT",
      methodLabel: reason, reasons: [reason], missingConditions: direction ? [] : [reason], riskPct,
      signalKey: direction ? signalKey : null,
      signalBarTimestamp,
      signalBarClosedAt
    },
    opportunities: {
      LONG: { side: "LONG", score: round(longScore, 2), opportunityScore: round(longScore, 2), directionalScore: round(longScore, 2), timingScore: longSignal ? 85 : 20, supportingReasons: longTrend ? ["4h EMA50 向上且价格在其上"] : [], opposingReasons: shortTrend ? ["4h 趋势向下"] : [] },
      SHORT: { side: "SHORT", score: round(shortScore, 2), opportunityScore: round(shortScore, 2), directionalScore: round(shortScore, 2), timingScore: shortSignal ? 85 : 20, supportingReasons: shortTrend ? ["4h EMA50 向下且价格在其下"] : [], opposingReasons: longTrend ? ["4h 趋势向上"] : [] }
    },
    scores: { longOpportunity: round(longScore, 2), shortOpportunity: round(shortScore, 2), scoreGap: round(Math.abs(longScore - shortScore), 2), independent: true },
    timeframes: {
      "15m": { atr14: null },
      "1h": { atr14: round(atr1h, 6) },
      "4h": { atr14: round(atr4h, 6), ema50: round(trendNow, 4), ema50Slope: round(trendNow - trendPrior, 6), priorHigh: round(priorHigh, 2), priorLow: round(priorLow, 2) },
      "1d": { atr14: null }
    },
    strategy: {
      version: parameters.version,
      marketRegime: longTrend ? "4H_UPTREND" : shortTrend ? "4H_DOWNTREND" : "4H_NEUTRAL",
      bias: candidateDecision,
      state: direction ? "ENTER_NOW" : "WAIT",
      riskPct,
      riskTier: "REDUCED",
      hardBlocks: [], softWarnings: direction ? [] : [reason], entryMethod: direction ? "4H_DONCHIAN_BREAKOUT" : "WAIT",
      positionManagementProfile: parameters.positionManagementProfile,
      managementContract: { profile: parameters.positionManagementProfile, hardStopAlwaysActive: true, hardTargetAlwaysActive: true, dynamicExitEnabled: false },
      frozenChampionModified: false
    },
    breakout: {
      signalKey,
      signalBarTimestamp,
      signalBarClosedAt,
      signalBarAvailable,
      signalAgeMs: now - signalBarClosedAt,
      isDecisionBoundary: signalBarAvailable,
      isExactWallClockBoundary,
      lookback4h: parameters.breakoutLookback4h, priorHigh: round(priorHigh, 2), priorLow: round(priorLow, 2),
      atr4h: round(atr4h, 6), longBreakoutDistanceAtr: round(longBreakoutDistanceAtr, 6), shortBreakoutDistanceAtr: round(shortBreakoutDistanceAtr, 6),
      longTrend, shortTrend
    },
    bullishReasons: longTrend ? ["4h EMA50 趋势向上"] : [],
    bearishReasons: shortTrend ? ["4h EMA50 趋势向下"] : []
  };
}
