import { join } from "node:path";
import { buildTradeAttribution, summarizeAttribution } from "./attribution-engine.mjs";
import { datasetView } from "./edge-diagnosis.mjs";
import { historicalParametersForFeatureSet } from "./feature-ablation.mjs";
import {
  copyHoldoutRegistry,
  defaultHoldoutRegistryPath,
  markHoldoutUsed,
  openHoldoutForSelectedCandidate,
  sealUntouchedHoldout
} from "./holdout-manager.mjs";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { buildWalkForwardWindows } from "./validation-engine.mjs";
import { hashObject, mean, resolveResearchPath, round, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DEVELOPMENT_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-07-31T23:45:00.000Z"
});
const NEW_HOLDOUT_FROM = "2026-08-01T00:00:00.000Z";

export function generateDiagnosisCandidates({ featureSet, diagnosis }) {
  const base = { ...historicalParametersForFeatureSet(featureSet), regimeFilterEnabled: true };
  const stableEntrySubsets = diagnosis.attribution.stableSubsets.filter((item) => item.eligibleAtEntry);
  const definitions = [
    { label: "historical-base", patch: {}, rationale: "Historical-Compatible Champion baseline" },
    { label: "closed-candle-confirmation", patch: { require15mCandleConfirmation: true }, rationale: "Reduce repeated weak entries by requiring the last completed 15m candle to confirm direction" },
    { label: "three-timeframe-alignment", patch: { minimumAlignedTimeframes: 3 }, rationale: "Require 15m/1h/4h directional agreement at decision time" },
    { label: "alignment-plus-confirmation", patch: { minimumAlignedTimeframes: 2, require15mCandleConfirmation: true }, rationale: "Combine point-in-time alignment with completed-candle confirmation" },
    { label: "cost-buffer", patch: { minimumAtrToRoundTripCost: 4 }, rationale: "Require observable 1h ATR to exceed modeled round-trip friction by four times" },
    { label: "selective-cost-aware", patch: { minimumAlignedTimeframes: 2, require15mCandleConfirmation: true, minimumAtrToRoundTripCost: 4 }, rationale: "Address weak selectivity and cost drag without using post-outcome fields" }
  ];
  return definitions.map((definition, index) => {
    const parameters = {
      ...base,
      ...definition.patch,
      version: `edge-candidate-${String(index + 1).padStart(2, "0")}-${definition.label}-v1`
    };
    return {
      version: parameters.version,
      parameters,
      strategyHash: hashObject(parameters),
      rationale: definition.rationale,
      stableSubsetFilterApplied: false,
      stableSubsetReason: stableEntrySubsets.length
        ? "Stable subsets exist but are deliberately not hard-coded into this bounded generic candidate set."
        : "No entry-time subset passed stability; no side/regime/score subset was hard-coded."
    };
  });
}

function candidateAggregate(candidate, windows) {
  const contexts = windows.flatMap((item) => item.replay.tradeContexts);
  const attribution = summarizeAttribution(contexts);
  const positiveWindows = windows.filter((item) => item.replay.performance.cumulativePnlCny > 0
    && Number(item.replay.performance.profitFactor ?? 0) > 1).length;
  const meanReturnPct = mean(windows.map((item) => item.replay.performance.cumulativeReturnPct)) ?? 0;
  const meanDrawdownPct = mean(windows.map((item) => item.replay.performance.maxDrawdownPct)) ?? 0;
  const meanSharpe = mean(windows.map((item) => Number(item.replay.performance.tradeSharpe ?? 0))) ?? 0;
  const stableReasons = [];
  if (contexts.length < 100) stableReasons.push("fewer than 100 development OOS trades");
  if (positiveWindows < 3) stableReasons.push("net profitable in fewer than 3/4 development OOS windows");
  if (!(attribution.netExpectancyPctLower95 > 0)) stableReasons.push("net expectancy 95% lower bound is not positive");
  if (!(Number(attribution.netProfitFactor ?? 0) >= 1.05)) stableReasons.push("combined development OOS net PF below 1.05");
  const rankingScore = round(meanReturnPct - meanDrawdownPct * 0.25 + meanSharpe + attribution.netExpectancyPct * 10, 6);
  return {
    candidate,
    windows: windows.map((item) => ({
      index: item.index,
      range: item.range,
      eventCount: item.replay.eventCount,
      eventStreamHash: item.replay.eventStreamHash,
      tradeCount: item.replay.tradeCount,
      performance: item.replay.performance
    })),
    combinedAttribution: attribution,
    positiveWindows,
    meanReturnPct: round(meanReturnPct, 6),
    meanDrawdownPct: round(meanDrawdownPct, 6),
    meanSharpe: round(meanSharpe, 6),
    stableDevelopmentEdge: stableReasons.length === 0,
    stableReasons,
    rankingScore
  };
}

