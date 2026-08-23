import { mean, round, standardDeviation } from "./research-utils.mjs";

const SCORE_BINS = Object.freeze([[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]]);
const HOLDING_BINS = Object.freeze([
  [0, 60, "<1h"], [60, 240, "1-4h"], [240, 720, "4-12h"],
  [720, 1_440, "12-24h"], [1_440, 4_320, "1-3d"], [4_320, Infinity, ">3d"]
]);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scoreBin(value) {
  const score = Number(value);
  const bin = SCORE_BINS.find(([minimum, maximum]) => score >= minimum && score < maximum);
  return bin ? `${bin[0]}-${bin[1] === 101 ? 100 : bin[1]}` : "UNKNOWN";
}

function holdingBin(value) {
  const minutes = Number(value);
  return HOLDING_BINS.find(([minimum, maximum]) => minutes >= minimum && minutes < maximum)?.[2] ?? "UNKNOWN";
}

function profitFactor(values) {
  const profits = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  return losses > 0 ? profits / losses : profits > 0 ? Infinity : null;
}

function summarize(rows) {
  const gross = rows.map((item) => Number(item.grossPnlCny));
  const net = rows.map((item) => Number(item.netPnlCny));
  const grossPct = rows.map((item) => Number(item.grossEdgePct)).filter(Number.isFinite);
  const netPct = rows.map((item) => Number(item.netEdgePct)).filter(Number.isFinite);
  const deviation = standardDeviation(netPct);
  const averageNetPct = mean(netPct) ?? 0;
  const lower95 = netPct.length && deviation !== null
    ? averageNetPct - 1.96 * deviation / Math.sqrt(netPct.length)
    : null;
  const fees = rows.reduce((sum, item) => sum + Number(item.feesCny), 0);
  const slippage = rows.reduce((sum, item) => sum + Number(item.slippageCny), 0);
  const funding = rows.reduce((sum, item) => sum + Number(item.fundingCny), 0);
  const costs = rows.reduce((sum, item) => sum + Number(item.totalCostsCny), 0);
  return {
    trades: rows.length,
    wins: rows.filter((item) => Number(item.netPnlCny) > 0).length,
    winRatePct: rows.length ? round(rows.filter((item) => Number(item.netPnlCny) > 0).length / rows.length * 100, 2) : 0,
    grossPnlCny: round(gross.reduce((sum, value) => sum + value, 0), 4),
    grossEdgeCnyPerTrade: round(mean(gross) ?? 0, 4),
    grossEdgePctPerTrade: round(mean(grossPct) ?? 0, 6),
    grossProfitFactor: round(profitFactor(gross), 4),
    feesCny: round(fees, 4),
    slippageCny: round(slippage, 4),
    fundingCny: round(funding, 4),
    totalCostsCny: round(costs, 4),
    costCnyPerTrade: round(rows.length ? costs / rows.length : 0, 4),
    costPctOfGrossAbs: round(Math.abs(gross.reduce((sum, value) => sum + value, 0)) > 0
      ? costs / Math.abs(gross.reduce((sum, value) => sum + value, 0)) * 100 : null, 4),
    netPnlCny: round(net.reduce((sum, value) => sum + value, 0), 4),
    netExpectancyCny: round(mean(net) ?? 0, 4),
    netExpectancyPct: round(averageNetPct, 6),
    netExpectancyPctLower95: round(lower95, 6),
    netProfitFactor: round(profitFactor(net), 4),
    averageMfePct: round(mean(rows.map((item) => Number(item.mfePct))) ?? 0, 4),
    medianMfePct: round(median(rows.map((item) => Number(item.mfePct))), 4),
    averageMaePct: round(mean(rows.map((item) => Number(item.maePct))) ?? 0, 4),
    medianMaePct: round(median(rows.map((item) => Number(item.maePct))), 4),
    averageHoldingMinutes: round(mean(rows.map((item) => Number(item.holdingMinutes))) ?? 0, 2)
  };
}

function group(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const key = selector(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarize(values)]));
}

const DIMENSIONS = Object.freeze({
  side: { eligibleAtEntry: true, selector: (row) => row.side },
  marketRegime: { eligibleAtEntry: true, selector: (row) => row.marketRegime },
  opportunityScore: { eligibleAtEntry: true, selector: (row) => scoreBin(row.opportunityScore) },
  holdingTime: { eligibleAtEntry: false, selector: (row) => holdingBin(row.holdingMinutes) },
  entryType: { eligibleAtEntry: true, selector: (row) => row.entryType },
  exitType: { eligibleAtEntry: false, selector: (row) => row.exitType },
  sideRegime: { eligibleAtEntry: true, selector: (row) => `${row.side}|${row.marketRegime}` },
  regimeScore: { eligibleAtEntry: true, selector: (row) => `${row.marketRegime}|${scoreBin(row.opportunityScore)}` }
});

