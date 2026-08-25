import { PAPER_CONFIG } from "./config.mjs";
import { atr, ema } from "./indicators.mjs";
import { closedMarketView, coreDataQuality } from "./research-challenger-v2.mjs";
import { hashObject, round } from "./research-utils.mjs";

const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * HOUR_MS;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

// Execution safety is deliberately outside BREAKOUT_V4_PARAMETERS so the
// frozen research parameter hash and selection record do not change.  Shadow
// and Replay both use the first observation at/after the completed 4h close,
// reference the price visible at that observation, and reject delayed recovery
// signals instead of pretending they were filled hours earlier.
export const BREAKOUT_V4_ENTRY_TIMING_CONTRACT = Object.freeze({
  version: "BREAKOUT_V4_FIRST_OBSERVATION_V1",
  signalClock: "COMPLETED_4H_CANDLE_CLOSE",
  executionClock: "FIRST_ELIGIBLE_OBSERVATION_AT_OR_AFTER_SIGNAL_CLOSE",
  fillReference: "PRICE_VISIBLE_AT_EXECUTION_OBSERVATION",
  replayObservation: "NEXT_15M_OPEN",
  maximumSignalAgeMs: 5 * 60 * 1000
});

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

export function resolveBreakoutV4Execution({
  signalBarClosedAt,
  observationTimestamp,
  fillReferencePrice,
  observationSource
}) {
  const signalClosedAt = Number(signalBarClosedAt);
  const executionTimestamp = Number(observationTimestamp);
  const price = Number(fillReferencePrice);
  if (![signalClosedAt, executionTimestamp, price].every(Number.isFinite) || signalClosedAt <= 0 || executionTimestamp <= 0 || price <= 0) {
    throw new Error("Breakout V4 execution requires valid signal close, observation time and fill-reference price");
  }
  const signalAgeMs = executionTimestamp - signalClosedAt;
  const signalFresh = signalAgeMs >= 0 && signalAgeMs <= BREAKOUT_V4_ENTRY_TIMING_CONTRACT.maximumSignalAgeMs;
  return {
    contractVersion: BREAKOUT_V4_ENTRY_TIMING_CONTRACT.version,
    signalBarClosedAt: signalClosedAt,
    executionTimestamp,
    entryBarTimestamp: Math.floor(executionTimestamp / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS,
    fillReferencePrice: price,
    fillReferenceSource: observationSource,
    signalAgeMs,
    maximumSignalAgeMs: BREAKOUT_V4_ENTRY_TIMING_CONTRACT.maximumSignalAgeMs,
    signalFresh,
    eligible: signalFresh
  };
}

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
    derivatives: { fundingRatePct, fundingSource, oiUsd: null, pressureScore: null },
    historicalCompatibility: { compatible: true, usesOnlyPointInTimeFeatures: true, futureDataFilled: false },
    safety: { apiKeyUsed: false, privateEndpointUsed: false, exchangeWriteEnabled: false, paperTradingOnly: true }
  };
}

