import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runMonteCarloRobustness } from "./monte-carlo.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { MULTI_VENUE_CHALLENGER_PARAMETERS } from "./multi-venue-challenger.mjs";
import { RESEARCH_CHALLENGER_V2_PARAMETERS } from "./research-challenger-v2.mjs";
import { hashObject, mean, round, standardDeviation, writeJsonAtomic } from "./research-utils.mjs";
import { runValidationEngine } from "./validation-engine.mjs";

export const RESEARCH_V3_DEVELOPMENT_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-01-17T06:30:00.000Z",
  policy: "predeclared development interval; previously reserved future holdout is not opened"
});

function performanceView(report) {
  return {
    trades: report.tradeCount,
    returnPct: report.performance.cumulativeReturnPct,
    netPnlCny: report.performance.cumulativePnlCny,
    profitFactor: report.performance.profitFactor,
    tradeSharpe: report.performance.tradeSharpe,
    winRatePct: report.performance.winRatePct,
    maxDrawdownPct: report.performance.maxDrawdownPct,
    totalCostsCny: report.performance.totalCostsCny
  };
}

function scoreAudit(trace) {
  const sums = trace.map((item) => Number(item.longScore) + Number(item.shortScore)).filter(Number.isFinite);
  const longHigher = trace.filter((item) => Number(item.longScore) > Number(item.shortScore)).length;
  const shortHigher = trace.filter((item) => Number(item.shortScore) > Number(item.longScore)).length;
  return {
    events: trace.length,
    longHigher,
    shortHigher,
    tied: trace.length - longHigher - shortHigher,
    meanScoreSum: round(mean(sums), 4),
    scoreSumStdDev: round(standardDeviation(sums), 4),
    constantSumRejected: standardDeviation(sums) > 0.01
  };
}

