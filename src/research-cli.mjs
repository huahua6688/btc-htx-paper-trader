import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHALLENGER_BASE_PARAMETERS, HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { openPaperDatabase } from "./db.mjs";
import { runCounterfactualReview } from "./counterfactual-review.mjs";
import { auditExternalMarketFeatures } from "./external-features.mjs";
import { datasetView, runCurrentChallengerDiagnosis } from "./edge-diagnosis.mjs";
import { runEdgeCandidatePipeline } from "./edge-candidate-pipeline.mjs";
import { runHistoricalFeatureAblation } from "./feature-ablation.mjs";
import { defaultCatalogDirectory, loadHistoricalDataset, updateHistoricalDataset } from "./historical-data.mjs";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { runStrategyOptimization } from "./optimization-engine.mjs";
import { runChampionChallengerComparison, runHistoricalReplay } from "./replay-engine.mjs";
import { buildHistoricalFeatureMatrix, queryHistoricalSimilarity } from "./similarity-engine.mjs";
import { readJson, resolveOutputPath, writeJsonAtomic } from "./research-utils.mjs";
import { runValidationEngine } from "./validation-engine.mjs";
import { runTradableEdgePipeline } from "./tradable-edge-pipeline.mjs";
import { ANTI_CHASE_PARAMETERS } from "./anti-chase-challenger.mjs";
import { buildTradeAttribution } from "./attribution-engine.mjs";

export const PREDECLARED_RESEARCH_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-07-31T23:45:00.000Z",
  selectionPolicy: "contiguous predeclared range ending before this implementation run; not selected from backtest performance"
});

export const ANTI_CHASE_DEVELOPMENT_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-01-17T06:30:00.000Z",
  selectionPolicy: "predeclared development-only interval; previously consumed Final OOS is excluded and no new holdout is opened"
});

function argumentsMap(argv = process.argv.slice(3)) {
  return Object.fromEntries(argv.filter((item) => item.startsWith("--")).map((item) => {
    const [key, ...rest] = item.slice(2).split("=");
    return [key, rest.length ? rest.join("=") : true];
  }));
}

function range(args, defaults = null) {
  const from = args.from ?? defaults?.from;
  const to = args.to ?? defaults?.to;
  if (!from || !to) throw new Error("Both --from=<ISO> and --to=<ISO> are required. Use the full command for the predeclared multi-regime range.");
  return { from, to };
}

