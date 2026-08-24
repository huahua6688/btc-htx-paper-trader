import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHALLENGER_BASE_PARAMETERS, HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { openPaperDatabase } from "./db.mjs";
import { runCounterfactualReview } from "./counterfactual-review.mjs";
import { auditExternalMarketFeatureCatalog } from "./external-feature-catalog.mjs";
import { datasetView, runCurrentChallengerDiagnosis } from "./edge-diagnosis.mjs";
import { runEdgeCandidatePipeline } from "./edge-candidate-pipeline.mjs";
import { runHistoricalFeatureAblation } from "./feature-ablation.mjs";
import { defaultCatalogDirectory, loadHistoricalDataset, updateHistoricalDataset } from "./historical-data.mjs";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { runStrategyOptimization } from "./optimization-engine.mjs";
import {
  CAPITAL_PROFILES,
  DEFAULT_REFERENCE_CAPITAL_CNY,
  REPLAY_STRATEGIES,
  runChampionChallengerComparison,
  runHistoricalReplay
} from "./replay-engine.mjs";
import { DATA_TIERED_PARAMETERS } from "./data-tiered-strategy.mjs";
import { buildHistoricalFeatureMatrix, queryHistoricalSimilarity } from "./similarity-engine.mjs";
import { readJson, resolveOutputPath, writeJsonAtomic } from "./research-utils.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import {
  RESEARCH_REGISTRY,
  recordResearchRun,
  registerResearchStrategyVersion,
  withResearchRegistry
} from "./research-registry.mjs";
import { runResearchV2Pipeline } from "./research-v2-pipeline.mjs";
import { runResearchV3Pipeline } from "./research-v3-pipeline.mjs";
import { runValidationEngine } from "./validation-engine.mjs";
import { runTradableEdgePipeline } from "./tradable-edge-pipeline.mjs";
import { ANTI_CHASE_PARAMETERS } from "./anti-chase-challenger.mjs";
import { buildTradeAttribution } from "./attribution-engine.mjs";
import {
  defaultMultiVenueCatalogDirectory,
  loadMultiVenueFundingDataset,
  updateMultiVenueFundingDataset
} from "./multi-venue-catalog.mjs";
import { MULTI_VENUE_CHALLENGER_PARAMETERS } from "./multi-venue-challenger.mjs";
import { BREAKOUT_V4_PARAMETERS } from "./breakout-challenger.mjs";

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

/**
 * 研究登记簿位于 src/research-registry.mjs，Telegram 也只读地共用它。
 * 这里不再自建一份打开逻辑，避免出现「CLI 写这个库、面板读另一个库」的错位。
 */
export { RESEARCH_REGISTRY, researchRegistrySnapshot } from "./research-registry.mjs";
export function researchRegistryPath() { return RESEARCH_REGISTRY.path; }

/**
 * 把一次失败归类成 BLOCKED 还是 FAILED。
 *
 *   BLOCKED —— 已知的外部前置条件缺失：本地数据目录不存在、公网端点不可达、
 *              holdout 尚未成熟。代码本身没有问题，换个环境就能跑。
 *   FAILED  —— 代码异常、断言失败、内部逻辑错误、参数用法错误。
 *              这类必须暴露出来，绝不允许被 BLOCKED 掩盖。
 *
 * 默认是 FAILED：只有明确匹配到外部前置条件才降级为 BLOCKED。
 */
