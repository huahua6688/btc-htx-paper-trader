import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHALLENGER_BASE_PARAMETERS } from "./challenger-strategy.mjs";
import { SHADOW_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { calculatePerformance } from "./paper-engine.mjs";
import { runChampionChallengerComparison, runHistoricalReplay } from "./replay-engine.mjs";
import { runValidationEngine } from "./validation-engine.mjs";
import { BAR_MS, hashObject, readJson, round, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAMPION_HASH = "9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6";

export function generateStrategyCandidates(base = CHALLENGER_BASE_PARAMETERS) {
  const patches = [
    { label: "base", patch: {} },
    { label: "earlier-signal", patch: { immediateThreshold: base.immediateThreshold - 2 } },
    { label: "later-signal", patch: { immediateThreshold: base.immediateThreshold + 2 } },
    { label: "tighter-atr", patch: { stopAtrMultiple: base.stopAtrMultiple * 0.9 } },
    { label: "wider-atr", patch: { stopAtrMultiple: base.stopAtrMultiple * 1.1 } },
    { label: "no-regime-filter", patch: { regimeFilterEnabled: false } }
  ];
  return patches.map((item, index) => {
    const parameters = { ...base, ...item.patch, version: `candidate-${String(index + 1).padStart(2, "0")}-${item.label}-v1` };
    return { id: parameters.version, label: item.label, parameters, parameterHash: hashObject(parameters) };
  });
}

function candidateScore(report) {
  const performance = report.performance;
  const tradePenalty = report.tradeCount < 10 ? (10 - report.tradeCount) * 0.5 : 0;
  return round(Number(performance.cumulativeReturnPct) - Number(performance.maxDrawdownPct)
    + Number(performance.tradeSharpe ?? 0) * 0.5 - tradePenalty, 6);
}

function replaySummary(report) {
  return {
    strategyVersion: report.strategyVersion, strategyHash: report.strategyHash,
    eventCount: report.eventCount, tradeCount: report.tradeCount,
    performance: report.performance, tradeHash: hashObject(report.trades), eventStreamHash: report.eventStreamHash
  };
}

async function liveShadowEvidence() {
  try {
    await access(SHADOW_CONFIG.databasePath);
    const db = openPaperDatabase(SHADOW_CONFIG.databasePath, undefined, { readOnly: true });
    try {
      const snapshots = db.getSnapshots();
      const first = snapshots[0]?.captured_at;
      const last = snapshots.at(-1)?.captured_at;
      const calendarDays = first && last ? (new Date(last) - new Date(first)) / DAY_MS : 0;
      return {
        databasePath: SHADOW_CONFIG.databasePath,
        snapshots: snapshots.length,
        signals: snapshots.filter((item) => item.decision !== "WAIT").length,
        calendarDays: round(calendarDays, 4),
        performance: calculatePerformance(db),
        paperOnly: true,
        independentDatabase: true
      };
    } finally { db.close(); }
  } catch (error) {
    return { databasePath: SHADOW_CONFIG.databasePath, snapshots: 0, signals: 0, calendarDays: 0, paperOnly: true, independentDatabase: true, unavailableReason: error.message };
  }
}

export async function runStrategyOptimization(dataset, {
  outputDirectory,
  candidates = generateStrategyCandidates(),
  robustnessIterations = 500,
  onProgress = null
} = {}) {
  if (!outputDirectory) throw new Error("Optimization requires an output directory for immutable version artifacts");
  const start = new Date(dataset.manifest.requestedCoverage.from).getTime();
  const end = new Date(dataset.manifest.requestedCoverage.to).getTime();
  const span = end - start;
  const selectionStart = Math.floor((start + span * 0.5) / BAR_MS) * BAR_MS;
  const selectionEnd = Math.floor((start + span * 0.72) / BAR_MS) * BAR_MS;
  const finalOosStart = Math.floor((start + span * 0.75) / BAR_MS) * BAR_MS;
  const trainEnd = selectionStart - 8 * DAY_MS;
  const ranges = {
    training: { from: new Date(start).toISOString(), to: new Date(trainEnd).toISOString() },
    trainingPurgeEmbargo: { from: new Date(trainEnd + BAR_MS).toISOString(), to: new Date(selectionStart - BAR_MS).toISOString(), bars: Math.round((selectionStart - trainEnd) / BAR_MS) },
    selectionValidation: { from: new Date(selectionStart).toISOString(), to: new Date(selectionEnd).toISOString() },
    finalOosEmbargo: { from: new Date(selectionEnd + BAR_MS).toISOString(), to: new Date(finalOosStart - BAR_MS).toISOString(), bars: Math.round((finalOosStart - selectionEnd) / BAR_MS) },
    finalOutOfSample: { from: new Date(finalOosStart).toISOString(), to: new Date(end).toISOString() }
  };
  const challengerCode = await readFile(new URL("./challenger-strategy.mjs", import.meta.url), "utf8");
  const analysisCode = await readFile(new URL("./analysis-engine.mjs", import.meta.url), "utf8");
  if (sha256(analysisCode).toUpperCase() !== CHAMPION_HASH) throw new Error("Frozen V1.2 Champion hash changed; optimization aborted");
  const experiments = [];
  for (const candidate of candidates) {
    onProgress?.({ stage: "candidate", status: "started", candidate: candidate.id });
    const candidateDirectory = join(outputDirectory, "candidates", candidate.id);
    const training = await runHistoricalReplay(dataset, {
      strategy: "challenger", parameters: candidate.parameters,
      from: ranges.training.from, to: ranges.training.to,
      collectTrace: false,
      outputDirectory: join(candidateDirectory, "historical-replay")
    });
    const selectionValidation = await runHistoricalReplay(dataset, {
      strategy: "challenger", parameters: candidate.parameters,
      from: ranges.selectionValidation.from, to: ranges.selectionValidation.to,
      collectTrace: false,
      outputDirectory: join(candidateDirectory, "purged-selection-validation")
    });
    experiments.push({
      ...candidate,
      strategyCodeHash: sha256(challengerCode),
      dataManifestHash: dataset.manifest.manifestHash,
      ranges,
      stages: {
        candidateGenerated: "COMPLETED",
        historicalReplay: { status: "COMPLETED", result: replaySummary(training) },
        purgedSelectionValidation: { status: "COMPLETED", result: replaySummary(selectionValidation) }
      },
      rankingScore: candidateScore(selectionValidation),
      eliminated: selectionValidation.tradeCount < 5,
      eliminationReason: selectionValidation.tradeCount < 5 ? "fewer than 5 purged selection-validation trades" : null
    });
    onProgress?.({ stage: "candidate", status: "completed", candidate: candidate.id, validationTrades: selectionValidation.tradeCount, rankingScore: candidateScore(selectionValidation) });
  }
  const eligible = experiments.filter((item) => !item.eliminated).sort((a, b) => b.rankingScore - a.rankingScore);
  const selected = eligible[0] ?? experiments.sort((a, b) => b.rankingScore - a.rankingScore)[0];
  onProgress?.({ stage: "selection", status: "completed", candidate: selected.id });
  const validation = await runValidationEngine(dataset, {
    candidateParameters: selected.parameters,
    outputDirectory: join(outputDirectory, "selected", "validation")
  });
  onProgress?.({ stage: "validation", status: "completed", passed: validation.passed });
  const baselineFinalOos = await runHistoricalReplay(dataset, {
    strategy: "challenger",
    parameters: { ...CHALLENGER_BASE_PARAMETERS, version: "challenger-final-oos-baseline", regimeFilterEnabled: false },
    from: ranges.finalOutOfSample.from, to: ranges.finalOutOfSample.to,
    collectTrace: false,
    outputDirectory: join(outputDirectory, "selected", "final-oos-baseline")
  });
  const selectedReplay = await runHistoricalReplay(dataset, {
    strategy: "challenger", parameters: selected.parameters,
    from: ranges.finalOutOfSample.from, to: ranges.finalOutOfSample.to,
    collectTrace: false,
    outputDirectory: join(outputDirectory, "selected", "strict-final-oos")
  });
  const finalOosIncremental = {
    netReturnPct: round(selectedReplay.performance.cumulativeReturnPct - baselineFinalOos.performance.cumulativeReturnPct, 4),
    tradeSharpe: round(Number(selectedReplay.performance.tradeSharpe ?? 0) - Number(baselineFinalOos.performance.tradeSharpe ?? 0), 4),
    profitFactor: round(Number(selectedReplay.performance.profitFactor ?? 0) - Number(baselineFinalOos.performance.profitFactor ?? 0), 4),
    maxDrawdownPct: round(selectedReplay.performance.maxDrawdownPct - baselineFinalOos.performance.maxDrawdownPct, 4)
  };
  onProgress?.({ stage: "final-oos", status: "completed", candidate: selected.id });
  const robustness = await runMonteCarloRobustness(dataset, selectedReplay, {
    parameters: selected.parameters,
    from: ranges.finalOutOfSample.from, to: ranges.finalOutOfSample.to,
    iterations: robustnessIterations,
    outputDirectory: join(outputDirectory, "selected", "robustness")
  });
  onProgress?.({ stage: "robustness", status: "completed", result: robustness.status });
  const shadowComparison = await runChampionChallengerComparison(dataset, {
    parameters: selected.parameters,
    from: ranges.finalOutOfSample.from,
    to: ranges.finalOutOfSample.to,
    outputDirectory: join(outputDirectory, "selected", "historical-shadow")
  });
  const shadowComparisonSummary = {
    runType: shadowComparison.runType,
    sameEvents: shadowComparison.sameEvents,
    isolation: shadowComparison.isolation,
    champion: replaySummary(shadowComparison.champion),
    challenger: replaySummary(shadowComparison.challenger)
  };
  const liveShadow = await liveShadowEvidence();
  onProgress?.({ stage: "shadow", status: "completed", calendarDays: liveShadow.calendarDays, signals: liveShadow.signals });
  const promotionReasons = [];
  if (!validation.passed) promotionReasons.push(...validation.gateReasons.map((reason) => `validation: ${reason}`));
  if (!(finalOosIncremental.tradeSharpe >= 0.05)) promotionReasons.push(`strict final OOS Sharpe delta ${finalOosIncremental.tradeSharpe} is below 0.05`);
  if (!(finalOosIncremental.netReturnPct >= 0)) promotionReasons.push(`strict final OOS net return delta ${finalOosIncremental.netReturnPct}% is negative`);
  if (robustness.status !== "ok") promotionReasons.push(`robustness: ${robustness.reason}`);
  if (liveShadow.calendarDays < 30) promotionReasons.push(`live Shadow Paper only ${liveShadow.calendarDays} calendar days; minimum 30`);
  if (liveShadow.signals < 100) promotionReasons.push(`live Shadow has ${liveShadow.signals} signals; minimum 100`);
  const promotion = {
    status: promotionReasons.length ? "BLOCKED" : "ELIGIBLE_FOR_EXPLICIT_APPROVAL",
    automaticChampionReplacement: false,
    reasons: promotionReasons.length ? promotionReasons : ["All machine gates passed; explicit Paper administrator approval would still be required."],
    evaluatedAt: new Date().toISOString()
  };
  selected.stages.walkForwardPurgedOos = { status: "COMPLETED", passed: validation.passed, evidenceHash: validation.evidence.evidenceHash };
  selected.stages.strictFinalOos = {
    status: "COMPLETED",
    untouchedByCandidateRanking: true,
    baseline: replaySummary(baselineFinalOos),
    candidate: replaySummary(selectedReplay),
    incremental: finalOosIncremental
  };
  selected.stages.stressTest = { status: robustness.status === "ok" ? "COMPLETED" : "BLOCKED", resultHash: hashObject(robustness) };
  selected.stages.shadow = { status: "RUNNING", historicalSameEvents: shadowComparison.sameEvents, liveEvidence: liveShadow };
  selected.stages.promotionGate = promotion;
  const registryPath = join(outputDirectory, "strategy-version-registry.json");
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeChampion: "V1.2-FROZEN",
    champion: {
      version: "V1.2-FROZEN", strategyHash: CHAMPION_HASH, parameters: "source-defined frozen core",
      dataManifestHash: null, trainingRange: null, validationRange: null,
      status: "ACTIVE_UNCHANGED", reason: "User required the existing Champion to remain frozen until a Challenger completes every gate."
    },
    candidates: experiments.map((item) => ({
      version: item.id, parameters: item.parameters, parameterHash: item.parameterHash,
      strategyCodeHash: item.strategyCodeHash, dataManifestHash: item.dataManifestHash,
      trainingRange: item.ranges.training,
      selectionValidationRange: item.ranges.selectionValidation,
      finalOosRange: item.id === selected.id ? ranges.finalOutOfSample : null,
      performance: item.stages.purgedSelectionValidation.result.performance, rankingScore: item.rankingScore,
      status: item.id === selected.id ? "SELECTED_CHALLENGER_SHADOW" : item.eliminated ? "ELIMINATED" : "NOT_SELECTED",
      reason: item.id === selected.id ? "Highest predeclared OOS ranking among non-eliminated candidates; not promoted" : item.eliminationReason ?? "Lower OOS ranking"
    })),
    rollback: {
      implemented: true,
      currentPointer: "V1.2-FROZEN",
      lastKnownChampion: "V1.2-FROZEN",
      commandPolicy: "Rollback can only select a previously registered Champion hash; candidates are never implicit rollback targets."
    }
  };
  registry.registryHash = hashObject(registry);
  await writeJsonAtomic(registryPath, registry);
  const result = {
    runType: "CANDIDATE_TO_PROMOTION_GATED_OPTIMIZATION",
    generatedAt: new Date().toISOString(),
    pipeline: ["Candidate", "Historical Replay", "Walk-forward/Purged OOS", "Stress Test", "Shadow", "Promotion Gate", "Champion"],
    candidateGeneration: { count: candidates.length, boundedGrid: true, mlUsed: false },
    ranges,
    experiments,
    selectedCandidate: selected.id,
    validation,
    strictFinalOos: {
      range: ranges.finalOutOfSample,
      untouchedByCandidateRanking: true,
      baseline: replaySummary(baselineFinalOos),
      candidate: replaySummary(selectedReplay),
      incremental: finalOosIncremental
    },
    robustness,
    shadowComparison: shadowComparisonSummary,
    liveShadow,
    promotion,
    registryPath,
    championChanged: false
  };
  await writeJsonAtomic(join(outputDirectory, "optimization-report.json"), result);
  return result;
}

export async function rollbackStrategyRegistry(registryPath, version) {
  const registry = await readJson(registryPath);
  if (!registry) throw new Error("Strategy registry not found");
  if (version !== registry.champion.version) throw new Error("Rollback may only select a previously registered Champion version");
  registry.activeChampion = version;
  registry.rollback = { ...registry.rollback, rolledBackAt: new Date().toISOString(), currentPointer: version };
  registry.registryHash = hashObject({ ...registry, registryHash: undefined });
  await writeJsonAtomic(registryPath, registry);
  return registry;
}