function runId(prefix) { return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`; }

async function save(path, value) {
  await writeJsonAtomic(path, value);
  return path;
}

function compactReplay(report) {
  return {
    strategy: report.strategy, strategyVersion: report.strategyVersion, strategyHash: report.strategyHash,
    dataManifestHash: report.dataManifestHash, requestedRange: report.requestedRange,
    effectiveRange: report.effectiveRange, eventCount: report.eventCount, tradeCount: report.tradeCount,
    pointInTimeGuarantees: report.pointInTimeGuarantees, assumptions: report.assumptions,
    performance: report.performance, actionCounts: report.actionCounts, limitations: report.limitations,
    traceHash: report.trace.length ? report.trace.length + ":" + report.trace[0].timestamp + ":" + report.trace.at(-1).timestamp : "empty"
  };
}

async function dataUpdate(args, defaults = null) {
  const selected = range(args, defaults);
  let lastProgress = "";
  const result = await updateHistoricalDataset({
    ...selected,
    directory: args.catalog ?? defaultCatalogDirectory(),
    concurrency: Number(args.concurrency ?? 3),
    onProgress: (item) => {
      const message = item.type === "kline" ? `Kline ${item.completed}/${item.total}` : `Funding page ${item.completed}`;
      if (message !== lastProgress) process.stderr.write(`${message}\n`);
      lastProgress = message;
    }
  });
  process.stdout.write(`${JSON.stringify({ directory: result.directory, fetched: result.fetched, manifest: result.manifest }, null, 2)}\n`);
  return result;
}

async function load(args) { return loadHistoricalDataset(args.catalog ?? defaultCatalogDirectory()); }

async function backtest(args) {
  const dataset = await load(args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId("backtest"));
  await mkdir(directory, { recursive: true });
  const comparison = await runChampionChallengerComparison(dataset, { ...selected, outputDirectory: directory });
  const championPath = await save(join(directory, "champion-backtest.json"), comparison.champion);
  const challengerPath = await save(join(directory, "challenger-backtest.json"), comparison.challenger);
  const comparisonPath = await save(join(directory, "comparison.json"), {
    runType: comparison.runType, sameEvents: comparison.sameEvents, isolation: comparison.isolation,
    champion: compactReplay(comparison.champion), challenger: compactReplay(comparison.challenger)
  });
  process.stdout.write(`${JSON.stringify({ directory, championPath, challengerPath, comparisonPath, sameEvents: comparison.sameEvents, champion: compactReplay(comparison.champion), challenger: compactReplay(comparison.challenger) }, null, 2)}\n`);
  return { dataset, comparison, directory };
}

async function validation(args) {
  const dataset = await load(args);
  const directory = resolveOutputPath(runId("validation"));
  const report = await runValidationEngine(dataset, { outputDirectory: directory });
  const path = await save(join(directory, "validation-report.json"), report);
  process.stdout.write(`${JSON.stringify({ path, passed: report.passed, gateReasons: report.gateReasons, evidence: report.evidence, windows: report.windows.map((item) => ({ index: item.index, trainEnd: item.trainEnd, testStart: item.testStart, incremental: item.incremental, baselineTrades: item.baseline.tradeCount, candidateTrades: item.candidate.tradeCount })), lookahead: { passed: report.lookaheadAudit.passed, checksRun: report.lookaheadAudit.checksRun } }, null, 2)}\n`);
  return { dataset, report, directory };
}

async function similarity(args) {
  const dataset = await load(args);
  const matrix = buildHistoricalFeatureMatrix(dataset);
  const query = queryHistoricalSimilarity(dataset, matrix, { at: args.at ?? undefined });
  const directory = resolveOutputPath(runId("similarity"));
  await mkdir(directory, { recursive: true });
  const matrixPath = await save(join(directory, "feature-matrix.json"), matrix);
  const queryPath = await save(join(directory, "similarity-query.json"), query);
  process.stdout.write(`${JSON.stringify({ matrixPath, queryPath, matrixRows: matrix.rows.length, matrixHash: matrix.matrixHash, query }, null, 2)}\n`);
  return { dataset, matrix, query, directory };
}

async function robustness(args) {
  const dataset = await load(args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId("robustness"));
  const replay = await runHistoricalReplay(dataset, { strategy: "challenger", parameters: CHALLENGER_BASE_PARAMETERS, ...selected, outputDirectory: join(directory, "base") });
  const report = await runMonteCarloRobustness(dataset, replay, { parameters: CHALLENGER_BASE_PARAMETERS, ...selected, iterations: Number(args.iterations ?? 2_000), outputDirectory: join(directory, "scenarios") });
  const path = await save(join(directory, "robustness-report.json"), report);
  process.stdout.write(`${JSON.stringify({ path, report }, null, 2)}\n`);
  return { dataset, replay, report, directory };
}

async function counterfactual(args) {
  const dataset = await load(args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId("counterfactual"));
  const replay = args.replay
    ? await readJson(args.replay)
    : await runHistoricalReplay(dataset, { strategy: "challenger", parameters: CHALLENGER_BASE_PARAMETERS, ...selected, outputDirectory: join(directory, "replay") });
  if (!replay?.trace || !replay?.trades) throw new Error("Counterfactual source replay must contain real trace and trade records");
  const report = runCounterfactualReview(dataset, replay);
  const path = await save(join(directory, "counterfactual-report.json"), report);
  process.stdout.write(`${JSON.stringify({ path, decisionCount: report.decisionCount, waitTracked: report.waitTracked, tradesReviewed: report.tradeReviews.length, aggregate: report.aggregate }, null, 2)}\n`);
  return { dataset, replay, report, directory };
}

async function externalAudit(args) {
  const directory = resolveOutputPath(runId("external-features"));
  await mkdir(directory, { recursive: true });
  const report = await auditExternalMarketFeatures({ directory });
  const db = openPaperDatabase(args.db);
  try { db.applyResearchFeatureAudit(report.features, report.generatedAt); } finally { db.close(); }
  process.stdout.write(`${JSON.stringify({ directory, report }, null, 2)}\n`);
  return report;
}

async function optimize(args) {
  const dataset = await load(args);
  const directory = resolveOutputPath(runId("optimization"));
  const report = await runStrategyOptimization(dataset, {
    outputDirectory: directory,
    robustnessIterations: Number(args.iterations ?? 500),
    onProgress: (item) => process.stderr.write(`Optimization ${item.stage} ${item.status}${item.candidate ? `: ${item.candidate}` : ""}\n`)
  });
  process.stdout.write(`${JSON.stringify({ directory, selectedCandidate: report.selectedCandidate, promotion: report.promotion, championChanged: report.championChanged, registryPath: report.registryPath, validation: { passed: report.validation.passed, evidence: report.validation.evidence }, robustness: { status: report.robustness.status, base: report.robustness.base }, shadow: report.shadowComparison }, null, 2)}\n`);
  return report;
}

async function diagnose(args) {
  const dataset = await load(args);
  const selected = range(args, PREDECLARED_RESEARCH_RANGE);
  const directory = resolveOutputPath(runId("edge-diagnosis"));
  const report = await runCurrentChallengerDiagnosis(dataset, {
    ...selected,
    outputDirectory: directory,
    onProgress: (item) => process.stderr.write(`Diagnosis ${item.stage} ${item.status}\n`)
  });
  process.stdout.write(`${JSON.stringify({
    directory,
    reportPath: join(directory, "challenger-diagnosis.json"),
    overall: report.attribution.overall,
    costAttribution: report.attribution.costAttribution,
    stableSubsets: report.attribution.stableSubsets,
    diagnosis: report.diagnosis
  }, null, 2)}\n`);
  return report;
}

async function ablation(args) {
  const dataset = await load(args);
  const selected = range(args, PREDECLARED_RESEARCH_RANGE);
  const view = datasetView(dataset, selected);
  const directory = resolveOutputPath(runId("feature-ablation"));
  const report = await runHistoricalFeatureAblation(view, {
    outputDirectory: directory,
    onProgress: (item) => process.stderr.write(`Ablation ${item.featureSet} window ${item.window}\n`)
  });
  process.stdout.write(`${JSON.stringify({
    directory,
    reportPath: join(directory, "feature-ablation-report.json"),
    historicalCompatibleChampion: report.historicalCompatibleChampion,
    incremental: report.incremental
  }, null, 2)}\n`);
  return report;
}

async function edgePipeline(args) {
  if (!args.diagnosis || !args.ablation) throw new Error("edge:pipeline requires --diagnosis=<json> and --ablation=<json>");
  const dataset = await load(args);
  const diagnosisReport = await readJson(args.diagnosis);
  const ablationReport = await readJson(args.ablation);
  if (!diagnosisReport || !ablationReport) throw new Error("Diagnosis or ablation report could not be loaded");
  const directory = resolveOutputPath(runId("edge-candidate-pipeline"));
  const report = await runEdgeCandidatePipeline(dataset, {
    diagnosis: diagnosisReport,
    ablation: ablationReport,
    outputDirectory: directory,
    robustnessIterations: Number(args.iterations ?? 500),
    onProgress: (item) => process.stderr.write(`Edge pipeline ${item.stage} ${item.status ?? ""}${item.candidate ? ` ${item.candidate}` : ""}${item.window ? ` window ${item.window}` : ""}\n`)
  });
  process.stdout.write(`${JSON.stringify({
    directory,
    reportPath: join(directory, "edge-candidate-pipeline.json"),
    selected: report.development.selected,
    development: report.development.selectedMetrics,
    finalOos: report.untouchedFinalOos,
    robustness: report.robustness,
    shadow: report.shadow,
    promotion: report.promotion
  }, null, 2)}\n`);
  return report;
}

async function tradableEdge(args) {
  const dataset = await load(args);
  const diagnosisReport = args.diagnosis ? await readJson(args.diagnosis) : null;
  const directory = resolveOutputPath(runId("tradable-edge"));
  const report = await runTradableEdgePipeline(dataset, {
    outputDirectory: directory,
    diagnosis: diagnosisReport,
    sampleStrideBars: Number(args.stride ?? 4),
    onProgress: (item) => process.stderr.write(`Tradable Edge ${item.stage} ${item.status ?? ""}${item.window ? ` window ${item.window}` : ""}${item.profile ? ` ${item.profile}` : ""}${item.completed ? ` ${item.completed}` : ""}\n`)
  });
  process.stdout.write(`${JSON.stringify({
    directory,
    reportPath: join(directory, "tradable-edge-report.json"),
    development: report.development,
    scoreCalibration: {
      oldDirectionalScore: {
        combinedSpearmanVsNetExpectancy: report.scoreCalibration.oldDirectionalScore.combinedSpearmanVsNetExpectancy,
        walkForwardSpearman: report.scoreCalibration.oldDirectionalScore.walkForwardSpearman,
        stableMonotonicRelationship: report.scoreCalibration.oldDirectionalScore.stableMonotonicRelationship
      },
      opportunityIndex: {
        combinedSpearmanVsNetExpectancy: report.scoreCalibration.redesignedScore.combinedSpearmanVsNetExpectancy,
        walkForwardSpearman: report.scoreCalibration.redesignedScore.walkForwardSpearman,
        stableMonotonicRelationship: report.scoreCalibration.redesignedScore.stableMonotonicRelationship
      }
    },
    frequencyAndCost: {
      baseline: Object.fromEntries(["totalTrades", "positiveWindows", "grossPnlCny", "totalCostsCny", "netPnlCny", "netExpectancyPct", "profitFactor", "maximumDrawdownPct", "costToAbsoluteGrossPct", "stablePositiveOosEdge"]
        .map((key) => [key, report.frequencyAndCost.baseline[key]])),
      profiles: report.frequencyAndCost.profiles.map((profile) => ({
        id: profile.id, minimumNetEdgePct: profile.minimumNetEdgePct, totalTrades: profile.totalTrades,
        positiveWindows: profile.positiveWindows, grossPnlCny: profile.grossPnlCny,
        totalCostsCny: profile.totalCostsCny, netPnlCny: profile.netPnlCny,
        netExpectancyPct: profile.netExpectancyPct, profitFactor: profile.profitFactor,
        maximumDrawdownPct: profile.maximumDrawdownPct,
        costToAbsoluteGrossPct: profile.costToAbsoluteGrossPct,
        stablePositiveOosEdge: profile.stablePositiveOosEdge
      })),
      overtrading: report.frequencyAndCost.overtrading
    },
    candidate: report.candidate,
    nextUntouchedHoldout: report.nextUntouchedHoldout.holdout,
    conclusion: report.conclusion
  }, null, 2)}\n`);
  return report;
}

async function antiChase(args) {
  const dataset = await load(args);
  const selected = range(args, ANTI_CHASE_DEVELOPMENT_RANGE);
  const directory = resolveOutputPath(runId("anti-chase"));
  await mkdir(directory, { recursive: true });
  const baseline = await runHistoricalReplay(dataset, {
    strategy: "historical-compatible", parameters: HISTORICAL_COMPATIBLE_PARAMETERS,
    ...selected, outputDirectory: join(directory, "baseline")
  });
  const candidate = await runHistoricalReplay(dataset, {
    strategy: "anti-chase", parameters: ANTI_CHASE_PARAMETERS,
    ...selected, outputDirectory: join(directory, "candidate")
  });
  const blockedSignals = candidate.trace.filter((item) => item.entryQuality?.blocked).length;
  const entryGeometry = candidate.trace.reduce((summary, item) => {
    const quality = item.entryQuality;
    if (!quality?.side) return summary;
    summary.evaluated += 1;
    if (quality.blocked) summary.blocked += 1;
    else summary.eligible += 1;
    const category = quality.entryType === "INSUFFICIENT_GEOMETRY" ? "INSUFFICIENT_GEOMETRY"
      : quality.clusteredChase && quality.blocked ? "CLUSTERED_CHASE"
        : quality.blocked ? "INSUFFICIENT_NET_ROOM"
          : quality.validFreshBreakout ? "ELIGIBLE_FRESH_BREAKOUT"
            : quality.validRetest ? "ELIGIBLE_RETEST"
              : quality.recoveryNearMean ? "ELIGIBLE_MEAN_RECOVERY" : "ELIGIBLE_BALANCED_DIRECT";
    summary.reasonCounts[category] = (summary.reasonCounts[category] ?? 0) + 1;
    return summary;
  }, { evaluated: 0, eligible: 0, blocked: 0, reasonCounts: {} });
  const report = {
    schemaVersion: 1,
    runType: "ANTI_CHASE_DEVELOPMENT_AUDIT",
    generatedAt: new Date().toISOString(),
    developmentRange: { ...selected, selectionPolicy: ANTI_CHASE_DEVELOPMENT_RANGE.selectionPolicy },
    dataManifestHash: dataset.manifest.manifestHash,
    sameEvents: baseline.eventStreamHash === candidate.eventStreamHash && baseline.eventCount === candidate.eventCount,
    frozenChampionChanged: false,
    finalOosOpened: false,
    parameters: ANTI_CHASE_PARAMETERS,
    baseline: compactReplay(baseline),
    candidate: compactReplay(candidate),
    chaseAudit: {
      blockedSignals,
      blockedPct: candidate.eventCount ? blockedSignals / candidate.eventCount * 100 : 0,
      entryGeometry,
      attribution: buildTradeAttribution(candidate)
    },
    promotion: { eligible: false, reason: "development diagnosis only; requires purged walk-forward, new untouched OOS and Shadow before promotion" },
    safety: { paperOnly: true, privateHtxApi: false, exchangeWriteOperations: false }
  };
  const reportPath = await save(join(directory, "anti-chase-report.json"), report);
  process.stdout.write(`${JSON.stringify({ directory, reportPath, sameEvents: report.sameEvents, blockedSignals, entryGeometry, baseline: compactReplay(baseline), candidate: compactReplay(candidate), promotion: report.promotion }, null, 2)}\n`);
  return report;
}

async function full(args) {
  const selected = range(args, PREDECLARED_RESEARCH_RANGE);
  await dataUpdate(args, PREDECLARED_RESEARCH_RANGE);
  const dataset = await load(args);
  const directory = resolveOutputPath(runId("full-research"));
  await mkdir(directory, { recursive: true });
  const external = await auditExternalMarketFeatures({ directory: join(directory, "external") });
  const registryDb = openPaperDatabase(args.db);
  try { registryDb.applyResearchFeatureAudit(external.features, external.generatedAt); } finally { registryDb.close(); }
  const comparison = await runChampionChallengerComparison(dataset, { ...selected, outputDirectory: join(directory, "same-event") });
  await save(join(directory, "champion-backtest.json"), comparison.champion);
  await save(join(directory, "challenger-backtest.json"), comparison.challenger);
  const matrix = buildHistoricalFeatureMatrix(dataset);
  await save(join(directory, "feature-matrix.json"), matrix);
  const similarityResult = queryHistoricalSimilarity(dataset, matrix);
  await save(join(directory, "similarity-query.json"), similarityResult);
  const optimization = await runStrategyOptimization(dataset, {
    outputDirectory: join(directory, "optimization"),
    robustnessIterations: Number(args.iterations ?? 500),
    onProgress: (item) => process.stderr.write(`Optimization ${item.stage} ${item.status}${item.candidate ? `: ${item.candidate}` : ""}\n`)
  });
  const counterfactualReport = runCounterfactualReview(dataset, comparison.challenger);
  await save(join(directory, "counterfactual-report.json"), counterfactualReport);
  const acceptance = {
    generatedAt: new Date().toISOString(),
    predeclaredRange: { ...selected, selectionPolicy: PREDECLARED_RESEARCH_RANGE.selectionPolicy },
    datasetManifest: dataset.manifest,
    champion: compactReplay(comparison.champion),
    challenger: compactReplay(comparison.challenger),
    sameEvents: comparison.sameEvents,
    validation: { passed: optimization.validation.passed, evidence: optimization.validation.evidence, gateReasons: optimization.validation.gateReasons },
    lookaheadAudit: { passed: optimization.validation.lookaheadAudit.passed, checksRun: optimization.validation.lookaheadAudit.checksRun },
    monteCarlo: optimization.robustness,
    similarity: similarityResult,
    externalFeatures: external.features,
    optimization: { selectedCandidate: optimization.selectedCandidate, promotion: optimization.promotion, championChanged: false, registryPath: optimization.registryPath },
    counterfactual: { decisions: counterfactualReport.decisionCount, waits: counterfactualReport.waitTracked, trades: counterfactualReport.tradeReviews.length, aggregate: counterfactualReport.aggregate },
    safety: { paperOnly: true, htxPrivateApi: false, exchangeCredentials: false, exchangeWriteOperations: false }
  };
  const acceptancePath = await save(join(directory, "ACCEPTANCE_RESULTS.json"), acceptance);
  process.stdout.write(`${JSON.stringify({ directory, acceptancePath, acceptance }, null, 2)}\n`);
  return acceptance;
}

const command = process.argv[2] ?? "data:inspect";
const args = argumentsMap();
try {
  if (command === "data:update") await dataUpdate(args);
  else if (command === "data:inspect") {
    const dataset = await load(args);
    process.stdout.write(`${JSON.stringify({ directory: dataset.directory, manifest: dataset.manifest }, null, 2)}\n`);
  } else if (command === "backtest") await backtest(args);
  else if (command === "validate") await validation(args);
  else if (command === "similarity") await similarity(args);
  else if (command === "robustness") await robustness(args);
  else if (command === "counterfactual") await counterfactual(args);
  else if (command === "external:audit") await externalAudit(args);
  else if (command === "optimize") await optimize(args);
  else if (command === "diagnose") await diagnose(args);
  else if (command === "ablation") await ablation(args);
  else if (command === "edge:pipeline") await edgePipeline(args);
  else if (command === "tradable-edge") await tradableEdge(args);
  else if (command === "anti-chase") await antiChase(args);
  else if (command === "full") await full(args);
  else throw new Error(`Unknown research command: ${command}`);
} catch (error) {
  process.stderr.write(`Research command failed safely: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