export function classifyResearchFailure(error) {
  const message = String(error?.message ?? error ?? "");
  const code = String(error?.code ?? "");
  const missingArtifact = /\bENOENT\b|no such file or directory/i.test(message) || code === "ENOENT";
  const networkUnreachable = /\bHTTP (?:401|403|407|408|429|5\d{2})\b|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network|Blocked non-HTX historical URL/i.test(message)
    || ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
    || error?.name === "AbortError" || error?.name === "TimeoutError";
  const immatureHoldout = /holdout .*(?:not mature|immature|UNTOUCHED|insufficient)|尚未成熟|not enough bars/i.test(message);
  if (missingArtifact) {
    return {
      status: "BLOCKED",
      interpretation: "本地历史数据目录不存在（data/research 未提交 Git），需要先运行 data:update"
    };
  }
  if (networkUnreachable) {
    return {
      status: "BLOCKED",
      interpretation: "无法访问 HTX 公开历史端点，本环境网络策略不允许出站到 api.hbdm.com"
    };
  }
  if (immatureHoldout) {
    return { status: "BLOCKED", interpretation: "未触碰 Final OOS 尚未成熟，按规则不得提前打开" };
  }
  return {
    status: "FAILED",
    interpretation: "代码异常/断言失败/内部逻辑错误，不是外部前置条件问题"
  };
}

/**
 * 登记一次研究运行。status 必须如实反映真实结果：
 * PASSED / PARTIAL / FAILED / BLOCKED，绝不允许为了让计数变成 1 而伪造 PASSED。
 */
export async function persistResearchRun(record) {
  return recordResearchRun(record);
}

async function recordRun(runType, startedAt, status, { artifactPath = null, dataManifestHash = null, strategyVersion = null, summary = {} } = {}) {
  try {
    const persisted = await persistResearchRun({
      runType,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      artifactPath,
      dataManifestHash,
      strategyVersion,
      summary
    });
    process.stdout.write(`${JSON.stringify({ researchRunPersisted: { runType, status, ...persisted } })}\n`);
    return persisted;
  } catch (error) {
    // 登记失败不能把已经完成的研究结果吞掉，但必须明确说出来。
    process.stderr.write(`Research run registry write failed: ${error.message}\n`);
    return null;
  }
}

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

async function attachMultiVenue(dataset, args) {
  if (String(args["multi-venue-catalog"] ?? "").toLowerCase() === "none") return { ...dataset, multiVenueFunding: [] };
  const directory = args["multi-venue-catalog"] ?? defaultMultiVenueCatalogDirectory();
  try {
    const multiVenue = await loadMultiVenueFundingDataset(directory);
    return { ...dataset, multiVenueFunding: multiVenue.funding, multiVenueManifest: multiVenue.manifest };
  } catch (error) {
    if (error?.code === "ENOENT" || /manifest not found|no such file/i.test(error.message)) {
      return { ...dataset, multiVenueFunding: [], multiVenueManifest: null };
    }
    throw error;
  }
}

async function multiVenueUpdate(args) {
  const selected = range(args);
  const result = await updateMultiVenueFundingDataset({
    ...selected,
    directory: args["multi-venue-catalog"] ?? defaultMultiVenueCatalogDirectory(),
    onProgress: (item) => process.stderr.write(`Funding ${item.exchange}: ${item.pages} pages / ${item.rows} rows\n`)
  });
  process.stdout.write(`${JSON.stringify({ directory: result.directory, fetched: result.fetched, manifest: result.manifest }, null, 2)}\n`);
  return result;
}

/**
 * 解析研究资金视角。默认 PRODUCTION_FAITHFUL（真实 Paper 资金规模）。
 * --capital=reference 或 --capital=EDGE_REFERENCE_CAPITAL 切到研究参考资金，
 * 可用 --reference-capital=50000 指定金额。参考资金只用于判断 edge 是否存在，
 * 永远不会改变生产 Paper 账户。
 */
export function capitalOptions(args) {
  const raw = String(args.capital ?? "").toUpperCase();
  const capitalProfile = ["REFERENCE", "EDGE", "EDGE_REFERENCE_CAPITAL"].includes(raw)
    ? CAPITAL_PROFILES.EDGE_REFERENCE_CAPITAL
    : CAPITAL_PROFILES.PRODUCTION_FAITHFUL;
  const referenceCapitalCny = args["reference-capital"] !== undefined
    ? Number(args["reference-capital"])
    : DEFAULT_REFERENCE_CAPITAL_CNY;
  return { capitalProfile, referenceCapitalCny };
}