function windowRows(rows, window) {
  const start = new Date(window.testStart).getTime();
  const end = new Date(window.testEnd).getTime();
  return rows.filter((row) => {
    const timestamp = new Date(row.closedAt).getTime();
    return timestamp >= start && timestamp <= end;
  });
}

function stableSubsets(rows, windows) {
  const output = [];
  for (const [dimension, definition] of Object.entries(DIMENSIONS)) {
    const aggregateGroups = group(rows, definition.selector);
    for (const [value, aggregate] of Object.entries(aggregateGroups)) {
      const perWindow = windows.map((window) => {
        const selected = windowRows(rows, window).filter((row) => definition.selector(row) === value);
        return { index: window.index, ...summarize(selected) };
      });
      const evaluable = perWindow.filter((item) => item.trades >= 5);
      const positive = evaluable.filter((item) => item.netExpectancyPct > 0 && Number(item.netProfitFactor ?? 0) > 1).length;
      const reasons = [];
      if (!definition.eligibleAtEntry) reasons.push("post-outcome dimension; forbidden as an entry rule");
      if (aggregate.trades < 30) reasons.push("fewer than 30 OOS trades");
      if (evaluable.length < 3) reasons.push("fewer than 3 windows with at least 5 trades");
      if (positive < 3) reasons.push("positive net expectancy/PF in fewer than 3 windows");
      if (!(aggregate.netExpectancyPctLower95 > 0)) reasons.push("95% lower confidence bound is not positive");
      if (!(Number(aggregate.netProfitFactor ?? 0) >= 1.05)) reasons.push("aggregate net PF below 1.05");
      output.push({
        dimension, value, eligibleAtEntry: definition.eligibleAtEntry,
        stablePositiveOos: reasons.length === 0,
        reasons, aggregate, positiveWindows: positive, evaluableWindows: evaluable.length, perWindow
      });
    }
  }
  return output.sort((a, b) => Number(b.stablePositiveOos) - Number(a.stablePositiveOos)
    || b.aggregate.netExpectancyPct - a.aggregate.netExpectancyPct);
}

export function buildTradeAttribution(replay, { windows = [] } = {}) {
  const rows = replay.tradeContexts ?? [];
  if (rows.length !== replay.tradeCount) throw new Error("Replay tradeContexts are missing or incomplete; rerun replay with attribution support");
  const dimensions = Object.fromEntries(Object.entries(DIMENSIONS).map(([key, definition]) => [key, {
    eligibleAtEntry: definition.eligibleAtEntry,
    groups: group(rows, definition.selector)
  }]));
  const stability = windows.length ? stableSubsets(rows, windows) : [];
  return {
    schemaVersion: 1,
    runType: "FEATURE_TRADE_COST_ATTRIBUTION",
    strategyVersion: replay.strategyVersion,
    strategyHash: replay.strategyHash,
    dataManifestHash: replay.dataManifestHash,
    range: replay.requestedRange,
    overall: summarize(rows),
    costAttribution: {
      grossPnlCny: summarize(rows).grossPnlCny,
      feesCny: summarize(rows).feesCny,
      slippageCny: summarize(rows).slippageCny,
      fundingCny: summarize(rows).fundingCny,
      totalCostsCny: summarize(rows).totalCostsCny,
      netPnlCny: summarize(rows).netPnlCny,
      grossEdgeSurvivedCosts: summarize(rows).netPnlCny > 0
    },
    dimensions,
    stabilityPolicy: windows.length ? {
      minimumTrades: 30,
      minimumEvaluableWindows: 3,
      minimumTradesPerWindow: 5,
      minimumPositiveWindows: 3,
      minimumNetProfitFactor: 1.05,
      positiveLower95Required: true,
      postOutcomeDimensionsForbiddenForEntry: true
    } : null,
    stableSubsets: stability.filter((item) => item.stablePositiveOos),
    allSubsetTests: stability,
    caveat: "Holding time and exit type are outcomes, not point-in-time entry features. They may diagnose lifecycle behavior but may not be converted into entry filters."
  };
}

export { scoreBin, holdingBin, summarize as summarizeAttribution };
