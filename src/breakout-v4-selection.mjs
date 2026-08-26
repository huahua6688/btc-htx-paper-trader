import { ema } from "./indicators.mjs";
import { BREAKOUT_V4_PARAMETERS } from "./breakout-challenger.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { CAPITAL_PROFILES, runHistoricalReplay } from "./replay-engine.mjs";
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

export const BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC = Object.freeze({
  ...BREAKOUT_V4_DEVELOPMENT_SPEC,
  schemaVersion: 2,
  developmentRange: Object.freeze({
    from: "2020-10-21T16:00:00.000Z",
    to: BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.to
  }),
  executionModel: Object.freeze({
    ...BREAKOUT_V4_DEVELOPMENT_SPEC.executionModel,
    minimumRiskReward: PAPER_CONFIG.minimumRiskReward
  }),
  confirmationPolicy: "Proxy candidates that cannot meet the Paper net-RR gate are ineligible. The selected winner must still be rerun through the exact Paper replay core with timestamp-visible Funding and production costs before it is reported as executable evidence.",
  holdoutPolicy: "Only the extended pre-cutoff development catalog is read. No post-cutoff or immature holdout value may enter feature, trade, metric or winner selection."
});

export const BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC = Object.freeze({
  ...BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC,
  schemaVersion: 3,
  selectionEngine: "EXACT_PAPER_CONTINUOUS_REPLAY_WITH_CHRONOLOGICAL_TRADE_SEGMENTS",
  executionModel: Object.freeze({
    strategy: "breakout-v4",
    signal: "completed 4h bar only",
    entry: "BREAKOUT_V4_FIRST_OBSERVATION_V1; next visible 15m open",
    executionDelayBars: 1,
    eventStride: 1,
    costs: "PAPER_CONFIG fees, slippage and timestamp-visible Funding",
    capitalProfile: CAPITAL_PROFILES.PRODUCTION_FAITHFUL,
    initialCapitalCny: PAPER_CONFIG.initialCapitalCny,
    portfolio: Object.freeze({ maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false }),
    forceCloseAtDevelopmentEnd: true
  }),
  eligibility: Object.freeze({
    minimumTrades: 40,
    minimumTradesPerChronologicalSegment: 8,
    chronologicalSegments: 4,
    minimumPositiveSegments: 3,
    minimumFullProfitFactor: 1.05,
    maximumFullDrawdownPct: 25,
    maximumSinglePositiveSegmentSharePct: 70
  }),
  selectionOrder: Object.freeze([
    "eligible exact-Paper candidates before ineligible candidates",
    "more positive chronological development segments",
    "higher worst-segment exact-Paper net return",
    "lower concentration in the single best positive segment",
    "higher full-development exact-Paper profit factor",
    "higher full-development exact-Paper net return",
    "lower full-development exact-Paper maximum drawdown",
    "lexicographically smaller parameter hash as deterministic tie-break"
  ]),
  confirmationPolicy: "Every grid candidate is executed through the exact Paper replay core. If no candidate passes all predeclared stability gates, the program returns no winner; it never promotes the least-bad candidate.",
  holdoutPolicy: "The exact-Paper selector creates a cutoff-filtered in-memory dataset before replay. No post-cutoff candle, Funding, auxiliary series or multi-venue observation is passed to any candidate, and the immature holdout registry is never opened."
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
  const minimumRiskReward = Number(spec.executionModel.minimumRiskReward);
  const trades = [];
  let netRrRejectedSignals = 0;
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
      const stop = round(entry - direction * signal.riskDistance, 2);
      const target = round(entry + direction * signal.riskDistance * candidate.parameters.targetRiskMultiple, 2);
      const stopDistancePct = Math.abs(stop / entry - 1) * 100;
      const targetDistancePct = Math.abs(target / entry - 1) * 100;
      const proxyNetRr = (targetDistancePct - costPct) / (stopDistancePct + costPct);
      if (Number.isFinite(minimumRiskReward) && (!(proxyNetRr >= minimumRiskReward))) {
        netRrRejectedSignals += 1;
        continue;
      }
      position = {
        side: signal.side,
        openedAt: timestamp,
        signalBarTimestamp: signal.signalBarTimestamp,
        entry,
        stop,
        target
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
  return {
    ...candidate,
    metrics: {
      ...summarizeTrades(trades, spec, start, end),
      netRrRejectedSignals,
      minimumRiskReward: Number.isFinite(minimumRiskReward) ? minimumRiskReward : null
    }
  };
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

function timestampOf(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function cutoffVisibleRows(rows, cutoff) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((item) => {
    const visibleAt = timestampOf(item?.visibleAt ?? item?.eventTime ?? item?.timestamp);
    return visibleAt !== null && visibleAt <= cutoff;
  });
}

export function exactPaperDevelopmentDataset(dataset, spec = BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC) {
  if (!Array.isArray(dataset?.candles)) throw new Error("Breakout V4 exact-Paper selection requires catalog candles");
  const start = new Date(spec.developmentRange.from).getTime();
  const cutoff = new Date(spec.developmentRange.to).getTime();
  const candles = dataset.candles.filter((item) => {
    const timestamp = timestampOf(item?.timestamp);
    return timestamp !== null && timestamp >= start && timestamp + BAR_MS <= cutoff;
  });
  if (!candles.length) throw new Error("No completed exact-Paper development candles before the fixed cutoff");
  const series = Object.fromEntries(Object.entries(dataset.series ?? {}).map(([key, rows]) => [key, cutoffVisibleRows(rows, cutoff)]));
  const multiVenueFunding = cutoffVisibleRows(dataset.multiVenueFunding ?? dataset.multiVenue?.funding ?? [], cutoff);
  return {
    ...dataset,
    manifest: {
      ...(dataset.manifest ?? {}),
      requestedCoverage: {
        from: spec.developmentRange.from,
        to: new Date(cutoff - BAR_MS).toISOString()
      }
    },
    candles,
    funding: cutoffVisibleRows(dataset.funding ?? [], cutoff),
    series,
    multiVenueFunding,
    multiVenue: dataset.multiVenue ? { ...dataset.multiVenue, funding: multiVenueFunding } : dataset.multiVenue
  };
}

function paperProfitFactor(netResults) {
  const profits = netResults.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(netResults.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return losses > 0 ? round(profits / losses, 8) : profits > 0 ? Number.MAX_SAFE_INTEGER : 0;
}

function paperSegmentMetrics(trades, initialCapitalCny, index) {
  const netResults = trades.map((trade) => Number(trade.net_pnl_cny ?? 0));
  const netPnlCny = netResults.reduce((sum, value) => sum + value, 0);
  const grossPnlCny = trades.reduce((sum, trade) => sum + Number(trade.gross_pnl_cny ?? 0), 0);
  const profitFactor = paperProfitFactor(netResults);
  return {
    index,
    tradeCount: trades.length,
    wins: netResults.filter((value) => value > 0).length,
    netPnlCny: round(netPnlCny, 8),
    netReturnPct: round(netPnlCny / initialCapitalCny * 100, 8),
    grossPnlCny: round(grossPnlCny, 8),
    totalCostsCny: round(grossPnlCny - netPnlCny, 8),
    profitFactor,
    expectancyCny: trades.length ? round(netPnlCny / trades.length, 8) : 0,
    positive: netPnlCny > 0 && profitFactor > 1
  };
}

export function summarizeExactPaperCandidate(replay, spec = BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC) {
  const start = timestampOf(replay.effectiveRange?.from) ?? new Date(spec.developmentRange.from).getTime();
  const end = timestampOf(replay.effectiveRange?.to) ?? new Date(spec.developmentRange.to).getTime();
  const segmentTrades = Array.from({ length: spec.eligibility.chronologicalSegments }, () => []);
  for (const trade of replay.trades ?? []) {
    const openedAt = timestampOf(trade.opened_at);
    if (openedAt === null || openedAt < start || openedAt > end) continue;
    segmentTrades[segmentIndex(openedAt, start, end, segmentTrades.length)].push(trade);
  }
  const initialCapitalCny = Number(replay.capital?.initialCapitalCny ?? spec.executionModel.initialCapitalCny);
  const segments = segmentTrades.map((trades, index) => paperSegmentMetrics(trades, initialCapitalCny, index));
  const positiveSegmentPnl = segments.filter((item) => item.netPnlCny > 0).map((item) => item.netPnlCny);
  const totalPositiveSegmentPnl = positiveSegmentPnl.reduce((sum, value) => sum + value, 0);
  const largestPositiveSegmentSharePct = totalPositiveSegmentPnl > 0
    ? round(Math.max(...positiveSegmentPnl) / totalPositiveSegmentPnl * 100, 8)
    : 100;
  const performance = replay.performance ?? {};
  const tradeCount = Number(performance.totalTrades ?? replay.tradeCount ?? 0);
  const rawProfitFactor = Number(performance.profitFactor ?? 0);
  const profitFactor = Number.isFinite(rawProfitFactor) ? rawProfitFactor : Number.MAX_SAFE_INTEGER;
  const maxDrawdownPct = Number(performance.maxDrawdownPct ?? 0);
  const positiveSegments = segments.filter((item) => item.positive).length;
  const eligibilityReasons = [];
  if (tradeCount < spec.eligibility.minimumTrades) eligibilityReasons.push("MINIMUM_TRADES_NOT_MET");
  if (segments.some((item) => item.tradeCount < spec.eligibility.minimumTradesPerChronologicalSegment)) eligibilityReasons.push("MINIMUM_TRADES_PER_SEGMENT_NOT_MET");
  if (positiveSegments < spec.eligibility.minimumPositiveSegments) eligibilityReasons.push("MINIMUM_POSITIVE_SEGMENTS_NOT_MET");
  if (!(profitFactor >= spec.eligibility.minimumFullProfitFactor)) eligibilityReasons.push("MINIMUM_FULL_PROFIT_FACTOR_NOT_MET");
  if (!(maxDrawdownPct <= spec.eligibility.maximumFullDrawdownPct)) eligibilityReasons.push("MAXIMUM_FULL_DRAWDOWN_EXCEEDED");
  if (!(largestPositiveSegmentSharePct <= spec.eligibility.maximumSinglePositiveSegmentSharePct)) eligibilityReasons.push("SINGLE_SEGMENT_PROFIT_CONCENTRATION_EXCEEDED");
  return {
    executionMode: "EXACT_PAPER",
    eligible: eligibilityReasons.length === 0,
    eligibilityReasons,
    tradeCount,
    wins: Number(performance.wins ?? 0),
    netReturnPct: Number(performance.cumulativeReturnPct ?? 0),
    netPnlCny: Number(performance.cumulativePnlCny ?? 0),
    profitFactor,
    expectancyCny: Number(performance.expectancyCny ?? 0),
    tradeSharpe: performance.tradeSharpe ?? null,
    maxDrawdownPct,
    totalCostsCny: Number(performance.totalCostsCny ?? 0),
    positiveSegments,
    worstSegmentNetReturnPct: round(Math.min(...segments.map((item) => item.netReturnPct)), 8),
    largestPositiveSegmentSharePct,
    entryRejections: replay.entryRejections ?? null,
    portfolioLimits: replay.portfolioLimits ?? null,
    segments
  };
}

function rankExactPaperCandidates(left, right) {
  const a = left.metrics;
  const b = right.metrics;
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.positiveSegments !== b.positiveSegments) return b.positiveSegments - a.positiveSegments;
  if (a.worstSegmentNetReturnPct !== b.worstSegmentNetReturnPct) return b.worstSegmentNetReturnPct - a.worstSegmentNetReturnPct;
  if (a.largestPositiveSegmentSharePct !== b.largestPositiveSegmentSharePct) return a.largestPositiveSegmentSharePct - b.largestPositiveSegmentSharePct;
  if (a.profitFactor !== b.profitFactor) return b.profitFactor - a.profitFactor;
  if (a.netReturnPct !== b.netReturnPct) return b.netReturnPct - a.netReturnPct;
  if (a.maxDrawdownPct !== b.maxDrawdownPct) return a.maxDrawdownPct - b.maxDrawdownPct;
  return left.parameterHash.localeCompare(right.parameterHash);
}

export async function runBreakoutV4ExactPaperDevelopmentSelection(dataset, {
  spec = BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC,
  candidates = breakoutV4CandidateGrid(spec),
  replayRunner = runHistoricalReplay,
  onProgress = null
} = {}) {
  if (!candidates.length) throw new Error("Breakout V4 exact-Paper selection requires at least one candidate");
  const developmentDataset = exactPaperDevelopmentDataset(dataset, spec);
  const developmentStart = new Date(spec.developmentRange.from).getTime();
  const developmentEnd = new Date(spec.developmentRange.to).getTime();
  const evaluated = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const replay = await replayRunner(developmentDataset, {
      strategy: "breakout-v4",
      parameters: candidate.parameters,
      from: new Date(developmentStart).toISOString(),
      to: new Date(developmentEnd - BAR_MS).toISOString(),
      eventStride: spec.executionModel.eventStride,
      executionDelayBars: spec.executionModel.executionDelayBars,
      collectTrace: false,
      forceCloseAtEnd: spec.executionModel.forceCloseAtDevelopmentEnd,
      capitalProfile: spec.executionModel.capitalProfile,
      portfolio: spec.executionModel.portfolio
    });
    evaluated.push({
      ...candidate,
      metrics: summarizeExactPaperCandidate(replay, spec)
    });
    onProgress?.({ completed: index + 1, total: candidates.length, parameterHash: candidate.parameterHash });
  }
  const ranked = evaluated.sort(rankExactPaperCandidates).map((item, index) => ({ rank: index + 1, ...item }));
  const winner = ranked.find((item) => item.metrics.eligible) ?? null;
  const expectedWinner = hashObject(BREAKOUT_V4_PARAMETERS);
  const candidateSummary = (item) => item ? {
    rank: item.rank,
    parameters: item.parameters,
    parameterHash: item.parameterHash,
    metrics: item.metrics,
    matchesCommittedBreakoutV4: item.parameterHash === expectedWinner
  } : null;
  const result = {
    schemaVersion: 1,
    runType: "BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_ONLY_PARAMETER_SELECTION",
    selectionStatus: winner ? "ELIGIBLE_WINNER_FOUND" : "NO_ELIGIBLE_WINNER",
    strategyRoleAfterSelection: "RESEARCH_SHADOW_CANDIDATE",
    championChanged: false,
    spec,
    specHash: hashObject(spec),
    datasetManifestHash: dataset.manifest?.manifestHash ?? null,
    isolation: {
      holdoutOpened: false,
      postCutoffOutcomeFieldsRead: false,
      developmentCutoff: spec.developmentRange.to,
      maximumCandleOpenRead: new Date(developmentDataset.candles.at(-1).timestamp).toISOString(),
      maximumCandleVisibleAtRead: new Date(developmentDataset.candles.at(-1).timestamp + BAR_MS).toISOString(),
      fundingRowsPassedToReplay: developmentDataset.funding.length,
      maximumFundingTimestampRead: developmentDataset.funding.length
        ? new Date(Math.max(...developmentDataset.funding.map((item) => timestampOf(item.timestamp)))).toISOString()
        : null
    },
    search: {
      candidateCount: ranked.length,
      exactPaperCandidateCount: ranked.length,
      candidateGridHash: hashObject(candidates.map((item) => item.parameterHash)),
      eligibleCandidateCount: ranked.filter((item) => item.metrics.eligible).length,
      rankingPolicy: spec.selectionOrder
    },
    winner: candidateSummary(winner),
    bestObservedCandidate: candidateSummary(ranked[0]),
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