async function backtest(args) {
  const dataset = await load(args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId("backtest"));
  await mkdir(directory, { recursive: true });
  const capital = capitalOptions(args);
  const comparison = await runChampionChallengerComparison(dataset, { ...selected, ...capital, outputDirectory: directory });
  const championPath = await save(join(directory, "champion-backtest.json"), comparison.champion);
  const challengerPath = await save(join(directory, "challenger-backtest.json"), comparison.challenger);
  const comparisonPath = await save(join(directory, "comparison.json"), {
    runType: comparison.runType, sameEvents: comparison.sameEvents, isolation: comparison.isolation,
    champion: compactReplay(comparison.champion), challenger: compactReplay(comparison.challenger)
  });
  process.stdout.write(`${JSON.stringify({ directory, championPath, challengerPath, comparisonPath, sameEvents: comparison.sameEvents, champion: compactReplay(comparison.champion), challenger: compactReplay(comparison.challenger) }, null, 2)}\n`);
  return { dataset, comparison, directory };
}

async function researchV2(args) {
  const dataset = await load(args);
  const directory = resolveOutputPath(runId("research-v2"));
  await mkdir(directory, { recursive: true });
  await mkdir(resolveOutputPath("."), { recursive: true });
  const result = await runResearchV2Pipeline(dataset, {
    outputDirectory: directory,
    // 研究登记簿，不是生产 Paper 库。
    databasePath: researchRegistryPath(),
    // 顶层 run 由这里登记一次；管线内部不再重复登记。
    recordPipelineRun: false
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // 管线成功跑完就是一次真实的研究运行。晋级与否决定 PASSED / PARTIAL，
  // 而不是把「没有晋级」谎报成 BLOCKED —— BLOCKED 只用于跑不起来。
  return { dataset, result, directory };
}

async function researchV3(args) {
  let dataset = await load(args);
  dataset = await attachMultiVenue(dataset, args);
  const directory = resolveOutputPath(runId("research-v3"));
  const result = await runResearchV3Pipeline(dataset, {
    outputDirectory: directory,
    robustnessIterations: Number(args.iterations ?? 1_000)
  });
  process.stdout.write(`${JSON.stringify({ directory, report: result.report }, null, 2)}\n`);
  return { dataset, result, directory };
}

/**
 * 解析 --strategy / --baseline-strategy / --candidate-strategy。
 * 只接受 replay-engine 已登记的策略 id，未知值直接报错而不是悄悄回退到 challenger。
 */
export function strategyOption(args, key, fallback) {
  const raw = args[key];
  if (raw === undefined || raw === true) return fallback;
  const value = String(raw);
  if (!REPLAY_STRATEGIES.includes(value)) {
    throw new Error(`Unknown replay strategy: ${value}. Known: ${REPLAY_STRATEGIES.join(", ")}`);
  }
  return value;
}

function defaultParametersFor(strategy) {
  if (strategy === "data-tiered") return DATA_TIERED_PARAMETERS;
  if (strategy === "historical-compatible") return HISTORICAL_COMPATIBLE_PARAMETERS;
  if (strategy === "anti-chase") return ANTI_CHASE_PARAMETERS;
  if (strategy === "multi-venue-v3") return MULTI_VENUE_CHALLENGER_PARAMETERS;
  if (strategy === "breakout-v4") return BREAKOUT_V4_PARAMETERS;
  return CHALLENGER_BASE_PARAMETERS;
}

/**
 * 单策略逐事件回放。这是 V1.3-DATA-TIERED 进入研究路径的入口：
 *   npm run replay -- --strategy=data-tiered --from=... --to=...
 * 它与实时 monitor 共用同一份 tiered policy，不存在第二套行为实现。
 */
async function replay(args) {
  // 先校验参数再加载数据集：未知策略是用法/逻辑错误（FAILED），
  // 不能因为数据集恰好也不存在而被误判成外部前置条件缺失（BLOCKED）。
  const strategy = strategyOption(args, "strategy", "challenger");
  let dataset = await load(args);
  if (strategy === "multi-venue-v3") dataset = await attachMultiVenue(dataset, args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId(`replay-${strategy}`));
  await mkdir(directory, { recursive: true });
  const capital = capitalOptions(args);
  const report = await runHistoricalReplay(dataset, {
    strategy,
    parameters: defaultParametersFor(strategy),
    ...selected,
    ...capital,
    outputDirectory: directory
  });
  const path = await save(join(directory, `${strategy}-replay.json`), report);
  process.stdout.write(`${JSON.stringify({ path, compact: compactReplay(report), capital: report.capital, entryRejections: report.entryRejections }, null, 2)}\n`);
  return { dataset, report, directory };
}

async function validation(args) {
  const baselineStrategy = strategyOption(args, "baseline-strategy", "challenger");
  const candidateStrategy = strategyOption(args, "candidate-strategy", "challenger");
  let dataset = await load(args);
  if ([baselineStrategy, candidateStrategy].includes("multi-venue-v3")) dataset = await attachMultiVenue(dataset, args);
  const directory = resolveOutputPath(runId("validation"));
  const report = await runValidationEngine(dataset, {
    outputDirectory: directory,
    baselineStrategy,
    candidateStrategy,
    baselineParameters: baselineStrategy === "challenger"
      ? undefined
      : defaultParametersFor(baselineStrategy),
    candidateParameters: defaultParametersFor(candidateStrategy)
  });
  const path = await save(join(directory, "validation-report.json"), report);
  process.stdout.write(`${JSON.stringify({ path, passed: report.passed, gateReasons: report.gateReasons, evidence: report.evidence, windows: report.windows.map((item) => ({ index: item.index, trainEnd: item.trainEnd, testStart: item.testStart, incremental: item.incremental, baselineTrades: item.baseline.tradeCount, candidateTrades: item.candidate.tradeCount })), lookahead: { passed: report.lookaheadAudit.passed, checksRun: report.lookaheadAudit.checksRun } }, null, 2)}\n`);
  return { dataset, report, directory, baselineStrategy, candidateStrategy };
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
  const strategy = strategyOption(args, "strategy", "challenger");
  let dataset = await load(args);
  if (strategy === "multi-venue-v3") dataset = await attachMultiVenue(dataset, args);
  const selected = range(args, dataset.manifest.requestedCoverage);
  const directory = resolveOutputPath(runId("robustness"));
  const parameters = defaultParametersFor(strategy);
  const capital = capitalOptions(args);
  const replay = await runHistoricalReplay(dataset, {
    strategy, parameters, ...selected, ...capital, outputDirectory: join(directory, "base")
  });
  const report = await runMonteCarloRobustness(dataset, replay, {
    strategy, parameters, ...selected, iterations: Number(args.iterations ?? 2_000), outputDirectory: join(directory, "scenarios")
  });
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
  const report = await auditExternalMarketFeatureCatalog({ directory });
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
  const external = await auditExternalMarketFeatureCatalog({ directory: join(directory, "external") });
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

/**
 * 命令表。
 *
 * 每个「真正的研究命令」一次 invocation 必须恰好产生一条顶层 research run：
 * 成功一条 PASSED/PARTIAL，失败一条 BLOCKED/FAILED，绝不会 0 条也绝不会 2 条。
 * 子阶段一律放进这条 run 的 summary.stages / evidence，不冒充独立顶层运行。
 *
 * exempt 的只是纯查询/登记类命令，它们本身不是一次研究运行。
 */
/**
 * 构造 research:v2 的顶层 run 记录。
 *
 * strategyVersion 必须来自管线真实产出的 selectionEvidence 字段：
 * 通过前置 gate 时是 selectedForFurtherValidation，没有候选通过时退回
 * bestDiagnosticOnly —— 不能因为字段名写错而无声变成 null。
 */
export function researchV2RunRecord(result) {
  const pipeline = result?.result ?? null;
  const promotion = pipeline?.promotion ?? null;
  const evidence = pipeline?.selectionEvidence ?? null;
  const strategyVersion = evidence?.selectedForFurtherValidation?.version
    ?? evidence?.bestDiagnosticOnly?.version
    ?? null;
  return {
    status: promotion?.status === "PASSED" && promotion?.eligible ? "PASSED" : "PARTIAL",
    artifactPath: join(result?.directory ?? ".", "research-v2-pipeline.json"),
    dataManifestHash: result?.dataset?.manifest?.manifestHash ?? null,
    strategyVersion,
    summary: {
      conclusion: pipeline?.conclusion ?? null,
      promotion,
      finalUntouchedOos: pipeline?.finalUntouchedOos ?? null,
      championChanged: promotion?.championChanged ?? false,
      selectedForFurtherValidation: evidence?.selectedForFurtherValidation ?? null,
      bestDiagnosticOnly: evidence?.bestDiagnosticOnly ?? null,
      stages: {
        candidateGeneration: pipeline?.candidateGeneration ?? null,
        experiments: (pipeline?.experiments ?? []).map((item) => ({
          version: item.candidate?.version ?? null,
          walkForwardPassed: item.validation?.passed ?? null
        })),
        robustness: pipeline?.robustness?.status ?? null,
        formalShadow: pipeline?.formalShadow?.status ?? null,
        holdoutRegistry: pipeline?.holdoutRegistry?.holdout?.status ?? null
      }
    }
  };
}

const dataManifestHashOf = (result) => result?.dataset?.manifest?.manifestHash ?? null;

const COMMANDS = {
  "multi-venue:update": {
    handler: (args) => multiVenueUpdate(args),
    runType: "MULTI_VENUE_FUNDING_CATALOG_UPDATE",
    record: (result) => ({
      status: result?.manifest?.status === "COMPLETE" ? "PASSED" : "PARTIAL",
      dataManifestHash: result?.manifest?.manifestHash ?? null,
      summary: { fetched: result?.fetched ?? 0, directory: result?.directory ?? null, errors: result?.manifest?.errors ?? {} }
    })
  },
  "multi-venue:inspect": {
    exempt: true,
    handler: async (args) => {
      const dataset = await loadMultiVenueFundingDataset(args["multi-venue-catalog"] ?? defaultMultiVenueCatalogDirectory());
      process.stdout.write(`${JSON.stringify({ directory: dataset.directory, manifest: dataset.manifest }, null, 2)}\n`);
    }
  },
  "data:update": {
    handler: (args) => dataUpdate(args),
    runType: "DATA_CATALOG_UPDATE",
    record: (result) => ({
      status: result?.manifest?.quality === "VALID" ? "PASSED" : "PARTIAL",
      dataManifestHash: result?.manifest?.manifestHash ?? null,
      summary: { fetched: result?.fetched ?? null, directory: result?.directory ?? null, quality: result?.manifest?.quality ?? null, fetchErrors: result?.manifest?.fetchErrors ?? [] }
    })
  },
  "data:inspect": {
    exempt: true,
    handler: async (args) => {
      const dataset = await load(args);
      process.stdout.write(`${JSON.stringify({ directory: dataset.directory, manifest: dataset.manifest }, null, 2)}\n`);
    }
  },
  backtest: {
    handler: (args) => backtest(args),
    runType: "HISTORICAL_REPLAY_BACKTEST",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      strategyVersion: result?.comparison?.challenger?.strategyVersion ?? null,
      summary: {
        capital: result?.comparison?.challenger?.capital ?? null,
        sameEvents: result?.comparison?.sameEvents ?? null,
        stages: {
          champion: { trades: result?.comparison?.champion?.tradeCount ?? null, entryRejections: result?.comparison?.champion?.entryRejections ?? null },
          challenger: { trades: result?.comparison?.challenger?.tradeCount ?? null, entryRejections: result?.comparison?.challenger?.entryRejections ?? null }
        },
        challengerPerformance: {
          netPnlCny: result?.comparison?.challenger?.performance?.cumulativePnlCny ?? null,
          profitFactor: result?.comparison?.challenger?.performance?.profitFactor ?? null,
          expectancyCny: result?.comparison?.challenger?.performance?.expectancyCny ?? null,
          winRatePct: result?.comparison?.challenger?.performance?.winRatePct ?? null,
          maxDrawdownPct: result?.comparison?.challenger?.performance?.maxDrawdownPct ?? null
        },
        touchedFinalOos: false
      }
    })
  },
  replay: {
    handler: (args) => replay(args),
    runType: "HISTORICAL_REPLAY",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      strategyVersion: result?.report?.strategyVersion ?? null,
      summary: {
        strategy: result?.report?.strategy ?? null,
        capital: result?.report?.capital ?? null,
        tradeCount: result?.report?.tradeCount ?? null,
        entryRejections: result?.report?.entryRejections ?? null,
        performance: {
          netPnlCny: result?.report?.performance?.cumulativePnlCny ?? null,
          profitFactor: result?.report?.performance?.profitFactor ?? null,
          expectancyCny: result?.report?.performance?.expectancyCny ?? null,
          winRatePct: result?.report?.performance?.winRatePct ?? null,
          maxDrawdownPct: result?.report?.performance?.maxDrawdownPct ?? null
        },
        touchedFinalOos: false
      }
    })
  },
  validate: {
    handler: (args) => validation(args),
    runType: "WALK_FORWARD_PURGED_OOS_VALIDATION",
    record: (result) => ({
      status: result?.report?.passed ? "PASSED" : "PARTIAL",
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      strategyVersion: result?.candidateStrategy ?? null,
      summary: {
        baselineStrategy: result?.baselineStrategy ?? null,
        candidateStrategy: result?.candidateStrategy ?? null,
        passed: result?.report?.passed ?? null,
        gateReasons: result?.report?.gateReasons ?? [],
        stages: {
          windows: result?.report?.windows?.length ?? 0,
          lookaheadPassed: result?.report?.lookaheadAudit?.passed ?? null
        },
        touchedFinalOos: false
      }
    })
  },
  similarity: {
    handler: (args) => similarity(args),
    runType: "HISTORICAL_SIMILARITY",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      summary: {
        matrixRows: result?.matrix?.rows?.length ?? 0,
        matrixHash: result?.matrix?.matrixHash ?? null,
        stages: { query: result?.query?.status ?? result?.query?.evidence ?? null }
      }
    })
  },
  robustness: {
    handler: (args) => robustness(args),
    runType: "MONTE_CARLO_ROBUSTNESS",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      summary: {
        status: result?.report?.status ?? null,
        stages: { baseTrades: result?.replay?.tradeCount ?? null, scenarios: result?.report?.scenarios?.length ?? null }
      }
    })
  },
  counterfactual: {
    handler: (args) => counterfactual(args),
    runType: "COUNTERFACTUAL_REVIEW",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      summary: {
        decisionCount: result?.report?.decisionCount ?? null,
        waitTracked: result?.report?.waitTracked ?? null,
        stages: { tradesReviewed: result?.report?.tradeReviews?.length ?? null },
        aggregate: result?.report?.aggregate ?? null
      }
    })
  },
  "external:audit": {
    handler: (args) => externalAudit(args),
    runType: "EXTERNAL_FEATURE_CATALOG_AUDIT",
    record: (result) => ({
      summary: {
        features: result?.features?.length ?? null,
        generatedAt: result?.generatedAt ?? null,
        stages: { productionWeightsUnchanged: true }
      }
    })
  },
  optimize: {
    handler: (args) => optimize(args),
    runType: "STRATEGY_OPTIMIZATION",
    record: (result) => ({
      strategyVersion: result?.selectedCandidate?.version ?? null,
      summary: {
        promotion: result?.promotion ?? null,
        championChanged: result?.championChanged ?? false,
        stages: {
          validationPassed: result?.validation?.passed ?? null,
          robustness: result?.robustness?.status ?? null,
          shadow: result?.shadowComparison?.status ?? null
        }
      }
    })
  },
  diagnose: {
    handler: (args) => diagnose(args),
    runType: "CHALLENGER_EDGE_DIAGNOSIS",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      summary: { stages: { diagnosis: result?.report?.summary ?? null } }
    })
  },
  ablation: {
    handler: (args) => ablation(args),
    runType: "FEATURE_ABLATION",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      dataManifestHash: dataManifestHashOf(result),
      summary: { stages: { selected: result?.report?.selected ?? null } }
    })
  },
  "edge:pipeline": {
    handler: (args) => edgePipeline(args),
    runType: "EDGE_CANDIDATE_PIPELINE",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      summary: { stages: { promotion: result?.report?.promotion ?? null } }
    })
  },
  "tradable-edge": {
    handler: (args) => tradableEdge(args),
    runType: "TRADABLE_EDGE_PIPELINE",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      summary: { stages: { promotion: result?.report?.promotion ?? result?.promotion ?? null } }
    })
  },
  "anti-chase": {
    handler: (args) => antiChase(args),
    runType: "ANTI_CHASE_DIAGNOSIS",
    record: (result) => ({
      artifactPath: result?.directory ?? null,
      summary: { stages: { promotion: result?.promotion ?? null } }
    })
  },
  "research:v2": {
    handler: (args) => researchV2(args),
    runType: "RESEARCH_V2_PIPELINE",
    record: (result) => researchV2RunRecord(result)
  },
  "research:v3": {
    handler: (args) => researchV3(args),
    runType: "RESEARCH_V3_MULTI_VENUE_PIPELINE",
    record: (result) => ({
      status: result?.result?.report?.promotion?.allowed ? "PASSED" : "PARTIAL",
      artifactPath: join(result?.directory ?? ".", "research-v3-pipeline.json"),
      dataManifestHash: result?.dataset?.manifest?.manifestHash ?? null,
      strategyVersion: result?.result?.report?.strategyVersion ?? null,
      summary: {
        promotion: result?.result?.report?.promotion ?? null,
        candidate: result?.result?.report?.candidate ?? null,
        crossVenueAblation: result?.result?.report?.crossVenueAblation ?? null,
        touchedFinalOos: false
      }
    })
  },
  full: {
    handler: (args) => full(args),
    runType: "FULL_RESEARCH_ACCEPTANCE",
    record: (result) => ({
      summary: {
        stages: {
          optimization: result?.optimization ?? null,
          counterfactual: result?.counterfactual ?? null
        },
        safety: result?.safety ?? null
      }
    })
  },
  "research:register-candidate": { exempt: true, handler: () => registerCandidate() },
  "research:runs": { exempt: true, handler: () => showResearchRuns() }
};

