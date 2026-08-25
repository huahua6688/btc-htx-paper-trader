import { ema } from "./indicators.mjs";
import { BREAKOUT_V4_PARAMETERS } from "./breakout-challenger.mjs";
import { hashObject, round } from "./research-utils.mjs";

const BAR_MS = 15 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export const BREAKOUT_V4_DEVELOPMENT_SPEC = Object.freeze({
  schemaVersion: 1,
  strategy: "breakout-v4",
  role: "RESEARCH_SHADOW_CANDIDATE",
  developmentRange: {
    from: "2024-09-01T00:00:00.000Z",
    to: "2026-01-17T06:30:00.000Z"
  },
  candidateSearchSpace: {
    breakoutLookback4h: [20, 40, 60, 80],
    stopAtrMultiple: [1.5, 2, 2.5, 3],
    targetRiskMultiple: [2, 3, 4, 5],
    trendFilter: ["EMA50_DIRECTION_SLOPE", "EMA50_PRICE_ALIGNMENT"]
  },
  fixedParameters: {
    trendEma4h: 50,
    trendSlopeBars4h: 6,
    atrPeriod4h: 14,
    positionManagementProfile: "HARD_BRACKET_HOLD_V1"
  },
  executionModel: {
    metricScale: "UNIT_NOTIONAL_UNLEVERED_PRICE_RETURN_NOT_PAPER_ACCOUNT_PNL",
    signal: "completed 4h bar only",
    entry: "next 15m open",
    exit: "hard stop/target; same 15m bar uses adverse stop first",
    roundTripCostPct: 0.14,
    forceCloseAtDevelopmentEnd: true
  },
  confirmationPolicy: "The selected winner must be rerun separately through the exact Paper replay core; proxy selection returns are not reported as account performance.",
  eligibility: {
    minimumTrades: 12,
    minimumTradesPerChronologicalSegment: 1,
    chronologicalSegments: 4
  },
  selectionOrder: [
    "eligible candidates before ineligible candidates",
    "more positive chronological development segments",
    "higher worst-segment net return",
    "higher full-development profit factor",
    "higher full-development net return",
    "lexicographically smaller parameter hash as deterministic tie-break"
  ],
  holdoutPolicy: "No post-cutoff OHLCV value may enter feature, trade, metric or winner selection; this program does not open the immature holdout registry."
});

export function breakoutV4CandidateGrid(spec = BREAKOUT_V4_DEVELOPMENT_SPEC) {
  const output = [];
  for (const breakoutLookback4h of spec.candidateSearchSpace.breakoutLookback4h) {
    for (const stopAtrMultiple of spec.candidateSearchSpace.stopAtrMultiple) {
      for (const targetRiskMultiple of spec.candidateSearchSpace.targetRiskMultiple) {
        for (const trendFilter of spec.candidateSearchSpace.trendFilter) {
          const parameters = {
            ...BREAKOUT_V4_PARAMETERS,
            breakoutLookback4h,
            stopAtrMultiple,
            targetRiskMultiple,
            trendFilter
          };
          output.push({ parameters, parameterHash: hashObject(parameters) });
        }
      }
    }
  }
  return output;
}

function aggregateCompleted4h(candles) {
  const groups = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(Number(candle.timestamp) / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const rows = groups.get(bucket) ?? [];
    rows.push(candle);
    groups.set(bucket, rows);
  }
  const output = [];
  for (const [timestamp, rows] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.timestamp - b.timestamp);
    const complete = rows.length === 16
      && rows.every((row, index) => Number(row.timestamp) === timestamp + index * BAR_MS);
    if (!complete) continue;
    output.push({
      timestamp,
      closedAt: timestamp + FOUR_HOURS_MS,
      open: Number(rows[0].open),
      high: Math.max(...rows.map((item) => Number(item.high))),
      low: Math.min(...rows.map((item) => Number(item.low))),
      close: Number(rows.at(-1).close)
    });
  }
  return output;
}

