import { deriveMarketRegime, summarizeTimeframe } from "./analysis-engine.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { hashObject, round } from "./research-utils.mjs";

export const CHALLENGER_BASE_PARAMETERS = Object.freeze({
  version: "challenger-technical-v1",
  signalThreshold: 12,
  immediateThreshold: 18,
  stopAtrMultiple: 1.45,
  targetRiskMultiple: 2.8,
  trendWeight15m: 0.2,
  trendWeight1h: 0.35,
  trendWeight4h: 0.35,
  trendWeight1d: 0.1,
  regimeFilterEnabled: true,
  minimumAdxTrending: 18
});

export const HISTORICAL_FEATURE_SETS = Object.freeze({
  OHLC: Object.freeze({ includeVolume: false, includeFunding: false }),
  OHLCV: Object.freeze({ includeVolume: true, includeFunding: false }),
  OHLCV_FUNDING: Object.freeze({ includeVolume: true, includeFunding: true })
});

export const HISTORICAL_COMPATIBLE_PARAMETERS = Object.freeze({
  ...CHALLENGER_BASE_PARAMETERS,
  version: "historical-compatible-ohlcv-v1",
  featureSet: "OHLCV",
  fundingContrarianScale: 2
});

function candlePayload(payload) { return payload?.data ?? []; }
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const timeframeCache = new Map();

function frameCacheKey(now, currentPrice) { return `${now}:${currentPrice}`; }

export function hasChallengerFrameCache(now, currentPrice) {
  return timeframeCache.has(frameCacheKey(now, currentPrice));
}

function cachedTimeframes(market, now, currentPrice, useCache) {
  const cacheKey = frameCacheKey(now, currentPrice);
  const existing = useCache ? timeframeCache.get(cacheKey) : null;
  if (existing) return existing;
  const compact = (payload, label) => {
    const { candles, ...summary } = summarizeTimeframe(payload, label);
    const volumeSignalScore = summary.signals
      .filter((item) => item.label.includes("当前量能"))
      .reduce((sum, item) => sum + Number(item.score), 0);
    return { ...summary, volumeSignalScore, ohlcScore: round(summary.score - volumeSignalScore, 1) };
  };
  const value = {
    "15m": compact(market.kline15m, "15m"),
    "1h": compact(market.kline1h, "1h"),
    "4h": compact(market.kline4h, "4h"),
    "1d": compact(market.kline1d, "1d")
  };
  if (useCache) {
    timeframeCache.set(cacheKey, value);
    if (timeframeCache.size > 100_000) timeframeCache.delete(timeframeCache.keys().next().value);
  }
  return value;
}