async function registerCandidate() {
  // 只是登记一份真实存在的源码及其哈希，不是研究结果：没有跑过 OOS，
  // 因此 lifecycle 为 CANDIDATE、promotion 明确为 BLOCKED。
  const { readFile } = await import("node:fs/promises");
  const { sha256 } = await import("./research-utils.mjs");
  const source = await readFile(new URL("./data-tiered-strategy.mjs", import.meta.url), "utf8");
  const codeSha256 = sha256(source);
  const registered = registerResearchStrategyVersion({
    version: DATA_TIERED_PARAMETERS.version,
    role: "CHALLENGER",
    lifecycleStatus: "CANDIDATE",
    strategyHash: codeSha256,
    codeSha256,
    parameters: DATA_TIERED_PARAMETERS,
    featureSet: ["FROZEN_V12_DIRECTION", "TIERED_DATA_QUALITY_GATE"],
    promotionReason: "BLOCKED: no OOS/Shadow evidence has been produced for this candidate yet",
    rollbackVersion: "V1.2-FROZEN"
  });
  process.stdout.write(`${JSON.stringify({
    registered: registered.version, role: registered.role,
    lifecycleStatus: registered.lifecycle_status, codeSha256,
    registryPath: RESEARCH_REGISTRY.path,
    championUnchanged: "V1.2-FROZEN"
  }, null, 2)}\n`);
}

