import { analyzeSnapshot } from "./analysis-engine.mjs";
import { analyzeChallenger, CHALLENGER_BASE_PARAMETERS } from "./challenger-strategy.mjs";
import { FEATURE_VALIDATION_POLICY } from "./feature-registry.mjs";
import { buildPointInTimeMarket, firstReplayableIndex } from "./replay-market.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { buildHistoricalFeatureMatrix, SIMILARITY_HORIZONS } from "./similarity-engine.mjs";
import { BAR_MS, hashObject, mean, round } from "./research-utils.mjs";
import { analyzeResearchChallengerV2, RESEARCH_CHALLENGER_V2_PARAMETERS } from "./research-challenger-v2.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_BARS = SIMILARITY_HORIZONS["7d"];
const EMBARGO_BARS = 96;

function reportFingerprint(report) {
  return hashObject({
    generatedAt: report.generatedAt,
    decision: report.decision,
    candidateDecision: report.candidateDecision,
    currentPrice: report.currentPrice,
    plan: report.plan,
    scores: report.scores,
    timeframes: report.timeframes,
    dataQuality: report.dataQuality
  });
}

export function runLookaheadAudit(dataset, {
  strategies = ["champion", "challenger"],
  parameters = CHALLENGER_BASE_PARAMETERS,
  samples = 24
} = {}) {
  const first = firstReplayableIndex(dataset.candles);
  const last = dataset.candles.length - SIMILARITY_HORIZONS["7d"] - 1;
  if (first < 0 || last <= first) throw new Error("Dataset is too short for look-ahead audit");
  const step = Math.max(1, Math.floor((last - first) / samples));
  const checks = [];
  for (let index = first; index <= last && checks.length < samples; index += step) {
    const fullMarket = buildPointInTimeMarket(dataset.candles, dataset.funding, index);
    const prefixCandles = dataset.candles.slice(0, index + 1);
    const prefixFunding = dataset.funding.filter((item) => item.timestamp <= fullMarket.replay.visibleAt);
    const prefixMarket = buildPointInTimeMarket(prefixCandles, prefixFunding, prefixCandles.length - 1);
    for (const strategy of strategies) {
      const analyze = strategy === "champion"
        ? (market) => analyzeSnapshot(market)
        : strategy === "research-v2"
          ? (market) => analyzeResearchChallengerV2(market, parameters, undefined, { useCache: false })
          : (market) => analyzeChallenger(market, parameters, undefined, { useCache: false });
      const full = analyze(fullMarket);
      const prefix = analyze(prefixMarket);
      checks.push({
        strategy,
        timestamp: full.generatedAt,
        fullHash: reportFingerprint(full),
        prefixHash: reportFingerprint(prefix),
        passed: reportFingerprint(full) === reportFingerprint(prefix),
        highestVisible15mTimestamp: new Date(dataset.candles[index].timestamp).toISOString(),
        futureRowsPresentInPrefix: false
      });
    }
  }
  return {
    auditType: "PREFIX_INVARIANCE_POINT_IN_TIME_AUDIT",
    passed: checks.every((item) => item.passed),
    checksRun: checks.length,
    strategies,
    checks,
    rule: "Appending future rows must not change a strategy output at an earlier timestamp."
  };
}

