import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTradeAttribution } from "./attribution-engine.mjs";
import { HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { openPaperDatabase } from "./db.mjs";
import { datasetView } from "./edge-diagnosis.mjs";
import { updateCollectingHoldout } from "./holdout-manager.mjs";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { RESEARCH_CHALLENGER_V2_PARAMETERS } from "./research-challenger-v2.mjs";
import { hashObject, mean, round, sha256, writeJsonAtomic } from "./research-utils.mjs";
import { runValidationEngine } from "./validation-engine.mjs";

export const V2_DEVELOPMENT_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-01-17T06:30:00.000Z",
  policy: "Predeclared development interval that excludes every previously used Final OOS and the collecting future holdout."
});
export const V2_FUTURE_HOLDOUT_FROM = "2026-08-23T05:45:00.000Z";

export function generateV2Candidates() {
  const definitions = [
    { label: "auto-profile", patch: {}, complexity: 0 },
    { label: "short-swing", patch: { indicatorProfile: "SHORT_SWING" }, complexity: 1 },
    { label: "standard-swing", patch: { indicatorProfile: "STANDARD_SWING" }, complexity: 1 },
    { label: "higher-net-edge", patch: { minimumNetTradableEdgePct: 0.25 }, complexity: 1 }
  ];
  return definitions.map((definition, index) => {
    const parameters = {
      ...RESEARCH_CHALLENGER_V2_PARAMETERS,
      ...definition.patch,
      version: `research-v2-candidate-${String(index + 1).padStart(2, "0")}-${definition.label}`
    };
    return {
      label: definition.label, version: parameters.version, parameters,
      strategyHash: hashObject(parameters), complexity: definition.complexity,
      candidateSource: "BOUNDED_PREDECLARED_PROFILE_AND_EDGE_SEARCH",
      finalOosInputsRead: 0
    };
  });
}

function validationMetrics(validation) {
  const windows = validation.windows;
  const returns = windows.map((item) => Number(item.candidate.performance.cumulativeReturnPct));
  const drawdowns = windows.map((item) => Number(item.candidate.performance.maxDrawdownPct));
  const pfs = windows.map((item) => Number(item.candidate.performance.profitFactor ?? 0));
  const trades = windows.reduce((sum, item) => sum + Number(item.candidate.tradeCount), 0);
  const positive = windows.filter((item) => Number(item.candidate.performance.cumulativePnlCny) > 0 && Number(item.candidate.performance.profitFactor ?? 0) > 1).length;
  return {
    meanReturnPct: round(mean(returns) ?? 0, 6), meanDrawdownPct: round(mean(drawdowns) ?? 0, 6),
    meanProfitFactor: round(mean(pfs) ?? 0, 6), oosTrades: trades, positiveWindows: positive
  };
}

function rank(experiment) {
  const value = experiment.metrics.meanReturnPct - experiment.metrics.meanDrawdownPct * 0.35
    + (experiment.metrics.meanProfitFactor - 1) * 4 - experiment.candidate.complexity * 0.15;
  return round(value, 6);
}