function showResearchRuns() {
  return withResearchRegistry((db) => {
    const runs = db.getResearchRuns({ limit: 1_000_000 });
    process.stdout.write(`${JSON.stringify({
      registryPath: RESEARCH_REGISTRY.path,
      registryPathSource: RESEARCH_REGISTRY.pathSource,
      productionPaperDatabasePath: RESEARCH_REGISTRY.productionPaperDatabasePath,
      persistedResearchRuns: runs.length,
      registeredStrategyVersions: db.getStrategyVersions({ limit: 1_000_000 }).length,
      runs: runs.slice(0, 20).map((item) => ({
        id: item.id, runType: item.run_type, status: item.status,
        finishedAt: item.finished_at, strategyVersion: item.strategy_version
      }))
    }, null, 2)}\n`);
  });
}

export const RESEARCH_COMMANDS = Object.freeze(Object.keys(COMMANDS));
export const EXEMPT_RESEARCH_COMMANDS = Object.freeze(
  Object.entries(COMMANDS).filter(([, entry]) => entry.exempt).map(([name]) => name)
);

/**
 * 执行一个研究命令并保证「恰好一条顶层 run」。
 *
 * 成功 → 一条 PASSED/PARTIAL；失败 → 一条 BLOCKED/FAILED。
 * 导出出来是为了可以直接对这条不变量写测试，而不是只能靠子进程观察。
 */