function finalSummary(replay) {
  return {
    strategyVersion: replay.strategyVersion,
    strategyHash: replay.strategyHash,
    eventCount: replay.eventCount,
    eventStreamHash: replay.eventStreamHash,
    tradeCount: replay.tradeCount,
    performance: replay.performance,
    attribution: buildTradeAttribution(replay)
  };
}

function promotionDecision({ selected, finalCandidate, finalBaseline, robustness }) {
  const reasons = [];
  if (!selected.stableDevelopmentEdge) reasons.push(...selected.stableReasons.map((item) => `development OOS: ${item}`));
  if (finalCandidate.tradeCount < 20) reasons.push("new untouched Final OOS has fewer than 20 trades");
  if (!(finalCandidate.performance.cumulativePnlCny > 0)) reasons.push("new untouched Final OOS net PnL is not positive");
  if (!(Number(finalCandidate.performance.profitFactor ?? 0) >= 1.05)) reasons.push("new untouched Final OOS PF below 1.05");
  if (!(finalCandidate.performance.cumulativePnlCny > finalBaseline.performance.cumulativePnlCny)) reasons.push("new Challenger does not beat Historical-Compatible Champion on untouched Final OOS");
  if (robustness.status !== "ok") reasons.push(`robustness unavailable: ${robustness.reason}`);
  if (Number(robustness.tradeOrderResampling?.lossProbabilityPct ?? 100) > 50) reasons.push("Monte Carlo trade-order loss probability exceeds 50%");
  if (Number(robustness.blockBootstrap?.lossProbabilityPct ?? 100) > 50) reasons.push("Monte Carlo block-bootstrap loss probability exceeds 50%");
  reasons.push("live Shadow has not accumulated 30 calendar days and 100 signals");
  return {
    status: "BLOCKED",
    reasons: [...new Set(reasons)],
    automaticChampionReplacement: false,
    frozenV12LiveChampionChanged: false,
    historicalCompatibleChampionChanged: false
  };
}