export async function runResearchV2Pipeline(dataset, {
  outputDirectory,
  databasePath,
  robustnessIterations = 1_000,
  onProgress = null,
  // 一次 CLI invocation 只应产生一个顶层 research run。CLI 自己登记那一条，
  // 并把这里的阶段结果作为 stage/evidence 放进它的 summary，因此传 false。
  recordPipelineRun = true
} = {}) {
  if (!outputDirectory) throw new Error("Research V2 pipeline requires outputDirectory");
  const development = datasetView(dataset, V2_DEVELOPMENT_RANGE);
  const candidates = generateV2Candidates();
  const experiments = [];
  for (const candidate of candidates) {
    onProgress?.({ stage: "walk-forward", candidate: candidate.version, status: "running" });
    const validation = await runValidationEngine(development, {
      baselineStrategy: "historical-compatible",
      baselineParameters: HISTORICAL_COMPATIBLE_PARAMETERS,
      candidateStrategy: "research-v2",
      candidateParameters: candidate.parameters,
      walkForwardWindows: 4,
      outputDirectory: join(outputDirectory, "validation", candidate.version)
    });
    const experiment = { candidate, validation, metrics: validationMetrics(validation) };
    experiment.rankingScore = rank(experiment);
    experiments.push(experiment);
    onProgress?.({ stage: "walk-forward", candidate: candidate.version, status: validation.passed ? "passed" : "failed" });
  }
  const eligible = experiments.filter((item) => item.validation.passed);
  const selectedDiagnostic = [...(eligible.length ? eligible : experiments)].sort((a, b) => b.rankingScore - a.rankingScore)[0];
  const selected = eligible.length ? selectedDiagnostic : null;
  const selectionEvidence = {
    producer: "ResearchV2Pipeline", generatedAt: new Date().toISOString(), developmentRange: V2_DEVELOPMENT_RANGE,
    developmentManifestHash: development.manifest.manifestHash, finalHoldoutRowsRead: 0,
    candidatesAttempted: candidates.length, candidatesPassingWalkForwardGate: eligible.length,
    rankingObjective: "mean OOS net return - 0.35*mean max drawdown + PF contribution - complexity penalty",
    experiments: experiments.map((item) => ({
      version: item.candidate.version, strategyHash: item.candidate.strategyHash, complexity: item.candidate.complexity,
      validationPassed: item.validation.passed, gateReasons: item.validation.gateReasons,
      evidenceHash: item.validation.evidence.evidenceHash, metrics: item.metrics, rankingScore: item.rankingScore
    })),
    selectedForFurtherValidation: selected ? { version: selected.candidate.version, strategyHash: selected.candidate.strategyHash } : null,
    bestDiagnosticOnly: !selected ? { version: selectedDiagnostic.candidate.version, strategyHash: selectedDiagnostic.candidate.strategyHash } : null
  };
  selectionEvidence.selectionHash = hashObject(selectionEvidence);
  await writeJsonAtomic(join(outputDirectory, "selection-evidence.json"), selectionEvidence);

  const diagnosticReplay = await runHistoricalReplay(development, {
    strategy: "research-v2", parameters: selectedDiagnostic.candidate.parameters,
    ...V2_DEVELOPMENT_RANGE, outputDirectory: join(outputDirectory, "selected-diagnostic-replay")
  });
  const attribution = buildTradeAttribution(diagnosticReplay, { windows: selectedDiagnostic.validation.windows });
  await writeJsonAtomic(join(outputDirectory, "trade-attribution.json"), attribution);
  const robustness = await runMonteCarloRobustness(development, diagnosticReplay, {
    strategy: "research-v2", parameters: selectedDiagnostic.candidate.parameters,
    ...V2_DEVELOPMENT_RANGE, iterations: robustnessIterations,
    outputDirectory: join(outputDirectory, "robustness")
  });
  await writeJsonAtomic(join(outputDirectory, "monte-carlo.json"), robustness);

  const holdout = await updateCollectingHoldout(dataset, {
    from: V2_FUTURE_HOLDOUT_FROM,
    preselectedCandidate: selected ? {
      version: selected.candidate.version, strategyHash: selected.candidate.strategyHash,
      selectionEvidenceHash: selectionEvidence.selectionHash, selectedBeforeHoldoutRead: true
    } : null
  });
  const codeSha256 = sha256(await readFile(new URL("./research-challenger-v2.mjs", import.meta.url), "utf8"));
  const frozenChampionSha256 = sha256(await readFile(new URL("./analysis-engine.mjs", import.meta.url), "utf8"));
  let strategyRegistry = null;
  if (databasePath) {
    const db = openPaperDatabase(databasePath);
    try {
      const records = [];
      for (const experiment of experiments) records.push(db.registerStrategyVersion({
        version: experiment.candidate.version, role: "CHALLENGER",
        lifecycleStatus: experiment.validation.passed ? "VALIDATING" : "REJECTED",
        strategyHash: experiment.candidate.strategyHash, codeSha256,
        parameters: experiment.candidate.parameters,
        featureSet: ["POINT_IN_TIME_OHLCV", "TIMESTAMP_VISIBLE_FUNDING", "INDEPENDENT_SIGNAL_DIMENSIONS", "TRADABLE_EDGE"],
        dataManifestHash: dataset.manifest.manifestHash, developmentRange: V2_DEVELOPMENT_RANGE,
        oosRange: experiment.validation.windows.map((window) => ({ from: window.testStart, to: window.testEnd })),
        finalHoldout: holdout.holdout, performance: experiment.metrics,
        promotionReason: experiment.validation.passed ? "Walk-forward gate passed; awaiting future untouched holdout" : experiment.validation.gateReasons.join("; "),
        rollbackVersion: "V1.2-FROZEN"
      }));
      if (recordPipelineRun) {
        db.recordResearchRun({
          runType: "RESEARCH_V2_PIPELINE", startedAt: selectionEvidence.generatedAt, finishedAt: new Date().toISOString(),
          status: selected ? "PARTIAL" : "FAILED", artifactPath: outputDirectory,
          dataManifestHash: dataset.manifest.manifestHash, strategyVersion: selectedDiagnostic.candidate.version,
          summary: { eligibleCandidates: eligible.length, diagnosticPerformance: diagnosticReplay.performance, holdoutStatus: holdout.holdout.status }
        });
      }
      strategyRegistry = records;
    } finally { db.close(); }
  }
  const finalOos = holdout.holdout.status === "READY_UNOPENED"
    ? { status: "READY_NOT_OPENED_BY_THIS_RUN", reason: "Only a candidate that passed development validation may open it once." }
    : { status: "BLOCKED", reason: `Future untouched holdout is ${holdout.holdout.status}; observed ${holdout.holdout.observedBars ?? 0}/${holdout.holdout.minimumBars} bars.` };
  const formalShadow = selected && finalOos.status === "COMPLETED" && robustness.status === "ok"
    ? { status: "ELIGIBLE_TO_START" }
    : { status: "NOT_STARTED", reason: "Promotion order forbids formal Shadow before untouched Final OOS and robustness gates pass." };
  const result = {
    schemaVersion: 1, runType: "RESEARCH_CHALLENGER_V2_CONTROLLED_PIPELINE", generatedAt: new Date().toISOString(),
    frozenChampion: { version: "V1.2", codeSha256: frozenChampionSha256, changed: false },
    challengerCodeSha256: codeSha256, developmentRange: V2_DEVELOPMENT_RANGE,
    candidateGeneration: { attempted: candidates.length, searchSpaceBounded: true, finalOosUsedForSelection: false },
    experiments, selectionEvidence, diagnosticReplay, attribution, robustness,
    finalUntouchedOos: finalOos, holdoutRegistry: holdout, formalShadow,
    promotion: {
      status: "BLOCKED", eligible: false, championChanged: false,
      reasons: [
        ...(selected ? [] : ["No candidate passed the purged walk-forward OOS gate"]),
        finalOos.reason,
        ...(robustness.status === "ok" ? [] : [`Monte Carlo: ${robustness.reason}`]),
        "Formal live Shadow evidence (30 days / 100 signals) is not complete"
      ]
    },
    strategyRegistry,
    safety: { paperOnly: true, apiKey: false, privateHtxApi: false, realOrders: false, exchangeWrites: false },
    conclusion: diagnosticReplay.performance.cumulativePnlCny > 0 && Number(diagnosticReplay.performance.profitFactor ?? 0) > 1
      ? "DEVELOPMENT_EDGE_ONLY_NOT_PROMOTABLE" : "NO_PROVEN_EDGE"
  };
  await writeJsonAtomic(join(outputDirectory, "research-v2-pipeline.json"), result);
  return result;
}