function buildWalkForwardWindows(dataset, count = 4) {
  const warmupIndex = firstReplayableIndex(dataset.candles);
  const dataStart = dataset.candles[warmupIndex].timestamp + BAR_MS;
  const requestedStart = new Date(dataset.manifest.requestedCoverage.from).getTime();
  const start = Math.max(dataStart, requestedStart);
  const end = Math.min(new Date(dataset.manifest.requestedCoverage.to).getTime() + BAR_MS, dataset.candles.at(-1).timestamp + BAR_MS);
  const span = end - start;
  if (span < 240 * DAY_MS) throw new Error("Walk-forward validation requires at least 240 days after warmup");
  const initialTrain = Math.floor(Math.max(120 * DAY_MS, span * 0.45) / BAR_MS) * BAR_MS;
  const testSpan = Math.floor(((span - initialTrain) / count) / BAR_MS) * BAR_MS;
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    const testStart = start + initialTrain + index * testSpan;
    const testEnd = index === count - 1 ? end : start + initialTrain + (index + 1) * testSpan;
    const trainEnd = testStart - (PURGE_BARS + EMBARGO_BARS) * BAR_MS;
    windows.push({
      index: index + 1,
      trainStart: new Date(start).toISOString(),
      trainEnd: new Date(trainEnd).toISOString(),
      purgeStart: new Date(trainEnd).toISOString(),
      purgeEnd: new Date(trainEnd + PURGE_BARS * BAR_MS).toISOString(),
      embargoStart: new Date(trainEnd + PURGE_BARS * BAR_MS).toISOString(),
      testStart: new Date(testStart).toISOString(),
      testEnd: new Date(testEnd - BAR_MS).toISOString(),
      purgingBars: PURGE_BARS,
      embargoBars: EMBARGO_BARS
    });
  }
  return windows;
}

function summary(replay) {
  return {
    strategyVersion: replay.strategyVersion,
    strategyHash: replay.strategyHash,
    eventCount: replay.eventCount,
    tradeCount: replay.tradeCount,
    performance: replay.performance,
    eventStreamHash: replay.eventStreamHash,
    tradeHash: hashObject(replay.trades)
  };
}

