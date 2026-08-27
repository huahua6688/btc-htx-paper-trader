import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeChallenger,
  analyzeHistoricalCompatible,
  CHALLENGER_BASE_PARAMETERS,
  HISTORICAL_COMPATIBLE_PARAMETERS
} from "../src/challenger-strategy.mjs";
import { buildTradeAttribution } from "../src/attribution-engine.mjs";
import { ANTI_CHASE_PARAMETERS } from "../src/anti-chase-challenger.mjs";
import { generateDiagnosisCandidates } from "../src/edge-candidate-pipeline.mjs";
import { runCounterfactualReview } from "../src/counterfactual-review.mjs";
import { auditExternalMarketFeatures } from "../src/external-features.mjs";
import { loadHistoricalDataset, updateHistoricalDataset } from "../src/historical-data.mjs";
import {
  evaluateV4RobustnessEvidence,
  repriceObservedTrades,
  robustnessParameterPerturbations,
  runMonteCarloRobustness
} from "../src/monte-carlo.mjs";
import { buildPointInTimeMarket } from "../src/replay-market.mjs";
import { runChampionChallengerComparison, runHistoricalReplay } from "../src/replay-engine.mjs";
import { buildHistoricalFeatureMatrix, queryHistoricalSimilarity } from "../src/similarity-engine.mjs";
import { runLookaheadAudit } from "../src/validation-engine.mjs";
import { markHoldoutUsed, openHoldoutForSelectedCandidate, sealUntouchedHoldout } from "../src/holdout-manager.mjs";
import { calculateForwardPath, TRADABLE_EDGE_HORIZONS } from "../src/forward-path-labels.mjs";
import {
  applyTradableEdgeGate,
  estimateTradableEdgeForState,
  pointInTimeEdgeState,
  trainTradableEdgeModel
} from "../src/tradable-edge.mjs";
import { updateCollectingHoldout } from "../src/holdout-manager.mjs";
import { analyzeResearchChallengerV2 } from "../src/research-challenger-v2.mjs";

const BAR_MS = 15 * 60 * 1000;

function syntheticDataset(days = 120) {
  const start = Date.UTC(2025, 0, 1);
  const count = days * 96;
  const candles = [];
  let previous = 50_000;
  for (let index = 0; index < count; index += 1) {
    const regime = index < count / 3 ? 1 : index < count * 2 / 3 ? -0.7 : 0.15;
    const movement = regime * 20 + Math.sin(index / 13) * 120 + Math.sin(index / 97) * 50;
    const close = Math.max(10_000, previous + movement);
    candles.push({
      timestamp: start + index * BAR_MS,
      open: previous,
      high: Math.max(previous, close) + 150,
      low: Math.min(previous, close) - 150,
      close,
      volumeBtc: 100 + Math.abs(Math.sin(index / 9)) * 50,
      volumeContracts: 100_000,
      turnoverUsdt: close * 100,
      trades: 100
    });
    previous = close;
  }
  const funding = [];
  for (let timestamp = start; timestamp <= candles.at(-1).timestamp + BAR_MS; timestamp += 8 * 60 * 60 * 1000) {
    funding.push({ timestamp, fundingRate: Math.sin(timestamp / 1e9) * 0.0001, averagePremiumIndex: 0, rateField: "funding_rate" });
  }
  return {
    manifest: {
      datasetId: "synthetic-test-only",
      manifestHash: "synthetic-manifest",
      requestedCoverage: { from: new Date(start).toISOString(), to: new Date(candles.at(-1).timestamp).toISOString() },
      actualCoverage: { from: new Date(start).toISOString(), to: new Date(candles.at(-1).timestamp).toISOString() }
    },
    candles,
    funding
  };
}

function response(payload) { return { ok: true, json: async () => payload }; }

test("Research V2 live-style reports expose the completed 15m bar required by the Paper freshness gate", () => {
  const dataset = syntheticDataset(75);
  const market = buildPointInTimeMarket(dataset.candles, dataset.funding, dataset.candles.length - 1);
  const report = analyzeResearchChallengerV2(market, undefined, undefined, { useCache: false });
  assert.ok(report.latest15mBar?.timestamp);
  assert.equal(report.completed15mBar?.timestamp, report.latest15mBar.timestamp);
});