export async function runEdgeCandidatePipeline(dataset, {
  diagnosis,
  ablation,
  outputDirectory,
  holdoutRegistryPath = defaultHoldoutRegistryPath(),
  robustnessIterations = 500,
  onProgress = null
} = {}) {
  if (!outputDirectory) throw new Error("Edge candidate pipeline requires an output directory");
  const holdoutTo = dataset.manifest.requestedCoverage.to;
  if (new Date(holdoutTo) <= new Date(NEW_HOLDOUT_FROM)) throw new Error("Dataset has no new untouched holdout after 2026-07-31");
  const sealed = await sealUntouchedHoldout(dataset, {
    from: NEW_HOLDOUT_FROM,
    to: holdoutTo,
    registryPath: holdoutRegistryPath
  });
  onProgress?.({ stage: "holdout", status: sealed.holdout.status });
  const development = datasetView(dataset, DEVELOPMENT_RANGE);
  const windows = buildWalkForwardWindows(development, 4);
  const featureSet = ablation.historicalCompatibleChampion.featureSet;
  const historicalChampionParameters = historicalParametersForFeatureSet(featureSet);
  const candidates = generateDiagnosisCandidates({ featureSet, diagnosis });
  const experiments = [];
  for (const candidate of candidates) {
    const candidateWindows = [];
    for (const window of windows) {
      onProgress?.({ stage: "candidate-oos", candidate: candidate.version, window: window.index });
      const replay = await runHistoricalReplay(development, {
        strategy: "historical-compatible",
        parameters: candidate.parameters,
        from: window.testStart,
        to: window.testEnd,
        collectTrace: false,
        outputDirectory: join(outputDirectory, "development", candidate.version, `window-${window.index}`)
      });
      candidateWindows.push({ index: window.index, range: { from: window.testStart, to: window.testEnd }, replay });
    }
    experiments.push(candidateAggregate(candidate, candidateWindows));
  }
  const stable = experiments.filter((item) => item.stableDevelopmentEdge);
  const ranked = (stable.length ? stable : experiments).sort((a, b) => b.rankingScore - a.rankingScore);
  const selected = ranked[0];
  const selectionCompletedAt = new Date().toISOString();
  const selectionEvidence = {
    producer: "EdgeCandidatePipeline",
    generatedAt: selectionCompletedAt,
    developmentManifestHash: development.manifest.manifestHash,
    developmentRange: DEVELOPMENT_RANGE,
    holdoutStatusDuringSelection: sealed.holdout.status,
    holdoutCandlesReadForRanking: 0,
    diagnosisHash: hashObject(diagnosis),
    ablationHash: hashObject(ablation),
    candidates: experiments.map((item) => ({
      version: item.candidate.version,
      strategyHash: item.candidate.strategyHash,
      rankingScore: item.rankingScore,
      stableDevelopmentEdge: item.stableDevelopmentEdge,
      stableReasons: item.stableReasons,
      positiveWindows: item.positiveWindows,
      combinedAttribution: item.combinedAttribution
    })),
    selected: { version: selected.candidate.version, strategyHash: selected.candidate.strategyHash }
  };
  selectionEvidence.evidenceHash = hashObject(selectionEvidence);
  await writeJsonAtomic(join(outputDirectory, "selection-evidence.json"), selectionEvidence);
  const opened = await openHoldoutForSelectedCandidate(dataset, {
    registryPath: holdoutRegistryPath,
    selectedCandidate: selected.candidate,
    selectionEvidenceHash: selectionEvidence.evidenceHash,
    selectionCompletedAt
  });
  onProgress?.({ stage: "final-oos", status: "opened", candidate: selected.candidate.version });
  const baselineReplay = await runHistoricalReplay(dataset, {
    strategy: "historical-compatible",
    parameters: historicalChampionParameters,
    ...opened.range,
    collectTrace: false,
    outputDirectory: join(outputDirectory, "untouched-final-oos", "historical-compatible-champion")
  });
  const candidateReplay = await runHistoricalReplay(dataset, {
    strategy: "historical-compatible",
    parameters: selected.candidate.parameters,
    ...opened.range,
    collectTrace: false,
    outputDirectory: join(outputDirectory, "untouched-final-oos", "selected-challenger")
  });
  const sameEvents = baselineReplay.eventCount === candidateReplay.eventCount
    && baselineReplay.eventStreamHash === candidateReplay.eventStreamHash;
  if (!sameEvents) throw new Error("Historical-Compatible Champion and Challenger did not consume identical Final OOS events");
  const robustness = await runMonteCarloRobustness(dataset, candidateReplay, {
    parameters: selected.candidate.parameters,
    ...opened.range,
    iterations: robustnessIterations,
    outputDirectory: join(outputDirectory, "robustness")
  });
  const baselineSummary = finalSummary(baselineReplay);
  const candidateSummary = finalSummary(candidateReplay);
  const holdoutEvidence = {
    selectedCandidateVersion: selected.candidate.version,
    selectedCandidateHash: selected.candidate.strategyHash,
    sameEvents,
    eventStreamHash: candidateReplay.eventStreamHash,
    baselineTradeHash: hashObject(baselineReplay.trades),
    candidateTradeHash: hashObject(candidateReplay.trades),
    robustnessHash: hashObject(robustness)
  };
  const usedRegistry = await markHoldoutUsed({
    registryPath: holdoutRegistryPath,
    selectedCandidateHash: selected.candidate.strategyHash,
    resultEvidence: holdoutEvidence
  });
  await copyHoldoutRegistry(holdoutRegistryPath, outputDirectory);
  const shadowDatabasePath = resolveResearchPath("shadow", `${selected.candidate.strategyHash.slice(0, 16)}.sqlite`);
  const activeShadow = {
    schemaVersion: 1,
    activatedAt: new Date().toISOString(),
    status: "SHADOW_RESEARCH_ONLY",
    paperOnly: true,
    strategyType: "historical-compatible",
    version: selected.candidate.version,
    strategyHash: selected.candidate.strategyHash,
    parameters: selected.candidate.parameters,
    databasePath: shadowDatabasePath,
    sourcePipelineReport: join(outputDirectory, "edge-candidate-pipeline.json"),
    finalOosMayTuneThisStrategy: false
  };
  activeShadow.configHash = hashObject(activeShadow);
  await writeJsonAtomic(resolveResearchPath("active-shadow-strategy.json"), activeShadow);
  const promotion = promotionDecision({ selected, finalCandidate: candidateReplay, finalBaseline: baselineReplay, robustness });
  const result = {
    schemaVersion: 1,
    runType: "DIAGNOSIS_TO_NEW_UNTOUCHED_HOLDOUT_PIPELINE",
    generatedAt: new Date().toISOString(),
    frozenV12ChampionHash: sha256(await (await import("node:fs/promises")).readFile(new URL("./analysis-engine.mjs", import.meta.url), "utf8")).toUpperCase(),
    frozenV12LiveChampionChanged: false,
    mlUsed: false,
    newDataTypesAdded: false,
    historicalCompatibleChampion: {
      parameters: historicalChampionParameters,
      strategyHash: hashObject(historicalChampionParameters),
      ablationEvidenceHash: hashObject(ablation),
      stableNetEdgeProven: ablation.historicalCompatibleChampion.stableNetEdgeProven,
      liveChampionChanged: false
    },
    development: {
      range: DEVELOPMENT_RANGE,
      purgingBars: windows[0].purgingBars,
      embargoBars: windows[0].embargoBars,
      candidatesGenerated: candidates.length,
      candidatesWithStableEdge: stable.length,
      selected: selected.candidate,
      selectedMetrics: {
        combinedAttribution: selected.combinedAttribution,
        positiveWindows: selected.positiveWindows,
        stableDevelopmentEdge: selected.stableDevelopmentEdge,
        stableReasons: selected.stableReasons,
        rankingScore: selected.rankingScore
      },
      experiments
    },
    untouchedFinalOos: {
      registryStatus: usedRegistry.holdout.status,
      range: opened.range,
      wasUntouchedDuringCandidateRanking: selectionEvidence.holdoutCandlesReadForRanking === 0,
      mayTuneFutureCandidates: false,
      sameEvents,
      historicalCompatibleChampion: baselineSummary,
      challenger: candidateSummary,
      incremental: {
        netPnlCny: round(candidateReplay.performance.cumulativePnlCny - baselineReplay.performance.cumulativePnlCny, 4),
        netReturnPct: round(candidateReplay.performance.cumulativeReturnPct - baselineReplay.performance.cumulativeReturnPct, 4),
        profitFactor: round(Number(candidateReplay.performance.profitFactor ?? 0) - Number(baselineReplay.performance.profitFactor ?? 0), 4),
        maxDrawdownPct: round(candidateReplay.performance.maxDrawdownPct - baselineReplay.performance.maxDrawdownPct, 4)
      }
    },
    robustness,
    shadow: {
      status: "STARTED_AWAITING_LIVE_EVENTS",
      strategyVersion: activeShadow.version,
      strategyHash: activeShadow.strategyHash,
      independentDatabase: activeShadow.databasePath,
      historicalSameEvents: sameEvents,
      affectsFrozenChampion: false
    },
    promotion,
    safety: { paperOnly: true, privateHtxApi: false, exchangeCredentials: false, exchangeWrites: false }
  };
  await writeJsonAtomic(join(outputDirectory, "edge-candidate-pipeline.json"), result);
  return result;
}

export { DEVELOPMENT_RANGE, NEW_HOLDOUT_FROM };