export async function executeResearchCommand({
  command,
  args = {},
  startedAt = new Date().toISOString(),
  commands = COMMANDS,
  persist = recordRun
} = {}) {
  const entry = commands[command];
  try {
    if (!entry) throw new Error(`Unknown research command: ${command}`);
    const result = await entry.handler(args);
    if (entry.exempt) return { command, exempt: true, recorded: null, result };
    const record = entry.record?.(result) ?? {};
    const recorded = await persist(entry.runType, startedAt, record.status ?? "PASSED", record);
    return { command, exempt: false, recorded, result };
  } catch (error) {
    // 失败也必须留痕，而且必须分类：外部前置条件缺失是 BLOCKED，
    // 代码异常/断言失败/用法错误是 FAILED，不允许一律记 BLOCKED。
    if (entry && !entry.exempt) {
      const { status, interpretation } = classifyResearchFailure(error);
      await persist(entry.runType, startedAt, status, {
        summary: {
          command,
          arguments: args,
          failureReason: error.message,
          errorName: error.name ?? null,
          errorCode: error.code ?? null,
          interpretation
        }
      });
    }
    throw error;
  }
}

const command = process.argv[2] ?? "data:inspect";
const args = argumentsMap();
const commandStartedAt = new Date().toISOString();

// 这个文件既是 CLI 入口，也导出 classifyResearchFailure / capitalOptions 等给测试与其它模块使用。
// 只有作为进程入口被直接执行时才跑命令派发；被 import 时绝不能顺手启动一次研究运行。
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await executeResearchCommand({ command, args, startedAt: commandStartedAt });
  } catch (error) {
    process.stderr.write(`Research command failed safely: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