function signalsFor(h4, parameters, developmentStart, developmentEnd) {
  const closes = h4.map((item) => item.close);
  const trend = ema(closes, parameters.trendEma4h);
  const trueRanges = h4.map((item, index) => index === 0
    ? item.high - item.low
    : Math.max(item.high - item.low, Math.abs(item.high - h4[index - 1].close), Math.abs(item.low - h4[index - 1].close)));
  const atrLine = ema(trueRanges, parameters.atrPeriod4h);
  const signals = new Map();
  const minimum = Math.max(
    parameters.breakoutLookback4h + 1,
    parameters.trendEma4h + parameters.trendSlopeBars4h + 1,
    parameters.atrPeriod4h + 2
  );
  for (let index = minimum - 1; index < h4.length; index += 1) {
    const latest = h4[index];
    if (latest.closedAt < developmentStart || latest.closedAt > developmentEnd) continue;
    const prior = h4.slice(index - parameters.breakoutLookback4h, index);
    const priorHigh = Math.max(...prior.map((item) => item.high));
    const priorLow = Math.min(...prior.map((item) => item.low));
    const trendNow = trend[index];
    const trendPrior = trend[index - parameters.trendSlopeBars4h];
    const requireSlope = parameters.trendFilter !== "EMA50_PRICE_ALIGNMENT";
    const longTrend = latest.close > trendNow && (!requireSlope || trendNow > trendPrior);
    const shortTrend = latest.close < trendNow && (!requireSlope || trendNow < trendPrior);
    const riskAtr = atrLine[index];
    if (!(riskAtr > 0)) continue;
    const side = latest.close > priorHigh && longTrend
      ? "LONG"
      : latest.close < priorLow && shortTrend ? "SHORT" : null;
    if (side) signals.set(latest.closedAt, { side, riskDistance: riskAtr * parameters.stopAtrMultiple, signalBarTimestamp: latest.timestamp });
  }
  return signals;
}

function segmentIndex(timestamp, start, end, count) {
  const width = (end - start + 1) / count;
  return Math.min(count - 1, Math.max(0, Math.floor((timestamp - start) / width)));
}

function summarizeTrades(trades, spec, start, end) {
  const segmentReturns = Array.from({ length: spec.eligibility.chronologicalSegments }, () => []);
  for (const trade of trades) segmentReturns[segmentIndex(trade.openedAt, start, end, segmentReturns.length)].push(trade.netReturnPct);
  const segments = segmentReturns.map((returns, index) => ({
    index,
    tradeCount: returns.length,
    netReturnPct: round(returns.reduce((sum, value) => sum + value, 0), 8),
    positive: returns.reduce((sum, value) => sum + value, 0) > 0
  }));
  const profits = trades.filter((item) => item.netReturnPct > 0).reduce((sum, item) => sum + item.netReturnPct, 0);
  const losses = Math.abs(trades.filter((item) => item.netReturnPct < 0).reduce((sum, item) => sum + item.netReturnPct, 0));
  const eligible = trades.length >= spec.eligibility.minimumTrades
    && segments.every((item) => item.tradeCount >= spec.eligibility.minimumTradesPerChronologicalSegment);
  return {
    eligible,
    tradeCount: trades.length,
    wins: trades.filter((item) => item.netReturnPct > 0).length,
    netReturnPct: round(trades.reduce((sum, item) => sum + item.netReturnPct, 0), 8),
    grossReturnPct: round(trades.reduce((sum, item) => sum + item.grossReturnPct, 0), 8),
    profitFactor: losses > 0 ? round(profits / losses, 8) : profits > 0 ? Number.MAX_SAFE_INTEGER : 0,
    positiveSegments: segments.filter((item) => item.positive).length,
    worstSegmentNetReturnPct: round(Math.min(...segments.map((item) => item.netReturnPct)), 8),
    segments
  };
}

function simulateCandidate(candles, h4, candidate, spec, start, end) {
  const signals = signalsFor(h4, candidate.parameters, start, end);
  const costPct = spec.executionModel.roundTripCostPct;
  const trades = [];
  let position = null;
  for (const candle of candles) {
    const timestamp = Number(candle.timestamp);
    if (timestamp < start || timestamp + BAR_MS > end) continue;
    if (position) {
      const stopHit = position.side === "LONG" ? Number(candle.low) <= position.stop : Number(candle.high) >= position.stop;
      const targetHit = position.side === "LONG" ? Number(candle.high) >= position.target : Number(candle.low) <= position.target;
      if (stopHit || targetHit) {
        const exit = stopHit ? position.stop : position.target;
        const direction = position.side === "LONG" ? 1 : -1;
        const grossReturnPct = direction * (exit / position.entry - 1) * 100;
        trades.push({ ...position, closedAt: timestamp + BAR_MS, exit, exitReason: stopHit ? "SL" : "TP", grossReturnPct, netReturnPct: grossReturnPct - costPct });
        position = null;
      }
    }
    const signal = signals.get(timestamp);
    if (!position && signal) {
      const direction = signal.side === "LONG" ? 1 : -1;
      const entry = Number(candle.open);
      position = {
        side: signal.side,
        openedAt: timestamp,
        signalBarTimestamp: signal.signalBarTimestamp,
        entry,
        stop: round(entry - direction * signal.riskDistance, 2),
        target: round(entry + direction * signal.riskDistance * candidate.parameters.targetRiskMultiple, 2)
      };
    }
  }
  if (position && candles.length) {
    const last = candles.findLast((item) => Number(item.timestamp) + BAR_MS <= end);
    if (last) {
      const exit = Number(last.close);
      const direction = position.side === "LONG" ? 1 : -1;
      const grossReturnPct = direction * (exit / position.entry - 1) * 100;
      trades.push({ ...position, closedAt: Number(last.timestamp) + BAR_MS, exit, exitReason: "DEVELOPMENT_END", grossReturnPct, netReturnPct: grossReturnPct - costPct });
    }
  }
  return { ...candidate, metrics: summarizeTrades(trades, spec, start, end) };
}