test("historical Dataset Manager downloads fixed public ranges, audits gaps, caches, and verifies hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-history-"));
  const fromMs = Date.UTC(2025, 0, 1);
  const toMs = fromMs + 4 * BAR_MS;
  const fetchImpl = async (url) => {
    if (url.pathname.includes("history/kline")) {
      const from = Number(url.searchParams.get("from")) * 1000;
      const to = Number(url.searchParams.get("to")) * 1000;
      const data = [];
      for (let timestamp = from; timestamp <= to; timestamp += BAR_MS) data.push({
        id: timestamp / 1000, open: 100, high: 102, low: 99, close: 101,
        amount: 2, vol: 2000, trade_turnover: 202, count: 10
      });
      return response({ status: "ok", data });
    }
    const page = Number(url.searchParams.get("page_index"));
    return response({
      status: "ok",
      data: { total_page: 2, data: page === 1 ? [{ funding_time: String(fromMs), funding_rate: "0.0001", realized_rate: null, avg_premium_index: "0" }] : [] }
    });
  };
  try {
    const result = await updateHistoricalDataset({
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      directory, fetchImpl, dataTypes: ["kline", "funding"]
    });
    assert.equal(result.manifest.candles.count, 5);
    assert.equal(result.manifest.candles.missingRate, 0);
    assert.deepEqual(result.manifest.candles.gaps, []);
    assert.equal(result.manifest.source.authentication, "none");
    const loaded = await loadHistoricalDataset(directory);
    assert.equal(loaded.candles.length, 5);
    assert.equal(loaded.funding.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("point-in-time market exposes only closed higher-timeframe candles and passes prefix look-ahead audit", () => {
  const dataset = syntheticDataset();
  const index = 70 * 96 + 7;
  const market = buildPointInTimeMarket(dataset.candles, dataset.funding, index);
  const visibleAt = market.replay.visibleAt;
  for (const [key, duration] of [["kline1h", 60 * 60 * 1000], ["kline4h", 4 * 60 * 60 * 1000], ["kline1d", 24 * 60 * 60 * 1000]]) {
    const latest = market[key].data.at(-1);
    assert.ok(Number(latest.id) * 1000 + duration <= visibleAt);
  }
  const audit = runLookaheadAudit(dataset, { samples: 3 });
  assert.equal(audit.passed, true);
  assert.ok(audit.checksRun >= 3);
});

test("Champion and Challenger consume identical events while keeping independent paper accounts", async () => {
  const dataset = syntheticDataset(75);
  const from = new Date(dataset.candles[68 * 96].timestamp).toISOString();
  const to = new Date(dataset.candles.at(-1).timestamp).toISOString();
  const parameters = { ...CHALLENGER_BASE_PARAMETERS, version: "test-active", signalThreshold: 0, immediateThreshold: 0, regimeFilterEnabled: false };
  const comparison = await runChampionChallengerComparison(dataset, { from, to, parameters });
  assert.equal(comparison.sameEvents, true);
  assert.equal(comparison.isolation.challengerCanAffectChampion, false);
  assert.equal(comparison.champion.performance.decisions.counts.WAIT, comparison.champion.eventCount);
  assert.ok(comparison.challenger.tradeCount >= 1);
  assert.ok(comparison.challenger.performance.totalCostsCny > 0);
  assert.equal(comparison.challenger.tradeContexts.length, comparison.challenger.tradeCount);
  const attribution = buildTradeAttribution(comparison.challenger);
  assert.equal(attribution.overall.trades, comparison.challenger.tradeCount);
  assert.ok(Number.isFinite(attribution.overall.averageMfePct));
  assert.ok(Number.isFinite(attribution.overall.averageMaePct));
  assert.equal(attribution.dimensions.exitType.eligibleAtEntry, false);
});

test("historical-compatible analysis ablates only timestamped OHLCV and Funding", () => {
  const dataset = syntheticDataset();
  const market = buildPointInTimeMarket(dataset.candles, dataset.funding, 90 * 96);
  const ohlcv = analyzeHistoricalCompatible(market, HISTORICAL_COMPATIBLE_PARAMETERS, undefined, { useCache: false });
  const funding = analyzeHistoricalCompatible(market, {
    ...HISTORICAL_COMPATIBLE_PARAMETERS,
    version: "test-ohlcv-funding",
    featureSet: "OHLCV_FUNDING"
  }, undefined, { useCache: false });
  assert.equal(ohlcv.historicalCompatibility.compatible, true);
  assert.equal(ohlcv.featureSet, "OHLCV");
  assert.equal(funding.featureSet, "OHLCV_FUNDING");
  assert.deepEqual(funding.historicalCompatibility.forbiddenAndAbsent, [
    "historical Order Book", "historical OI", "historical liquidations",
    "historical elite positioning", "historical Mark/Basis"
  ]);
});

test("Anti-Chase replay keeps the raw geometry window even after baseline frame caching", async () => {
  const dataset = syntheticDataset(75);
  const from = new Date(dataset.candles[68 * 96].timestamp).toISOString();
  const to = new Date(dataset.candles[69 * 96].timestamp).toISOString();
  await runHistoricalReplay(dataset, {
    strategy: "historical-compatible", parameters: HISTORICAL_COMPATIBLE_PARAMETERS, from, to
  });
  const replay = await runHistoricalReplay(dataset, {
    strategy: "anti-chase", parameters: ANTI_CHASE_PARAMETERS, from, to
  });
  const evaluated = replay.trace.filter((item) => item.entryQuality?.side);
  assert.ok(evaluated.length > 0);
  assert.equal(evaluated.some((item) => item.entryQuality.entryType === "INSUFFICIENT_GEOMETRY"), false);
});

test("diagnosis candidates never turn unstable observed subsets into hard filters", () => {
  const candidates = generateDiagnosisCandidates({
    featureSet: "OHLCV_FUNDING",
    diagnosis: { attribution: { stableSubsets: [] } }
  });
  assert.equal(candidates.length, 6);
  assert.ok(candidates.every((item) => item.stableSubsetFilterApplied === false));
  assert.ok(candidates.every((item) => item.parameters.allowedRegimes === undefined));
});

test("untouched holdout opens once for the preselected hash and then seals USED", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-holdout-"));
  const registryPath = join(directory, "holdout.json");
  const dataset = syntheticDataset(10);
  dataset.manifest.manifestHash = "holdout-source-manifest";
  const from = new Date(dataset.candles[5 * 96].timestamp).toISOString();
  const to = new Date(dataset.candles.at(-1).timestamp).toISOString();
  const selectedCandidate = { version: "preselected-v1", strategyHash: "selected-hash" };
  try {
    const sealed = await sealUntouchedHoldout(dataset, { from, to, registryPath });
    assert.equal(sealed.holdout.status, "UNTOUCHED");
    const opened = await openHoldoutForSelectedCandidate(dataset, {
      registryPath, selectedCandidate, selectionEvidenceHash: "selection-evidence",
      selectionCompletedAt: new Date().toISOString()
    });
    assert.equal(opened.registry.holdout.status, "OPENED");
    const used = await markHoldoutUsed({ registryPath, selectedCandidateHash: "selected-hash", resultEvidence: { complete: true } });
    assert.equal(used.holdout.status, "USED");
    await assert.rejects(() => openHoldoutForSelectedCandidate(dataset, {
      registryPath, selectedCandidate, selectionEvidenceHash: "selection-evidence",
      selectionCompletedAt: new Date().toISOString()
    }), /already consumed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("similarity uses real matrix rows, purge/embargo and returns all requested horizons", () => {
  const dataset = syntheticDataset();
  const matrix = buildHistoricalFeatureMatrix(dataset);
  const result = queryHistoricalSimilarity(dataset, matrix, { minimumSamples: 10, neighbors: 30 });
  assert.equal(result.status, "ok");
  assert.equal(result.samplePolicy.purgedFutureOverlap, true);
  assert.deepEqual(Object.keys(result.horizons), ["1h", "4h", "12h", "24h", "3d", "7d"]);
  assert.ok(result.horizons["24h"].samples >= 10);
});

test("robustness runs resampling, block bootstrap, worsened costs/delay and parameter perturbations", async () => {
  const dataset = syntheticDataset(75);
  const from = new Date(dataset.candles[61 * 96].timestamp).toISOString();
  const to = new Date(dataset.candles.at(-1).timestamp).toISOString();
  const parameters = { ...CHALLENGER_BASE_PARAMETERS, version: "test-robust", signalThreshold: 0, immediateThreshold: 0, regimeFilterEnabled: false };
  const replay = await runHistoricalReplay(dataset, { strategy: "challenger", parameters, from, to });
  const replayOptions = {
    eventStride: 1,
    executionDelayBars: 1,
    forceCloseAtEnd: true,
    portfolio: { maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false }
  };
  const result = await runMonteCarloRobustness(dataset, replay, { parameters, from, to, iterations: 20, replayOptions });
  assert.equal(result.status, "ok");
  assert.equal(result.tradeOrderResampling.simulations, 20);
  assert.equal(result.blockBootstrap.simulations, 20);
  assert.ok(result.deterministicStress.executionDelay3Bars);
  assert.equal(result.executionContract.baseExecutionDelayBars, 1);
  assert.equal(result.executionContract.portfolio.maxOpenPositions, 1);
  assert.equal(result.deterministicStress.costDeterioration150Pct.portfolioLimits.maxOpenPositions, 1);
  assert.ok(result.pairedAccounting.costDeterioration150Pct.returnPct < result.base.returnPct);
  assert.ok(result.pairedAccounting.slippageDeterioration200Pct.returnPct < result.base.returnPct);
  assert.equal(result.parameterPerturbation.length, 4);
});

test("V4 robustness gate reports parameter brittleness separately from unobservable sub-bar latency", () => {
  const evidence = evaluateV4RobustnessEvidence({
    tradeOrderResampling: { lossProbabilityPct: 11.4, maxDrawdownPct: { p95: 53.7 } },
    blockBootstrap: { lossProbabilityPct: 5.55, maxDrawdownPct: { p95: 38.1 } },
    pairedAccounting: {
      costDeterioration150Pct: { returnPct: 55, profitFactor: 1.2 },
      slippageDeterioration200Pct: { returnPct: 58, profitFactor: 1.2 }
    },
    parameterPerturbation: [{
      label: "lookback-plus-5pct",
      result: { executable: true, returnPct: 7.97, profitFactor: 1.0434, maxDrawdownPct: 26.42 }
    }],
    delayedExecutionEvidence: { available: false, safetyRejectionExpected: true },
    deterministicStress: {
      costDeterioration150Pct: { returnPct: 74, sameTradePathAsBase: false },
      slippageDeterioration200Pct: { returnPct: 73, sameTradePathAsBase: false },
      allLossesFirst: { maxDrawdownPct: 158 }
    },
    base: { returnPct: 63.7 }
  });
  assert.equal(evidence.passed, false);
  assert.equal(evidence.status, "failed");
  assert.ok(evidence.failureReasons.includes("PARAMETER_PERTURBATION_PROFIT_FACTOR_FAILED:lookback-plus-5pct"));
  assert.deepEqual(evidence.blockedReasons, ["DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE"]);
  assert.ok(evidence.gateReasons.includes("DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE"));
  assert.ok(evidence.gateReasons.includes("PARAMETER_PERTURBATION_PROFIT_FACTOR_FAILED:lookback-plus-5pct"));
  assert.ok(evidence.gateReasons.includes("PARAMETER_PERTURBATION_DRAWDOWN_FAILED:lookback-plus-5pct"));
  assert.ok(evidence.warnings.includes("TRADE_ORDER_P95_DRAWDOWN_ABOVE_DEVELOPMENT_LIMIT"));
  assert.ok(evidence.warnings.includes("FIXED_PNL_PATH_CROSSES_ZERO_EQUITY"));
});

test("V4 robustness perturbs every tuned numeric parameter in both directions", () => {
  const perturbations = robustnessParameterPerturbations("breakout-v4", {
    breakoutLookback4h: 40,
    stopAtrMultiple: 1.5,
    targetRiskMultiple: 4
  });
  assert.deepEqual(perturbations.map((item) => item.label), [
    "lookback-minus-5pct",
    "lookback-plus-5pct",
    "stop-atr-minus-5pct",
    "stop-atr-plus-5pct",
    "target-rr-minus-5pct",
    "target-rr-plus-5pct"
  ]);
});

test("same-trade cost repricing is monotonic and preserves the observed trade path", () => {
  const trades = [{
    net_pnl_cny: 10,
    entry_fee_cny: 1,
    exit_fee_cny: 1,
    entry_slippage_cny: 0.5,
    exit_slippage_cny: 0.5
  }];
  const base = repriceObservedTrades(trades, 100);
  const feeWorse = repriceObservedTrades(trades, 100, { feeMultiplier: 1.5 });
  const slippageWorse = repriceObservedTrades(trades, 100, { slippageMultiplier: 2 });
  assert.equal(base.returnPct, 10);
  assert.equal(feeWorse.returnPct, 9);
  assert.equal(slippageWorse.returnPct, 9);
});

test("post-hoc review covers trades and WAIT without feeding outcomes into decisions", async () => {
  const dataset = syntheticDataset(75);
  const from = new Date(dataset.candles[68 * 96].timestamp).toISOString();
  const to = new Date(dataset.candles[73 * 96].timestamp).toISOString();
  const parameters = { ...CHALLENGER_BASE_PARAMETERS, version: "test-counterfactual", signalThreshold: 0, immediateThreshold: 0, regimeFilterEnabled: false };
  const replay = await runHistoricalReplay(dataset, { strategy: "challenger", parameters, from, to });
  const result = runCounterfactualReview(dataset, replay);
  assert.ok(result.decisionCount > 0);
  assert.equal(result.tradeReviews.length, replay.tradeCount);
  assert.ok(result.decisionCounterfactuals.every((item) => item.eligibleAsDecisionInput === false));
});

test("external feature audit computes a fixed 200-week model only from adequate real-style daily history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-external-"));
  const start = Date.UTC(2021, 0, 1);
  const rows = Array.from({ length: 1_500 }, (_, index) => ({
    id: (start + index * 24 * 60 * 60 * 1000) / 1000,
    open: 20_000 + index, high: 20_100 + index, low: 19_900 + index, close: 20_000 + index, amount: 100
  })).reverse();
  try {
    const report = await auditExternalMarketFeatures({ directory, fetchImpl: async () => response({ status: "ok", data: rows }) });
    const ma = report.features.find((item) => item.key === "btc_200_week_ma");
    assert.equal(ma.status, "research-only");
    assert.equal(ma.value.formulaVersion, "HTX_SPOT_WEEKLY_CLOSE_UTC_MONDAY_SMA200_V1");
    assert.equal(ma.productionWeight, 0);
    assert.equal(report.features.find((item) => item.key === "btc_rainbow_valuation").status, "unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("forward path labels calculate return, MFE/MAE timing/order and real round-trip costs", () => {
  const start = Date.UTC(2026, 0, 1);
  const candles = [
    { timestamp: start, close: 100, high: 101, low: 99 },
    { timestamp: start + BAR_MS, close: 102, high: 103, low: 99.5 },
    { timestamp: start + 2 * BAR_MS, close: 98, high: 102.5, low: 97 },
    { timestamp: start + 3 * BAR_MS, close: 104, high: 105, low: 98 },
    { timestamp: start + 4 * BAR_MS, close: 103, high: 104, low: 101 }
  ];
  const funding = [{ timestamp: start + 4 * BAR_MS, fundingRate: 0.0001 }];
  const outcome = calculateForwardPath(candles, funding, 0, 4, "LONG", { feeRatePerSide: 0.0005, slippageRate: 0.0002 });
  assert.equal(outcome.terminalReturnPct, 3);
  assert.equal(outcome.mfePct, 5);
  assert.equal(outcome.maePct, -3);
  assert.equal(outcome.timeToMfeMinutes, 45);
  assert.equal(outcome.timeToMaeMinutes, 30);
  assert.equal(outcome.firstExtreme, "MAE_FIRST");
  assert.equal(outcome.feesPct, 0.1);
  assert.equal(outcome.slippagePct, 0.04);
  assert.equal(outcome.fundingCostPct, 0.01);
  assert.equal(outcome.netTerminalReturnPct, 2.85);
});

test("Tradable Edge gate is mathematically decomposed and Opportunity Index is not a probability", () => {
  const dataset = syntheticDataset();
  const market = buildPointInTimeMarket(dataset.candles, dataset.funding, 90 * 96);
  const base = analyzeHistoricalCompatible(market, {
    ...HISTORICAL_COMPATIBLE_PARAMETERS,
    featureSet: "OHLCV_FUNDING"
  }, undefined, { useCache: false });
  const states = Object.fromEntries(["LONG", "SHORT"].map((side) => [side, pointInTimeEdgeState(base, side)]));
  const outcomes = Object.fromEntries(["LONG", "SHORT"].map((side) => [side, Object.fromEntries(Object.entries(TRADABLE_EDGE_HORIZONS).map(([horizon, bars]) => [horizon, {
    bars, terminalReturnPct: 1.2, netTerminalReturnPct: 1.06, mfePct: 1.5, maePct: -0.3,
    mfeMaeRatio: 5, timeToMfeMinutes: 60, timeToMaeMinutes: 30, firstExtreme: "MAE_FIRST",
    feesPct: 0.1, slippagePct: 0.04, fundingCostPct: 0, totalCostPct: 0.14
  }]))]));
  const rows = Array.from({ length: 50 }, (_, index) => ({ timestamp: Date.UTC(2025, 0, 1) + index * 4 * 24 * 60 * 60 * 1000, states, outcomes }));
  const catalog = { dataManifestHash: "test", labelsHash: "labels", rows };
  const model = trainTradableEdgeModel(catalog, {
    from: new Date(rows[0].timestamp).toISOString(),
    to: new Date(rows.at(-1).timestamp + 3 * 24 * 60 * 60 * 1000).toISOString(),
    baseParameters: HISTORICAL_COMPATIBLE_PARAMETERS
  });
  const estimate = estimateTradableEdgeForState(states.LONG, model);
  assert.equal(estimate.status, "OK");
  assert.ok(estimate.estimatedGrossOpportunityPct > 0);
  assert.equal(estimate.netTradableEdgePct, Number((estimate.estimatedGrossOpportunityPct
    - estimate.estimatedFeePct - estimate.estimatedSlippagePct
    - estimate.estimatedFundingCostPct - estimate.uncertaintyBufferPct).toFixed(6)));
  assert.match(estimate.scoreSemantics, /not confidence or probability/);
  const gated = applyTradableEdgeGate(base, model, undefined, { minimumNetEdgePct: -10, observeOnly: true });
  assert.equal(gated.decision, "WAIT");
  assert.equal(gated.tradableEdge.observeOnly, true);
  assert.equal(gated.confidenceSemanticsDeprecated, true);
});

test("future untouched holdout remains collecting and cannot expose partial results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-future-holdout-"));
  const registryPath = join(directory, "holdout-v2.json");
  const dataset = syntheticDataset(10);
  const from = new Date(dataset.candles[8 * 96].timestamp).toISOString();
  try {
    const registry = await updateCollectingHoldout(dataset, { from, minimumCalendarDays: 30, minimumBars: 2_880, registryPath });
    assert.equal(registry.holdout.status, "COLLECTING");
    assert.equal(registry.policy.valuesMayBeReadBeforeMaturity, false);
    assert.ok(registry.holdout.remainingBars > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