export function analyzeBreakoutChallenger(market, parameters = BREAKOUT_V4_PARAMETERS, config = PAPER_CONFIG) {
  const now = Number(market.ticker?.ts);
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(now > 0) || !(currentPrice > 0)) throw new Error("Breakout V4 requires point-in-time market time and price");
  const visibleMarket = closedMarketView(market);
  const h15 = rows(visibleMarket.kline15m);
  const h4 = rows(visibleMarket.kline4h);
  const h1 = rows(visibleMarket.kline1h);
  const d1 = rows(visibleMarket.kline1d);
  const minimum = Math.max(parameters.breakoutLookback4h + 1, parameters.trendEma4h + parameters.trendSlopeBars4h + 1, parameters.atrPeriod4h + 2);
  if (h4.length < minimum || h1.length < 20) throw new Error("Breakout V4 completed candle history is too short");
  const fundingRatePct = finite(visibleMarket.fundingCurrent?.data?.funding_rate)
    ? Number(visibleMarket.fundingCurrent.data.funding_rate) * 100
    : null;
  const base = waitReportBase(now, currentPrice, parameters, fundingRatePct, visibleMarket.fundingCurrent?.data?.source ?? "UNAVAILABLE_NOT_FILLED");
  const dataQuality = coreDataQuality(visibleMarket, { frames: {
    "15m": { candles: h15 }, "1h": { candles: h1 }, "4h": { candles: h4 }, "1d": { candles: d1 }
  } });
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
  const execution = resolveBreakoutV4Execution({
    signalBarClosedAt,
    observationTimestamp: now,
    fillReferencePrice: currentPrice,
    observationSource: market.replay?.pointInTime ? "REPLAY_OBSERVATION_PRICE" : "SHADOW_TICKER_PRICE"
  });
  const longBreakoutDistanceAtr = atr4h > 0 ? (latest.close - priorHigh) / atr4h : 0;
  const shortBreakoutDistanceAtr = atr4h > 0 ? (priorLow - latest.close) / atr4h : 0;
  const requireSlope = parameters.trendFilter !== "EMA50_PRICE_ALIGNMENT";
  const longTrend = latest.close > trendNow && (!requireSlope || trendNow > trendPrior);
  const shortTrend = latest.close < trendNow && (!requireSlope || trendNow < trendPrior);
  const longBreakout = signalBarAvailable && latest.close > priorHigh && longTrend && longBreakoutDistanceAtr >= parameters.minimumBreakoutAtr;
  const shortBreakout = signalBarAvailable && latest.close < priorLow && shortTrend && shortBreakoutDistanceAtr >= parameters.minimumBreakoutAtr;
  const longSignal = longBreakout && execution.eligible;
  const shortSignal = shortBreakout && execution.eligible;
  const candidateDecision = longSignal ? "LONG" : shortSignal ? "SHORT" : "WAIT";
  const decision = candidateDecision !== "WAIT" && dataQuality.validForEntry ? candidateDecision : "WAIT";
  const direction = decision === "LONG" ? 1 : decision === "SHORT" ? -1 : 0;
  const riskDistance = atr4h * parameters.stopAtrMultiple;
  const stopLoss = direction ? currentPrice - direction * riskDistance : null;
  const takeProfit = direction ? currentPrice + direction * riskDistance * parameters.targetRiskMultiple : null;
  const longSupport = (longTrend ? 30 : 0) + clamp(longBreakoutDistanceAtr * 25, 0, 25) + (longSignal ? 25 : 0);
  const shortSupport = (shortTrend ? 30 : 0) + clamp(shortBreakoutDistanceAtr * 25, 0, 25) + (shortSignal ? 25 : 0);
  const longScore = clamp(20 + longSupport - (shortTrend ? 20 : 0), 0, 100);
  const shortScore = clamp(20 + shortSupport - (longTrend ? 20 : 0), 0, 100);
  const riskPct = direction ? config.reducedRiskPerTradePct : 0;
  const staleBreakout = (longBreakout || shortBreakout) && !execution.signalFresh;
  const reason = candidateDecision !== "WAIT" && !dataQuality.validForEntry
    ? `核心数据质量阻止入场：${dataQuality.failures.join("；")}`
    : staleBreakout
    ? "完整 4h 突破信号已超过 5 分钟执行窗口，禁止服务恢复后补开旧信号"
    : candidateDecision === "WAIT"
    ? "最近完整 4h signal bar 尚未突破前高/前低并满足 EMA50 斜率"
    : `${parameters.breakoutLookback4h} 根4h区间突破，EMA${parameters.trendEma4h}方向一致`;
  return {
    ...base,
    decision,
    candidateDecision,
    riskGates: dataQuality.failures,
    dataQuality,
    execution,
    entryTimingContract: BREAKOUT_V4_ENTRY_TIMING_CONTRACT,
    latest15mBar: h15.length ? h15.at(-1) : null,
    completed15mBar: h15.length ? h15.at(-1) : null,
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
      enterNow: Boolean(direction), method: direction ? "4H_DONCHIAN_BREAKOUT"
        : candidateDecision !== "WAIT" && !dataQuality.validForEntry ? "WAIT_CORE_DATA_QUALITY" : "WAIT_4H_BREAKOUT",
      methodLabel: reason, reasons: [reason], missingConditions: direction ? [] : [...new Set([...dataQuality.failures, reason])], riskPct,
      signalKey: direction ? signalKey : null,
      signalBarTimestamp,
      signalBarClosedAt,
      executionTimestamp: direction ? execution.executionTimestamp : null,
      entryBarTimestamp: direction ? execution.entryBarTimestamp : null,
      fillReferencePrice: direction ? execution.fillReferencePrice : null,
      fillReferenceSource: direction ? execution.fillReferenceSource : null,
      signalAgeMs: execution.signalAgeMs,
      maximumSignalAgeMs: execution.maximumSignalAgeMs
    },
    opportunities: {
      LONG: { side: "LONG", score: round(longScore, 2), opportunityScore: round(longScore, 2), directionalScore: round(longScore, 2), timingScore: longSignal ? 85 : 20, supportingReasons: longTrend ? ["4h EMA50 向上且价格在其上"] : [], opposingReasons: shortTrend ? ["4h 趋势向下"] : [] },
      SHORT: { side: "SHORT", score: round(shortScore, 2), opportunityScore: round(shortScore, 2), directionalScore: round(shortScore, 2), timingScore: shortSignal ? 85 : 20, supportingReasons: shortTrend ? ["4h EMA50 向下且价格在其下"] : [], opposingReasons: longTrend ? ["4h 趋势向上"] : [] }
    },
    scores: { longOpportunity: round(longScore, 2), shortOpportunity: round(shortScore, 2), scoreGap: round(Math.abs(longScore - shortScore), 2), independent: true },
    timeframes: {
      "15m": { close: h15.at(-1)?.close ?? null, atr14: null },
      "1h": { close: h1.at(-1)?.close ?? null, atr14: round(atr1h, 6) },
      "4h": { close: h4.at(-1)?.close ?? null, atr14: round(atr4h, 6), ema50: round(trendNow, 4), ema50Slope: round(trendNow - trendPrior, 6), priorHigh: round(priorHigh, 2), priorLow: round(priorLow, 2) },
      "1d": { close: d1.at(-1)?.close ?? null, atr14: null }
    },
    strategy: {
      version: parameters.version,
      marketRegime: longTrend ? "4H_UPTREND" : shortTrend ? "4H_DOWNTREND" : "4H_NEUTRAL",
      bias: candidateDecision,
      state: direction ? "ENTER_NOW" : "WAIT",
      riskPct,
      riskTier: "REDUCED",
      hardBlocks: dataQuality.failures, softWarnings: direction ? [] : [reason], entryMethod: direction ? "4H_DONCHIAN_BREAKOUT" : "WAIT",
      positionManagementProfile: parameters.positionManagementProfile,
      managementContract: { profile: parameters.positionManagementProfile, hardStopAlwaysActive: true, hardTargetAlwaysActive: true, dynamicExitEnabled: false },
      frozenChampionModified: false
    },
    breakout: {
      signalKey,
      signalBarTimestamp,
      signalBarClosedAt,
      signalBarAvailable,
      signalAgeMs: execution.signalAgeMs,
      maximumSignalAgeMs: execution.maximumSignalAgeMs,
      signalFresh: execution.signalFresh,
      staleBreakout,
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