function rankCandidates(left, right) {
  const a = left.metrics;
  const b = right.metrics;
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.positiveSegments !== b.positiveSegments) return b.positiveSegments - a.positiveSegments;
  if (a.worstSegmentNetReturnPct !== b.worstSegmentNetReturnPct) return b.worstSegmentNetReturnPct - a.worstSegmentNetReturnPct;
  if (a.profitFactor !== b.profitFactor) return b.profitFactor - a.profitFactor;
  if (a.netReturnPct !== b.netReturnPct) return b.netReturnPct - a.netReturnPct;
  return left.parameterHash.localeCompare(right.parameterHash);
}

export function runBreakoutV4DevelopmentSelection(dataset, { spec = BREAKOUT_V4_DEVELOPMENT_SPEC } = {}) {
  const developmentStart = new Date(spec.developmentRange.from).getTime();
  const developmentEnd = new Date(spec.developmentRange.to).getTime();
  if (!Array.isArray(dataset?.candles)) throw new Error("Breakout V4 selection requires catalog candles");
  // Only completed candles at or before the fixed cutoff expose OHLCV to the
  // simulator.  Post-cutoff values are never copied into this array.
  const developmentCandles = dataset.candles.filter((item) => {
    const timestamp = Number(item.timestamp);
    return timestamp >= developmentStart && timestamp + BAR_MS <= developmentEnd;
  }).map((item) => ({
    timestamp: Number(item.timestamp),
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close)
  }));
  if (!developmentCandles.length) throw new Error("No completed development candles before the fixed cutoff");
  const h4 = aggregateCompleted4h(developmentCandles);
  const grid = breakoutV4CandidateGrid(spec);
  const ranked = grid.map((candidate) => simulateCandidate(
    developmentCandles, h4, candidate, spec, developmentStart, developmentEnd
  )).sort(rankCandidates).map((item, index) => ({ rank: index + 1, ...item }));
  const winner = ranked[0];
  const expectedWinner = hashObject(BREAKOUT_V4_PARAMETERS);
  const result = {
    schemaVersion: 1,
    runType: "BREAKOUT_V4_DEVELOPMENT_ONLY_PARAMETER_SELECTION",
    strategyRoleAfterSelection: "RESEARCH_SHADOW_CANDIDATE",
    championChanged: false,
    spec,
    specHash: hashObject(spec),
    datasetManifestHash: dataset.manifest?.manifestHash ?? null,
    isolation: {
      holdoutOpened: false,
      postCutoffOutcomeFieldsRead: false,
      developmentCutoff: spec.developmentRange.to,
      maximumCandleOpenRead: new Date(developmentCandles.at(-1).timestamp).toISOString(),
      maximumCandleVisibleAtRead: new Date(developmentCandles.at(-1).timestamp + BAR_MS).toISOString()
    },
    search: {
      candidateCount: ranked.length,
      candidateGridHash: hashObject(grid.map((item) => item.parameterHash)),
      eligibleCandidateCount: ranked.filter((item) => item.metrics.eligible).length,
      rankingPolicy: spec.selectionOrder
    },
    winner: {
      rank: winner.rank,
      parameters: winner.parameters,
      parameterHash: winner.parameterHash,
      metrics: winner.metrics,
      matchesCommittedBreakoutV4: winner.parameterHash === expectedWinner
    },
    candidates: ranked.map((item) => ({
      rank: item.rank,
      parameters: {
        breakoutLookback4h: item.parameters.breakoutLookback4h,
        stopAtrMultiple: item.parameters.stopAtrMultiple,
        targetRiskMultiple: item.parameters.targetRiskMultiple,
        trendFilter: item.parameters.trendFilter
      },
      parameterHash: item.parameterHash,
      metrics: item.metrics
    }))
  };
  result.selectionHash = hashObject({ ...result, selectionHash: undefined });
  return result;
}
