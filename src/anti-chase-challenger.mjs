import { analyzeHistoricalCompatible, HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { hashObject, mean, round } from "./research-utils.mjs";

const INTERVALS = Object.freeze({ kline15m: 15 * 60_000, kline1h: 60 * 60_000, kline4h: 4 * 60 * 60_000, kline1d: 24 * 60 * 60_000 });
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export const ANTI_CHASE_PARAMETERS = Object.freeze({
  ...HISTORICAL_COMPATIBLE_PARAMETERS,
  version: "anti-chase-ohlcv-v1",
  maximumExtensionAtr: 1.25,
  maximumImpulseAtr: 2,
  extremeRangePosition: 0.90,
  breakoutVolumeRatio: 1.20,
  maximumBreakoutExtensionAtr: 0.80,
  retestToleranceAtr: 0.35,
  recoveryDistanceAtr: 0.60,
  minimumStructuralRoomR: 2,
  minimumNetRoomPct: 0.20,
  uncertaintyBufferPct: 0.08
});

function payloadRows(payload) {
  return [...(payload?.data ?? [])].map((item) => ({
    ...item,
    timestamp: Number(item.id) * 1000,
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close),
    volume: Number(item.amount ?? item.vol ?? 0)
  })).filter((item) => [item.timestamp, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function trimMarketToClosedCandles(market) {
  const visibleAt = Number(market?.ticker?.ts);
  if (!(visibleAt > 0)) throw new Error("Anti-Chase requires a point-in-time ticker timestamp");
  // Shallow-copy only the candle payloads we trim. Replay calls this tens of
  // thousands of times; cloning the entire market (including every raw row)
  // adds minutes without improving isolation.
  const output = { ...market };
  for (const [key, interval] of Object.entries(INTERVALS)) {
    const source = market[key] ?? {};
    output[key] = {
      ...source,
      data: (source.data ?? []).filter((item) => Number(item.id) * 1000 + interval <= visibleAt)
    };
  }
  return output;
}

function volumeRatio(candles) {
  const current = candles.at(-1)?.volume;
  const prior = candles.slice(-21, -1).map((item) => item.volume);
  const average = mean(prior);
  return average > 0 ? current / average : 0;
}

function nearestStructuralRoom(side, currentPrice, candles1h, atr1h) {
  const levels = candles1h.slice(-80, -1).flatMap((item) => side === "LONG" ? [item.high] : [item.low]);
  const candidates = levels.filter((value) => side === "LONG" ? value > currentPrice : value < currentPrice)
    .sort((a, b) => a - b);
  if (candidates.length) {
    // A single old wick a few dollars away is not a meaningful target. Use a
    // conservative inner quartile of visible levels as a robust structure cluster.
    const index = side === "LONG"
      ? Math.floor((candidates.length - 1) * 0.25)
      : Math.ceil((candidates.length - 1) * 0.75);
    const level = candidates[index];
    return { distance: Math.abs(level - currentPrice), level, source: "VISIBLE_1H_STRUCTURE_CLUSTER" };
  }
  return { distance: atr1h * 1.5, level: null, source: "ATR_RESEARCH_FALLBACK_NOT_A_KNOWN_LEVEL" };
}

export function evaluateEntryGeometry(report, market, parameters = ANTI_CHASE_PARAMETERS, config = PAPER_CONFIG) {
  const side = ["LONG", "SHORT"].includes(report.decision) ? report.decision : report.candidateDecision;
  if (!["LONG", "SHORT"].includes(side)) return {
    side: null, eligible: false, blocked: false, entryType: "NO_DIRECTION", reasons: ["方向核心当前为 WAIT"]
  };
  const direction = side === "LONG" ? 1 : -1;
  const currentPrice = Number(report.currentPrice);
  const candles15m = payloadRows(market.kline15m);
  const candles1h = payloadRows(market.kline1h);
  const atr15m = Number(report.timeframes?.["15m"]?.atr14);
  const atr1h = Number(report.timeframes?.["1h"]?.atr14);
  const ema1h = Number(report.timeframes?.["1h"]?.ema20);
  if (!(currentPrice > 0) || !(atr15m > 0) || !(atr1h > 0) || !(ema1h > 0) || candles15m.length < 25 || candles1h.length < 25) {
    return { side, eligible: false, blocked: true, entryType: "INSUFFICIENT_GEOMETRY", reasons: ["闭合K线不足，无法可靠判断是否追价"] };
  }

  const last = candles15m.at(-1);
  const impulseStart = candles15m.at(-5)?.close ?? last.open;
  const extensionAtr = direction * (currentPrice - ema1h) / atr1h;
  const impulseAtr = direction * (last.close - impulseStart) / atr15m;
  const prior = candles15m.slice(-21, -1);
  const priorHigh = Math.max(...prior.map((item) => item.high));
  const priorLow = Math.min(...prior.map((item) => item.low));
  const rangePosition = priorHigh > priorLow ? clamp((currentPrice - priorLow) / (priorHigh - priorLow), 0, 1) : 0.5;
  const breakoutLevel = side === "LONG" ? priorHigh : priorLow;
  const brokeOnLastClosedBar = side === "LONG" ? last.close > priorHigh : last.close < priorLow;
  const latestVolumeRatio = volumeRatio(candles15m);
  const distanceFromBreakoutAtr = Math.abs(currentPrice - breakoutLevel) / atr15m;
  const remainsBeyondBreakout = side === "LONG" ? currentPrice >= breakoutLevel : currentPrice <= breakoutLevel;
  const validFreshBreakout = brokeOnLastClosedBar
    && remainsBeyondBreakout
    && latestVolumeRatio >= parameters.breakoutVolumeRatio
    && extensionAtr <= parameters.maximumBreakoutExtensionAtr
    && distanceFromBreakoutAtr <= parameters.maximumBreakoutExtensionAtr;
  const validRetest = remainsBeyondBreakout
    && distanceFromBreakoutAtr <= parameters.retestToleranceAtr
    && direction * (last.close - last.open) >= 0;
  const recoveryNearMean = Math.abs(currentPrice - ema1h) / atr1h <= parameters.recoveryDistanceAtr
    && direction * (last.close - last.open) > 0;

  const extremePosition = side === "LONG"
    ? rangePosition >= parameters.extremeRangePosition
    : rangePosition <= 1 - parameters.extremeRangePosition;
  const extensionStretched = extensionAtr > parameters.maximumExtensionAtr;
  const impulseStretched = impulseAtr > parameters.maximumImpulseAtr;
  // No ordinary input gets a mechanical veto. A chase block requires a cluster:
  // extended from the mean + fast impulse + an extreme location, without price confirmation.
  const clusteredChase = extensionStretched && impulseStretched && extremePosition;
  const extensionBlocked = clusteredChase && !validFreshBreakout && !validRetest && !recoveryNearMean;

  const stop = Number(report.plan?.stopLoss);
  const riskDistance = Number.isFinite(stop) ? Math.abs(currentPrice - stop) : null;
  const room = nearestStructuralRoom(side, currentPrice, candles1h, atr1h);
  const grossRoomPct = room.distance / currentPrice * 100;
  const feePct = config.feeRatePerSide * 2 * 100;
  const slippagePct = config.slippageRate * 2 * 100;
  const currentFundingPct = Number(report.derivatives?.fundingRatePct);
  const fundingPct = Number.isFinite(currentFundingPct) ? Math.max(0, direction * currentFundingPct) : 0;
  const chaseUncertaintyPct = parameters.uncertaintyBufferPct + Math.max(0, extensionAtr - 0.5) * 0.05;
  const netRoomPct = grossRoomPct - feePct - slippagePct - fundingPct - chaseUncertaintyPct;
  const structuralRoomR = riskDistance > 0 ? room.distance / riskDistance : null;
  const roomBlocked = room.source === "VISIBLE_1H_STRUCTURE_CLUSTER"
    && netRoomPct < parameters.minimumNetRoomPct
    && (extensionStretched || impulseStretched || extremePosition);
  const reasons = [];
  if (extensionBlocked) reasons.push(`当前价格沿${side === "LONG" ? "上涨" : "下跌"}方向距离1h EMA20达 ${round(extensionAtr, 2)} ATR，禁止追价`);
  if (roomBlocked) reasons.push(`扣除成本和不确定性后，最近可见1h结构簇前仅剩 ${round(netRoomPct, 3)}%，不值得追单`);
  const blocked = extensionBlocked || roomBlocked;
  const entryType = validFreshBreakout ? "FRESH_BREAKOUT_WITH_ROOM"
    : validRetest ? "BREAKOUT_RETEST"
      : recoveryNearMean ? "MEAN_RECOVERY"
        : blocked ? "WAIT_NOT_CHASE" : "BALANCED_DIRECT";
  return {
    side,
    eligible: !blocked,
    blocked,
    entryType,
    extensionAtr: round(extensionAtr, 4),
    impulseAtr: round(impulseAtr, 4),
    rangePositionPct: round(rangePosition * 100, 2),
    latestVolumeRatio: round(latestVolumeRatio, 3),
    breakoutLevel: round(breakoutLevel, 2),
    distanceFromBreakoutAtr: round(distanceFromBreakoutAtr, 4),
    validFreshBreakout,
    validRetest,
    recoveryNearMean,
    extensionStretched,
    impulseStretched,
    extremePosition,
    clusteredChase,
    structuralRoomSource: room.source,
    structuralLevel: room.level === null ? null : round(room.level, 2),
    grossRoomPct: round(grossRoomPct, 6),
    estimatedFeePct: round(feePct, 6),
    estimatedSlippagePct: round(slippagePct, 6),
    estimatedFundingPct: round(fundingPct, 6),
    uncertaintyBufferPct: round(chaseUncertaintyPct, 6),
    netRemainingRoomPct: round(netRoomPct, 6),
    structuralRoomR: structuralRoomR === null ? null : round(structuralRoomR, 4),
    reasons: reasons.length ? reasons : [validFreshBreakout
      ? "突破仍新鲜、量能有效且价格未明显远离突破位"
      : validRetest ? "突破后回测仍守住结构，当前不是盲目追价"
        : recoveryNearMean ? "价格靠近1h均值后恢复原方向"
          : "当前价格延伸、冲量和结构剩余空间未触发追价拦截"]
  };
}

export function analyzeAntiChaseChallenger(market, parameters = ANTI_CHASE_PARAMETERS, config = PAPER_CONFIG, options = {}) {
  const closedMarket = trimMarketToClosedCandles(market);
  // Direction remains the historical-compatible core. Entry timing is deliberately
  // evaluated from the lower signal threshold so a pullback can enter after the
  // immediate-momentum condition has cooled, instead of buying only at peak score.
  const report = analyzeHistoricalCompatible(closedMarket, {
    ...parameters,
    immediateThreshold: parameters.signalThreshold
  }, config, options);
  const directionDecision = report.candidateDecision;
  const preAntiChaseDecision = report.decision;
  const geometry = evaluateEntryGeometry(report, closedMarket, parameters, config);
  const allowed = ["LONG", "SHORT"].includes(preAntiChaseDecision) && geometry.eligible;
  report.mode = "ANTI_CHASE_SHADOW_PAPER_ONLY";
  report.version = parameters.version;
  report.strategyHash = hashObject(parameters);
  report.directionDecision = directionDecision;
  report.preAntiChaseDecision = preAntiChaseDecision;
  report.entryQuality = geometry;
  report.decision = allowed ? preAntiChaseDecision : "WAIT";
  report.candidateDecision = directionDecision;
  report.entryAssessment = {
    ...report.entryAssessment,
    enterNow: allowed,
    method: allowed ? geometry.entryType : "WAIT_NOT_CHASE",
    methodLabel: allowed ? geometry.reasons[0] : "方向可能成立，但当前价格不值得追",
    reasons: allowed ? [...geometry.reasons, ...(report.entryAssessment?.reasons ?? [])].slice(0, 5) : geometry.reasons,
    missingConditions: allowed ? [] : [...new Set([...(report.entryAssessment?.missingConditions ?? []), ...geometry.reasons])]
  };
  report.strategy = {
    ...report.strategy,
    version: parameters.version,
    baseStrategyVersion: HISTORICAL_COMPATIBLE_PARAMETERS.version,
    state: allowed ? "ENTER_NOW" : "WAIT",
    entryMethod: report.entryAssessment.method,
    antiChaseGate: { allowed, parametersHash: report.strategyHash }
  };
  if (!allowed) {
    report.hypotheticalPlanBeforeAntiChase = structuredClone(report.plan);
    report.plan = { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null };
    if (["LONG", "SHORT"].includes(preAntiChaseDecision)) report.riskGates = [...(report.riskGates ?? []), `ANTI_CHASE: ${geometry.reasons.join("；")}`];
  }
  report.historicalCompatibility = {
    ...report.historicalCompatibility,
    closedCandlesOnly: true,
    antiChaseInputs: ["closed OHLCV", "timestamp-valid Funding", "ATR-normalized extension", "visible support/resistance"]
  };
  return report;
}