function resolvedRange(dataset) {
  const availableFrom = new Date(dataset.manifest.actualCoverage.from).getTime();
  const availableTo = new Date(dataset.manifest.actualCoverage.to).getTime();
  const from = Math.max(availableFrom, new Date(RESEARCH_V3_DEVELOPMENT_RANGE.from).getTime());
  const to = Math.min(availableTo, new Date(RESEARCH_V3_DEVELOPMENT_RANGE.to).getTime());
  if (!(to > from)) throw new Error("Dataset does not overlap the predeclared Research V3 development range");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export async function runResearchV3Pipeline(dataset, {
  outputDirectory,
  robustnessIterations = 1_000,
  capitalProfile,
  referenceCapitalCny
} = {}) {
  if (!outputDirectory) throw new Error("Research V3 pipeline requires an output directory");
  await mkdir(outputDirectory, { recursive: true });
  const selected = resolvedRange(dataset);
  // 同一次 V3 运行里 baseline、candidate、消融与稳健性必须共享一个资金视角，
  // 否则「跨场所特征带来多少增量」会被两套资金口径的差异污染。
  // developmentRange 只记录区间本身，不掺进资金参数。
  const replayOptions = { ...selected, capitalProfile, referenceCapitalCny };
  const baseline = await runHistoricalReplay(dataset, {
    strategy: "research-v2",
    parameters: RESEARCH_CHALLENGER_V2_PARAMETERS,
    ...replayOptions,
    outputDirectory: join(outputDirectory, "development-baseline")
  });
  const candidate = await runHistoricalReplay(dataset, {
    strategy: "multi-venue-v3",
    parameters: MULTI_VENUE_CHALLENGER_PARAMETERS,
    ...replayOptions,
    outputDirectory: join(outputDirectory, "development-candidate")
  });
  const withoutCrossVenue = await runHistoricalReplay({ ...dataset, multiVenueFunding: [] }, {
    strategy: "multi-venue-v3",
    parameters: MULTI_VENUE_CHALLENGER_PARAMETERS,
    ...replayOptions,
    outputDirectory: join(outputDirectory, "ablation-without-cross-venue")
  });
  const crossVenueEvents = candidate.trace.filter((item) => Number(item.multiVenueFunding?.venueCount ?? 0) >= 2).length;
  const crossVenueAblation = {
    evidenceAvailable: crossVenueEvents > 0,
    eventsWithAtLeastTwoVenues: crossVenueEvents,
    withFeature: performanceView(candidate),
    withoutFeature: performanceView(withoutCrossVenue),
    incrementalReturnPct: round(candidate.performance.cumulativeReturnPct - withoutCrossVenue.performance.cumulativeReturnPct, 4),
    incrementalTradeSharpe: round(Number(candidate.performance.tradeSharpe ?? 0) - Number(withoutCrossVenue.performance.tradeSharpe ?? 0), 4),
    interpretation: crossVenueEvents > 0
      ? "Same-event ablation; only timestamp-visible multi-venue Funding was removed."
      : "INSUFFICIENT_EVIDENCE: no event had at least two timestamp-visible external venues."
  };
  const developmentGateReasons = [];
  if (candidate.tradeCount < 30) developmentGateReasons.push("fewer than 30 development trades");
  if (!(Number(candidate.performance.grossPnlCny) > 0)) developmentGateReasons.push("development gross PnL is not positive before costs");
  if (!(Number(candidate.performance.profitFactor) >= 1)) developmentGateReasons.push("development Profit Factor is below 1");
  const developmentGate = {
    passed: developmentGateReasons.length === 0,
    reasons: developmentGateReasons,
    policy: "A candidate with non-positive development gross PnL or PF < 1 must not consume Purged OOS/holdout evidence."
  };
  let validation = {
    status: "NOT_RUN_DEVELOPMENT_GATE_FAILED",
    passed: false,
    gateReasons: ["development gate failed; OOS intentionally left untouched"]
  };
  let robustness = {
    status: "not run",
    reason: "development gate failed; robustness cannot rescue a strategy with negative gross edge"
  };
  if (developmentGate.passed) {
    validation = await runValidationEngine(dataset, {
      baselineStrategy: "research-v2",
      candidateStrategy: "multi-venue-v3",
      baselineParameters: RESEARCH_CHALLENGER_V2_PARAMETERS,
      candidateParameters: MULTI_VENUE_CHALLENGER_PARAMETERS,
      capitalProfile,
      referenceCapitalCny,
      outputDirectory: join(outputDirectory, "purged-oos")
    });
    if (validation.passed) {
      robustness = await runMonteCarloRobustness(dataset, candidate, {
        strategy: "multi-venue-v3",
        parameters: MULTI_VENUE_CHALLENGER_PARAMETERS,
        ...replayOptions,
        iterations: robustnessIterations,
        outputDirectory: join(outputDirectory, "robustness")
      });
    } else {
      robustness = { status: "not run", reason: "Purged OOS gate failed" };
    }
  }
  const blockers = [];
  if (!developmentGate.passed) blockers.push(...developmentGate.reasons.map((reason) => `development: ${reason}`));
  if (!validation.passed) blockers.push(...validation.gateReasons.map((reason) => `OOS: ${reason}`));
  if (robustness.status !== "ok") blockers.push(`robustness: ${robustness.reason ?? robustness.status}`);
  if (!crossVenueAblation.evidenceAvailable) blockers.push("cross-venue feature has no point-in-time historical evidence in this run");
  blockers.push("formal Shadow observation is required before any promotion");
  const report = {
    runType: "RESEARCH_V3_MULTI_VENUE_SIMULATION_PIPELINE",
    generatedAt: new Date().toISOString(),
    strategyVersion: MULTI_VENUE_CHALLENGER_PARAMETERS.version,
    strategyHash: hashObject(MULTI_VENUE_CHALLENGER_PARAMETERS),
    paperOnly: true,
    frozenChampionChanged: false,
    developmentRange: { ...selected, policy: RESEARCH_V3_DEVELOPMENT_RANGE.policy },
    // 报告必须自己写明这一轮用的是哪套资金口径，读者才能对上复现命令。
    capitalView: {
      capitalProfile: baseline.capital?.capitalProfile ?? null,
      initialCapitalCny: baseline.capital?.initialCapitalCny ?? null,
      sharedAcrossStages: "development baseline / candidate / cross-venue ablation / purged OOS / robustness"
    },
    dataManifestHash: dataset.manifest.manifestHash,
    multiVenueManifestHash: dataset.multiVenueManifest?.manifestHash ?? null,
    baseline: performanceView(baseline),
    candidate: performanceView(candidate),
    developmentGate,
    independentScoreAudit: scoreAudit(candidate.trace),
    crossVenueAblation,
    validation,
    robustness,
    promotion: {
      allowed: false,
      status: blockers.length > 1 ? "BLOCKED" : "BLOCKED_PENDING_SHADOW",
      blockers,
      nextStage: validation.passed && robustness.status === "ok" && crossVenueAblation.evidenceAvailable
        ? "FORMAL_SHADOW_PAPER"
        : "RESEARCH_REVISION"
    },
    safety: { apiKeyUsed: false, privateEndpointUsed: false, exchangeWriteEnabled: false, paperTradingOnly: true }
  };
  await writeJsonAtomic(join(outputDirectory, "research-v3-pipeline.json"), report);
  return { directory: outputDirectory, report };
}