export function analyzeChallenger(market, parameters = CHALLENGER_BASE_PARAMETERS, config = PAPER_CONFIG, { useCache = true } = {}) {
  const now = Number(market.ticker?.ts);
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(now > 0) || !(currentPrice > 0)) throw new Error("Challenger requires a point-in-time ticker");
  const timeframes = cachedTimeframes(market, now, currentPrice, useCache);
  const featureSet = parameters.featureSet ?? "LEGACY_CHALLENGER";
  const featureDefinition = HISTORICAL_FEATURE_SETS[featureSet] ?? { includeVolume: true, includeFunding: false };
  const scoreFor = (value) => featureDefinition.includeVolume ? value.score : value.ohlcScore;
  const candleScore = scoreFor(timeframes["15m"]) * parameters.trendWeight15m
    + scoreFor(timeframes["1h"]) * parameters.trendWeight1h
    + scoreFor(timeframes["4h"]) * parameters.trendWeight4h
    + scoreFor(timeframes["1d"]) * parameters.trendWeight1d;
  const funding = Number(market.fundingCurrent?.data?.funding_rate);
  const fundingAdjustment = featureDefinition.includeFunding && Number.isFinite(funding)
    ? clamp(-funding / 0.0001 * Number(parameters.fundingContrarianScale ?? 2), -8, 8)
    : 0;
  const signed = clamp(candleScore + fundingAdjustment, -100, 100);
  const regime = deriveMarketRegime(timeframes);
  const trendEligible = !parameters.regimeFilterEnabled
    || regime !== "RANGE"
    || Math.abs(signed) >= parameters.immediateThreshold + 5;
  const candidateDecision = Math.abs(signed) >= parameters.signalThreshold
    ? (signed > 0 ? "LONG" : "SHORT")
    : "WAIT";
  const side = candidateDecision;
  const direction = side === "LONG" ? 1 : -1;
  const closed15m = candlePayload(market.kline15m).slice(0, -1).at(-1);
  const alignedTimeframes = ["15m", "1h", "4h"].filter((name) => direction * scoreFor(timeframes[name]) > 0).length;
  const alignmentEligible = alignedTimeframes >= Number(parameters.minimumAlignedTimeframes ?? 0);
  const candleConfirmed = !parameters.require15mCandleConfirmation
    || direction * (Number(closed15m.close) - Number(closed15m.open)) > 0;
  const roundTripCostPct = 2 * (Number(config.feeRatePerSide) + Number(config.slippageRate)) * 100;
  const atrToCost = round((Number(timeframes["1h"].atr14) / currentPrice * 100) / roundTripCostPct, 4);
  const costBufferEligible = atrToCost >= Number(parameters.minimumAtrToRoundTripCost ?? 0);
  const decision = trendEligible
    && alignmentEligible
    && candleConfirmed
    && costBufferEligible
    && Math.abs(signed) >= parameters.immediateThreshold ? candidateDecision : "WAIT";
  const recent = candlePayload(market.kline15m).slice(-10, -1);
  const structural = side === "LONG"
    ? Math.min(...recent.map((row) => Number(row.low)))
    : Math.max(...recent.map((row) => Number(row.high)));
  const atrDistance = Number(timeframes["1h"].atr14) * parameters.stopAtrMultiple;
  const volatilityStop = currentPrice - direction * atrDistance;
  let stopLoss = side === "LONG" ? Math.min(structural, volatilityStop) : Math.max(structural, volatilityStop);
  const maximumStopDistance = currentPrice * 0.04;
  if (Math.abs(currentPrice - stopLoss) > maximumStopDistance) stopLoss = currentPrice - direction * maximumStopDistance;
  const riskDistance = Math.abs(currentPrice - stopLoss);
  const takeProfit = currentPrice + direction * riskDistance * parameters.targetRiskMultiple;
  const longScore = round(clamp(50 + signed, 0, 100), 1);
  const shortScore = round(clamp(50 - signed, 0, 100), 1);
  const selectedScore = side === "LONG" ? longScore : shortScore;
  const reasons = [
    `15m/1h/4h/1d 加权技术分 ${round(candleScore, 1)}`,
    ...(featureDefinition.includeFunding ? [`Funding 时点调整 ${round(fundingAdjustment, 2)}`] : []),
    `4h 市场状态 ${regime}`,
    `${side === "LONG" ? "做多" : "做空"}方向分 ${selectedScore}`,
    `止损按近期结构与 1h ATR ${parameters.stopAtrMultiple} 倍共同确定`,
    Number.isFinite(funding) ? `使用当时可见 Funding ${(funding * 100).toFixed(4)}% 估算成本` : "该时点 Funding 不可用，不进行回填"
  ];
  const missingConditions = decision === "WAIT"
    ? [
        ...(Math.abs(signed) < parameters.signalThreshold ? ["多空加权优势不足"] : []),
        ...(Math.abs(signed) < parameters.immediateThreshold ? ["当前机会尚未达到立即入场阈值"] : []),
        ...(!trendEligible ? ["震荡环境下方向强度不足"] : []),
        ...(!alignmentEligible ? [`15m/1h/4h 同向层数 ${alignedTimeframes} 不足`] : []),
        ...(!candleConfirmed ? ["最近已收盘 15m K线未确认当前方向"] : []),
        ...(!costBufferEligible ? [`1h ATR/往返成本缓冲 ${atrToCost} 不足`] : [])
      ]
    : [];
  const latestBar = {
    timestamp: Number(closed15m.id) * 1000,
    open: Number(closed15m.open), high: Number(closed15m.high), low: Number(closed15m.low), close: Number(closed15m.close)
  };
  const opportunity = (opportunitySide) => ({
    side: opportunitySide,
    score: opportunitySide === "LONG" ? longScore : shortScore,
    directionalScore: opportunitySide === "LONG" ? longScore : shortScore,
    timingScore: opportunitySide === side ? selectedScore : 100 - selectedScore,
    supportingReasons: opportunitySide === side ? reasons : [`加权证据不支持${opportunitySide === "LONG" ? "做多" : "做空"}`],
    opposingReasons: opportunitySide === side ? missingConditions : reasons.slice(0, 2)
  });
  return {
    version: parameters.version,
    strategyHash: hashObject(parameters),
    mode: "RESEARCH_CHALLENGER_PAPER_ONLY",
    featureSet,
    symbol: "BTC-USDT",
    generatedAt: new Date(now).toISOString(),
    decision,
    candidateDecision,
    riskGates: [],
    confidencePct: round(clamp(50 + Math.abs(signed), 50, 90), 0),
    finalScore: round(signed * 2, 1),
    currentPrice: round(currentPrice, 2),
    latest15mBar: latestBar,
    completed15mBar: latestBar,
    plan: decision === "WAIT" ? { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null } : {
      entryPrice: round(currentPrice, 2),
      stopLoss: round(stopLoss, 2),
      takeProfit: [round(takeProfit, 2)],
      riskReward: [parameters.targetRiskMultiple]
    },
    entryAssessment: {
      enterNow: decision !== "WAIT",
      method: "DYNAMIC_TECHNICAL_NOW",
      methodLabel: "历史时点技术结构达到动态立即入场条件",
      reasons,
      missingConditions,
      riskPct: decision !== "WAIT" && selectedScore >= 75 ? config.maxRiskPerTradePct : config.reducedRiskPerTradePct
    },
    opportunities: { LONG: opportunity("LONG"), SHORT: opportunity("SHORT") },
    strategy: {
      version: parameters.version,
      featureSet,
      entryFilters: {
        alignedTimeframes,
        minimumAlignedTimeframes: Number(parameters.minimumAlignedTimeframes ?? 0),
        candleConfirmed,
        atrToRoundTripCost: atrToCost,
        minimumAtrToRoundTripCost: Number(parameters.minimumAtrToRoundTripCost ?? 0)
      },
      marketRegime: regime,
      bias: candidateDecision,
      state: decision === "WAIT" ? "WAIT" : "ENTER_NOW",
      riskPct: decision !== "WAIT" && selectedScore >= 75 ? config.maxRiskPerTradePct : config.reducedRiskPerTradePct,
      riskTier: selectedScore >= 75 ? "NORMAL" : "REDUCED",
      hardBlocks: [], softWarnings: [], entryMethod: "DYNAMIC_TECHNICAL_NOW"
    },
    scores: {
      technical: round(signed, 1),
      candleTechnical: round(candleScore, 1),
      fundingAdjustment: round(fundingAdjustment, 2),
      derivativesDirectional: null, derivativesPressure: null,
      longOpportunity: longScore, shortOpportunity: shortScore, scoreGap: round(Math.abs(signed) * 2, 1)
    },
    timeframes: Object.fromEntries(Object.entries(timeframes).map(([key, value]) => [key, {
      score: value.score, close: value.close, ema20: value.ema20, ema50: value.ema50,
      ema20SlopePct: value.ema20SlopePct, rsi14: value.rsi14, atr14: value.atr14,
      adx14: value.adx14, macdHistogram: value.macdHistogram, momentum20Pct: value.momentum20Pct,
      volumeRatio: value.volumeRatio
    }])),
    derivatives: {
      fundingRatePct: Number.isFinite(funding) ? funding * 100 : null,
      fundingSource: market.fundingCurrent?.data?.source ?? "UNAVAILABLE_NO_BACKFILL",
      fundingObservationAgeMs: Number(market.fundingCurrent?.data?.age_ms ?? 0),
      oiUsd: null,
      pressureScore: null
    },
    bullishReasons: side === "LONG" ? reasons : [],
    bearishReasons: side === "SHORT" ? reasons : [],
    dataQuality: { validForEntry: true, failures: [] },
    dataCoverage: { available: ["point-in-time closed 15m/1h/4h/1d candles", "historical Funding when timestamped"], limitations: market.replay?.unavailableSources ?? [] }
  };
}

export function analyzeHistoricalCompatible(market, parameters = HISTORICAL_COMPATIBLE_PARAMETERS, config = PAPER_CONFIG, options = {}) {
  const featureSet = parameters.featureSet ?? "OHLCV";
  if (!HISTORICAL_FEATURE_SETS[featureSet]) throw new Error(`Unknown historical-compatible feature set: ${featureSet}`);
  const report = analyzeChallenger(market, parameters, config, options);
  report.mode = "HISTORICAL_COMPATIBLE_PAPER_ONLY";
  report.historicalCompatibility = {
    compatible: true,
    featureSet,
    usesOnlyPointInTimeFeatures: true,
    allowedSources: featureSet === "OHLCV_FUNDING" ? ["HTX historical OHLCV", "HTX timestamped historical Funding"] : ["HTX historical OHLCV"],
    forbiddenAndAbsent: ["historical Order Book", "historical OI", "historical liquidations", "historical elite positioning", "historical Mark/Basis"]
  };
  return report;
}