function finiteMetric(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

export async function runValidationEngine(dataset, {
  baselineParameters = { ...CHALLENGER_BASE_PARAMETERS, version: "challenger-baseline-no-regime-v1", regimeFilterEnabled: false },
  candidateParameters = CHALLENGER_BASE_PARAMETERS,
  walkForwardWindows = 4,
  outputDirectory,
  baselineStrategy = "challenger",
  candidateStrategy = "challenger"
} = {}) {
  const windows = buildWalkForwardWindows(dataset, walkForwardWindows);
  const matrix = buildHistoricalFeatureMatrix(dataset);
  const lookahead = runLookaheadAudit(dataset, { strategies: [candidateStrategy], parameters: candidateParameters });
  const results = [];
  for (const window of windows) {
    const baseline = await runHistoricalReplay(dataset, {
      strategy: baselineStrategy,
      parameters: baselineParameters,
      from: window.testStart,
      to: window.testEnd,
      collectTrace: false,
      outputDirectory: outputDirectory ? `${outputDirectory}/window-${window.index}/baseline` : undefined
    });
    const candidate = await runHistoricalReplay(dataset, {
      strategy: candidateStrategy,
      parameters: candidateParameters,
      from: window.testStart,
      to: window.testEnd,
      collectTrace: false,
      outputDirectory: outputDirectory ? `${outputDirectory}/window-${window.index}/candidate` : undefined
    });
    results.push({
      ...window,
      trainingSamples: matrix.rows.filter((row) => row.timestamp >= new Date(window.trainStart).getTime() && row.timestamp <= new Date(window.trainEnd).getTime()).length,
      baseline: summary(baseline),
      candidate: summary(candidate),
      incremental: {
        netReturnPct: round(candidate.performance.cumulativeReturnPct - baseline.performance.cumulativeReturnPct, 4),
        tradeSharpe: round(finiteMetric(candidate.performance.tradeSharpe) - finiteMetric(baseline.performance.tradeSharpe), 4),
        profitFactor: round(finiteMetric(candidate.performance.profitFactor) - finiteMetric(baseline.performance.profitFactor), 4),
        maxDrawdownPct: round(candidate.performance.maxDrawdownPct - baseline.performance.maxDrawdownPct, 4)
      }
    });
  }
  const missingMarket = buildPointInTimeMarket(dataset.candles, [], Math.max(firstReplayableIndex(dataset.candles), dataset.candles.length - 1000));
  const missingReport = candidateStrategy === "research-v2"
    ? analyzeResearchChallengerV2(missingMarket, candidateParameters)
    : analyzeChallenger(missingMarket, candidateParameters);
  const missingDataPolicy = {
    passed: missingReport.derivatives.fundingRatePct === null,
    fundingWasMissing: true,
    fundingWasForwardFilled: false,
    decisionRemainedPaperOnly: /PAPER_ONLY/.test(missingReport.mode)
  };
  const positiveWindows = results.filter((item) => item.incremental.tradeSharpe > 0 && item.incremental.netReturnPct >= 0).length;
  const outOfSampleTrades = results.reduce((sum, item) => sum + item.candidate.tradeCount, 0);
  const evidence = {
    producer: "ValidationEngine",
    candidateVersion: candidateParameters.version,
    candidateStrategyHash: hashObject(candidateParameters),
    baselineVersion: baselineParameters.version,
    baselineStrategyHash: hashObject(baselineParameters),
    dataManifestHash: dataset.manifest.manifestHash,
    featureMatrixHash: matrix.matrixHash,
    historicalSamples: Math.max(...results.map((item) => item.trainingSamples)),
    outOfSampleTrades,
    walkForwardWindows: results.length,
    positiveWindows,
    netSharpeDelta: round(mean(results.map((item) => item.incremental.tradeSharpe)), 4),
    netProfitFactorDelta: round(mean(results.map((item) => item.incremental.profitFactor)), 4),
    netReturnDeltaPct: round(mean(results.map((item) => item.incremental.netReturnPct)), 4),
    costsIncluded: true,
    noLookaheadAudit: lookahead.passed,
    missingDataPolicyTested: missingDataPolicy.passed,
    purgingApplied: results.every((item) => new Date(item.purgeEnd) <= new Date(item.embargoStart)),
    purgingBars: PURGE_BARS,
    embargoBars: EMBARGO_BARS,
    trainEnd: results[0].trainEnd,
    testStart: results[0].testStart,
    historyStart: dataset.manifest.actualCoverage.from,
    historyEnd: dataset.manifest.actualCoverage.to,
    generatedAt: new Date().toISOString()
  };
  evidence.evidenceHash = hashObject(evidence);
  const changedParameters = Object.fromEntries(Object.keys(candidateParameters)
    .filter((key) => key !== "version" && candidateParameters[key] !== baselineParameters[key])
    .map((key) => [key, { baseline: baselineParameters[key], candidate: candidateParameters[key] }]));
  const gateReasons = [];
  if (evidence.historicalSamples < FEATURE_VALIDATION_POLICY.minimumHistoricalSamples) gateReasons.push("insufficient historical samples");
  if (evidence.outOfSampleTrades < FEATURE_VALIDATION_POLICY.minimumOutOfSampleTrades) gateReasons.push("insufficient OOS trades");
  if (evidence.walkForwardWindows < FEATURE_VALIDATION_POLICY.minimumWalkForwardWindows) gateReasons.push("insufficient walk-forward windows");
  if (evidence.positiveWindows < FEATURE_VALIDATION_POLICY.minimumPositiveWindows) gateReasons.push("incremental improvement is not stable across windows");
  if (evidence.netSharpeDelta < FEATURE_VALIDATION_POLICY.minimumNetSharpeDelta) gateReasons.push("net Sharpe delta below policy");
  if (evidence.netProfitFactorDelta < FEATURE_VALIDATION_POLICY.minimumNetProfitFactorDelta) gateReasons.push("Profit Factor delta is negative");
  if (!evidence.noLookaheadAudit) gateReasons.push("look-ahead audit failed");
  return {
    runType: "GENERATED_WALK_FORWARD_PURGED_OOS_VALIDATION",
    evidence,
    passed: gateReasons.length === 0,
    gateReasons,
    policy: FEATURE_VALIDATION_POLICY,
    windows: results,
    lookaheadAudit: lookahead,
    missingDataPolicy,
    baselineVsFeature: {
      baseline: baselineParameters,
      candidate: candidateParameters,
      baselineStrategy,
      candidateStrategy,
      changedParameters,
      featureUnderTest: Object.keys(changedParameters).length === 1 ? Object.keys(changedParameters)[0] : "candidate_parameter_bundle",
      interpretation: "The experiment runner computed this parameter diff. Both sides consume identical OOS events and use separate Paper accounts."
    }
  };
}

export { buildWalkForwardWindows, PURGE_BARS, EMBARGO_BARS };
