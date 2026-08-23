import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeAttribution } from "./attribution-engine.mjs";
import { HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { datasetView } from "./edge-diagnosis.mjs";
import { defaultCollectingHoldoutRegistryPath, updateCollectingHoldout } from "./holdout-manager.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { hashObject, mean, quantile, resolveResearchPath, round, sha256, standardDeviation, writeJsonAtomic } from "./research-utils.mjs";
import {
  buildTradableEdgeLabelCatalog,
  estimateTradableEdgeForState,
  trainTradableEdgeModel,
  TRADABLE_EDGE_POLICY
} from "./tradable-edge.mjs";
import { buildWalkForwardWindows } from "./validation-engine.mjs";

export const TRADABLE_EDGE_DEVELOPMENT_RANGE = Object.freeze({
  from: "2024-09-01T00:00:00.000Z",
  to: "2026-01-17T06:30:00.000Z",
  policy: "Ends before every previously consumed Final OOS interval; no observation after this cutoff may tune this layer."
});

export const NEXT_UNTOUCHED_HOLDOUT_FROM = "2026-08-23T05:45:00.000Z";

export const EDGE_FREQUENCY_PROFILES = Object.freeze([
  { id: "EDGE_POSITIVE", label: "高频/仅要求正优势", minimumNetEdgePct: 0 },
  { id: "EDGE_010", label: "中高频/净优势≥0.10%", minimumNetEdgePct: 0.1 },
  { id: "EDGE_020", label: "平衡/净优势≥0.20%", minimumNetEdgePct: 0.2 },
  { id: "EDGE_035", label: "低频/净优势≥0.35%", minimumNetEdgePct: 0.35 },
  { id: "EDGE_050", label: "极低频/净优势≥0.50%", minimumNetEdgePct: 0.5 }
]);

const SCORE_BANDS = Object.freeze([[50, 60], [60, 70], [70, 80], [80, 90], [90, 101]]);
const INDEX_BANDS = Object.freeze([[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]]);

function bin(value, bins) {
  const number = Number(value);
  const match = bins.find(([minimum, maximum]) => number >= minimum && number < maximum);
  return match ? `${match[0]}-${match[1] === 101 ? 100 : match[1]}` : "UNKNOWN";
}

function lower95(values) {
  const average = mean(values) ?? 0;
  const deviation = standardDeviation(values);
  return values.length ? average - 1.96 * deviation / Math.sqrt(values.length) : null;
}

function labelSummary(rows) {
  const net = rows.map((row) => Number(row.outcome.netTerminalReturnPct)).filter(Number.isFinite);
  const mfe = rows.map((row) => Number(row.outcome.mfePct)).filter(Number.isFinite);
  const mae = rows.map((row) => Number(row.outcome.maePct)).filter(Number.isFinite);
  const costs = rows.map((row) => Number(row.outcome.totalCostPct)).filter(Number.isFinite);
  return {
    samples: rows.length,
    meanForwardReturnPct: round(mean(rows.map((row) => Number(row.outcome.terminalReturnPct))) ?? 0, 6),
    meanNetExpectancyPct: round(mean(net) ?? 0, 6),
    netExpectancyLower95Pct: round(lower95(net), 6),
    meanMfePct: round(mean(mfe) ?? 0, 6),
    medianMfePct: round(quantile(mfe, 0.5), 6),
    meanMaePct: round(mean(mae) ?? 0, 6),
    medianMaePct: round(quantile(mae, 0.5), 6),
    meanMfeMaeRatio: round(mean(rows.map((row) => Number(row.outcome.mfeMaeRatio)).filter(Number.isFinite)) ?? 0, 6),
    medianMfeMaeRatio: round(quantile(rows.map((row) => Number(row.outcome.mfeMaeRatio)).filter(Number.isFinite), 0.5), 6),
    medianTimeToMfeMinutes: round(quantile(rows.map((row) => Number(row.outcome.timeToMfeMinutes)), 0.5), 2),
    medianTimeToMaeMinutes: round(quantile(rows.map((row) => Number(row.outcome.timeToMaeMinutes)), 0.5), 2),
    mfeFirstPct: rows.length ? round(rows.filter((row) => row.outcome.firstExtreme === "MFE_FIRST").length / rows.length * 100, 2) : 0,
    costCoveragePct: rows.length ? round(rows.filter((row) => Number(row.outcome.mfePct) > Number(row.outcome.totalCostPct)).length / rows.length * 100, 2) : 0,
    meanRoundTripCostPct: round(mean(costs) ?? 0, 6)
  };
}

function group(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const key = selector(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, labelSummary(values)]));
}

function spearmanFromGroups(groups) {
  const values = Object.entries(groups).filter(([key, value]) => key !== "UNKNOWN" && value.samples >= 10)
    .sort(([left], [right]) => Number(left.split("-")[0]) - Number(right.split("-")[0]));
  if (values.length < 3) return null;
  const outcomes = values.map(([, value]) => value.meanNetExpectancyPct);
  const ranked = outcomes.map((value) => 1 + outcomes.filter((other) => other < value).length);
  const n = ranked.length;
  const squared = ranked.reduce((sum, rank, index) => sum + (rank - (index + 1)) ** 2, 0);
  return round(1 - 6 * squared / (n * (n * n - 1)), 4);
}

function evaluationRows(labelCatalog, model, window, profile) {
  const start = new Date(window.testStart).getTime();
  const end = new Date(window.testEnd).getTime();
  const rows = [];
  for (const row of labelCatalog.rows) {
    if (row.timestamp < start || row.timestamp > end) continue;
    const rawSide = ["LONG", "SHORT"].includes(row.rawCandidateDecision)
      ? row.rawCandidateDecision
      : Number(row.states.LONG.rawDirectionalScore) >= Number(row.states.SHORT.rawDirectionalScore) ? "LONG" : "SHORT";
    const state = row.states[rawSide];
    const estimate = estimateTradableEdgeForState(state, model, undefined, { minimumNetEdgePct: profile.minimumNetEdgePct });
    const outcome = estimate.selectedHorizon ? row.outcomes[rawSide][estimate.selectedHorizon] : null;
    if (!outcome) continue;
    rows.push({
      window: window.index,
      timestamp: row.timestamp,
      side: rawSide,
      state,
      rawScore: state.rawDirectionalScore,
      opportunityIndex: estimate.opportunityIndex,
      estimate,
      outcome,
      eligible: estimate.eligible,
      selectedHorizon: estimate.selectedHorizon
    });
  }
  return rows;
}

function scoreCalibration(rowsByWindow) {
  const combined = rowsByWindow.flat();
  const rawGroups = group(combined, (row) => bin(row.rawScore, SCORE_BANDS));
  const indexGroups = group(combined, (row) => bin(row.opportunityIndex, INDEX_BANDS));
  const rawWindowSpearman = rowsByWindow.map((rows, index) => ({ window: index + 1, value: spearmanFromGroups(group(rows, (row) => bin(row.rawScore, SCORE_BANDS))) }));
  const indexWindowSpearman = rowsByWindow.map((rows, index) => ({ window: index + 1, value: spearmanFromGroups(group(rows, (row) => bin(row.opportunityIndex, INDEX_BANDS))) }));
  const stableMonotonic = (values) => values.filter((item) => Number(item.value) >= 0.5).length >= 3;
  return {
    oldDirectionalScore: {
      name: "raw directional score",
      forbiddenNames: ["confidence", "success probability"],
      bands: rawGroups,
      combinedSpearmanVsNetExpectancy: spearmanFromGroups(rawGroups),
      walkForwardSpearman: rawWindowSpearman,
      stableMonotonicRelationship: stableMonotonic(rawWindowSpearman)
    },
    redesignedScore: {
      name: "Opportunity Index",
      semantics: "Ordinal ranking from estimated net tradable edge; not confidence and not a probability.",
      bands: indexGroups,
      combinedSpearmanVsNetExpectancy: spearmanFromGroups(indexGroups),
      walkForwardSpearman: indexWindowSpearman,
      stableMonotonicRelationship: stableMonotonic(indexWindowSpearman)
    }
  };
}

const CONDITION_DIMENSIONS = Object.freeze({
  side: (row) => row.side,
  marketRegime: (row) => row.state.regime,
  rawScoreBand: (row) => bin(row.rawScore, SCORE_BANDS),
  atrToCostBand: (row) => row.state.atrCostBand,
  alignedTimeframes: (row) => String(row.state.alignedTimeframes),
  completed15mConfirmation: (row) => String(row.state.candleConfirmed),
  fundingCostBand: (row) => row.state.fundingBand,
  sideRegime: (row) => `${row.side}|${row.state.regime}`
});

function conditionResearch(rowsByWindow) {
  const combined = rowsByWindow.flat();
  const dimensions = {};
  const stablePositive = [];
  for (const [name, selector] of Object.entries(CONDITION_DIMENSIONS)) {
    dimensions[name] = group(combined, selector);
    for (const [value, aggregate] of Object.entries(dimensions[name])) {
      const perWindow = rowsByWindow.map((rows, index) => ({ window: index + 1, ...labelSummary(rows.filter((row) => selector(row) === value)) }));
      const evaluable = perWindow.filter((row) => row.samples >= 10);
      const positive = evaluable.filter((row) => row.meanNetExpectancyPct > 0 && row.costCoveragePct >= 55).length;
      const reasons = [];
      if (aggregate.samples < 60) reasons.push("fewer than 60 OOS labels");
      if (evaluable.length < 3) reasons.push("fewer than 3 evaluable OOS windows");
      if (positive < 3) reasons.push("positive net expectancy and cost coverage in fewer than 3 windows");
      if (!(aggregate.netExpectancyLower95Pct > 0)) reasons.push("net expectancy 95% lower bound is not positive");
      if (reasons.length === 0) stablePositive.push({ dimension: name, value, aggregate, perWindow });
    }
  }
  return {
    dimensions,
    stablePositiveEntryConditions: stablePositive,
    rule: "Only information visible at entry is grouped. Future MFE/MAE/returns are labels and never become same-timestamp inputs."
  };
}

function aggregateFrequency(profile, windows) {
  const contexts = windows.flatMap((item) => item.replay.tradeContexts);
  const attribution = summarizeAttribution(contexts);
  const positiveWindows = windows.filter((item) => Number(item.replay.performance.cumulativePnlCny) > 0
    && Number(item.replay.performance.profitFactor ?? 0) > 1).length;
  const totalGross = windows.reduce((sum, item) => sum + Number(item.replay.performance.grossPnlCny), 0);
  const totalCosts = windows.reduce((sum, item) => sum + Number(item.replay.performance.totalCostsCny), 0);
  const netPnl = windows.reduce((sum, item) => sum + Number(item.replay.performance.cumulativePnlCny), 0);
  const maximumDrawdownPct = Math.max(...windows.map((item) => Number(item.replay.performance.maxDrawdownPct)), 0);
  const stableReasons = [];
  if (contexts.length < 60) stableReasons.push("fewer than 60 purged OOS trades");
  if (positiveWindows < 3) stableReasons.push("positive net PnL/PF in fewer than 3/4 OOS windows");
  if (!(Number(attribution.netProfitFactor ?? 0) >= 1.05)) stableReasons.push("combined net PF below 1.05");
  if (!(Number(attribution.netExpectancyPctLower95 ?? 0) > 0)) stableReasons.push("net expectancy 95% lower bound is not positive");
  if (!(netPnl > 0)) stableReasons.push("combined net PnL is not positive");
  const costToGrossPct = Math.abs(totalGross) > 0 ? totalCosts / Math.abs(totalGross) * 100 : null;
  if (!(Number(costToGrossPct) < 80)) stableReasons.push("cost is not below 80% of absolute gross PnL");
  const objectiveScore = (attribution.netExpectancyPct ?? 0) * 100
    + Math.log(Math.max(Number(attribution.netProfitFactor ?? 0.01), 0.01))
    - maximumDrawdownPct * 0.15
    - Math.max(0, Number(costToGrossPct ?? 200) - 50) / 100;
  return {
    ...profile,
    totalTrades: contexts.length,
    positiveWindows,
    grossPnlCny: round(totalGross, 4),
    totalCostsCny: round(totalCosts, 4),
    netPnlCny: round(netPnl, 4),
    netExpectancyCny: attribution.netExpectancyCny,
    netExpectancyPct: attribution.netExpectancyPct,
    netExpectancyPctLower95: attribution.netExpectancyPctLower95,
    profitFactor: attribution.netProfitFactor,
    maximumDrawdownPct: round(maximumDrawdownPct, 4),
    costToAbsoluteGrossPct: round(costToGrossPct, 4),
    winRatePct: attribution.winRatePct,
    stablePositiveOosEdge: stableReasons.length === 0,
    stableReasons,
    objectiveScore: round(objectiveScore, 6),
    objective: ["OOS net expectancy", "Profit Factor", "maximum drawdown", "cross-window stability", "cost/gross ratio"],
    winRateUsedAsOptimizationTarget: false,
    windows: windows.map((item) => ({ index: item.window.index, range: { from: item.window.testStart, to: item.window.testEnd }, performance: item.replay.performance }))
  };
}

function forwardHorizonSummary(labelCatalog) {
  return Object.fromEntries(Object.keys(labelCatalog.horizons).map((horizon) => [horizon, Object.fromEntries(["LONG", "SHORT"].map((side) => [
    side,
    labelSummary(labelCatalog.rows.map((row) => ({ outcome: row.outcomes[side][horizon] })).filter((row) => row.outcome))
  ]))]));
}

export async function runTradableEdgePipeline(dataset, {
  outputDirectory,
  diagnosis = null,
  sampleStrideBars = 4,
  onProgress = null
} = {}) {
  if (!outputDirectory) throw new Error("Tradable Edge pipeline requires an output directory");
  const development = datasetView(dataset, TRADABLE_EDGE_DEVELOPMENT_RANGE);
  const baseParameters = {
    ...HISTORICAL_COMPATIBLE_PARAMETERS,
    version: "historical-compatible-ohlcv-funding-edge-base-v1",
    featureSet: "OHLCV_FUNDING"
  };
  onProgress?.({ stage: "labels", status: "running" });
  const labelCatalog = buildTradableEdgeLabelCatalog(development, {
    ...TRADABLE_EDGE_DEVELOPMENT_RANGE,
    sampleStrideBars,
    baseParameters,
    onProgress
  });
  const labelsPath = join(outputDirectory, "forward-path-labels.json");
  await writeJsonAtomic(labelsPath, labelCatalog);
  const windows = buildWalkForwardWindows(development, 4);
  const experiments = new Map(EDGE_FREQUENCY_PROFILES.map((profile) => [profile.id, []]));
  const evaluation = new Map(EDGE_FREQUENCY_PROFILES.map((profile) => [profile.id, []]));
  const baselineWindows = [];
  for (const window of windows) {
    onProgress?.({ stage: "walk-forward", status: "training", window: window.index });
    const model = trainTradableEdgeModel(labelCatalog, {
      from: window.trainStart,
      to: window.trainEnd,
      baseParameters
    });
    const baseline = await runHistoricalReplay(development, {
      strategy: "historical-compatible",
      parameters: baseParameters,
      from: window.testStart,
      to: window.testEnd,
      collectTrace: false,
      outputDirectory: join(outputDirectory, "walk-forward", `window-${window.index}`, "baseline")
    });
    baselineWindows.push({ window, replay: baseline });
    for (const profile of EDGE_FREQUENCY_PROFILES) {
      onProgress?.({ stage: "walk-forward", status: "replay", window: window.index, profile: profile.id });
      const parameters = {
        version: `tradable-edge-${profile.id.toLowerCase()}-v1`,
        baseParameters,
        model,
        minimumNetEdgePct: profile.minimumNetEdgePct
      };
      const replay = await runHistoricalReplay(development, {
        strategy: "tradable-edge",
        parameters,
        from: window.testStart,
        to: window.testEnd,
        collectTrace: false,
        outputDirectory: join(outputDirectory, "walk-forward", `window-${window.index}`, profile.id)
      });
      experiments.get(profile.id).push({ window, replay, modelHash: model.modelHash });
      evaluation.get(profile.id).push(evaluationRows(labelCatalog, model, window, profile));
    }
  }
  const baselineAggregate = aggregateFrequency({ id: "NO_EDGE_GATE", label: "原 Historical-Compatible 高频基线", minimumNetEdgePct: null }, baselineWindows);
  const frequencyProfiles = EDGE_FREQUENCY_PROFILES.map((profile) => aggregateFrequency(profile, experiments.get(profile.id)));
  const stableProfiles = frequencyProfiles.filter((profile) => profile.stablePositiveOosEdge)
    .sort((left, right) => right.objectiveScore - left.objectiveScore);
  const researchRanking = [...frequencyProfiles].sort((left, right) => right.objectiveScore - left.objectiveScore);
  const selected = stableProfiles[0] ?? null;
  const diagnosticProfile = researchRanking[0];
  const calibrationProfile = frequencyProfiles.find((profile) => profile.id === "EDGE_020") ?? diagnosticProfile;
  const calibration = scoreCalibration(evaluation.get(calibrationProfile.id));
  const conditions = conditionResearch(evaluation.get(calibrationProfile.id));
  const finalDevelopmentModel = trainTradableEdgeModel(labelCatalog, {
    from: TRADABLE_EDGE_DEVELOPMENT_RANGE.from,
    to: TRADABLE_EDGE_DEVELOPMENT_RANGE.to,
    baseParameters
  });
  const modelPath = resolveResearchPath("tradable-edge-model-v1.json");
  await writeJsonAtomic(modelPath, finalDevelopmentModel);
  const preselectedCandidate = selected ? {
    version: `tradable-edge-${selected.id.toLowerCase()}-v1`,
    strategyHash: hashObject({ baseParameters, modelHash: finalDevelopmentModel.modelHash, minimumNetEdgePct: selected.minimumNetEdgePct }),
    selectedAt: new Date().toISOString(),
    developmentEvidenceHash: hashObject(selected)
  } : null;
  const holdout = await updateCollectingHoldout(dataset, {
    from: NEXT_UNTOUCHED_HOLDOUT_FROM,
    registryPath: defaultCollectingHoldoutRegistryPath(),
    preselectedCandidate
  });
  const activeResearch = {
    schemaVersion: 2,
    activatedAt: new Date().toISOString(),
    status: selected ? "PRESELECTED_AWAITING_FINAL_OOS_OBSERVE_ONLY" : "EDGE_RESEARCH_OBSERVE_ONLY_NO_CHALLENGER",
    paperOnly: true,
    strategyType: "tradable-edge",
    version: selected ? preselectedCandidate.version : "tradable-edge-research-evaluator-v1",
    strategyHash: selected?.strategyHash ?? hashObject({ modelHash: finalDevelopmentModel.modelHash, diagnosticProfile }),
    modelPath,
    modelHash: finalDevelopmentModel.modelHash,
    parameters: {
      baseParameters,
      minimumNetEdgePct: selected?.minimumNetEdgePct ?? diagnosticProfile.minimumNetEdgePct,
      observeOnly: true
    },
    databasePath: resolveResearchPath("shadow", "tradable-edge-observe-only.sqlite"),
    newPositionsAllowed: false,
    reason: "The next untouched Final OOS is still collecting; real-time calculations are diagnostic only.",
    finalOosMayTuneThisStrategy: false
  };
  activeResearch.configHash = hashObject(activeResearch);
  await writeJsonAtomic(resolveResearchPath("active-shadow-strategy.json"), activeResearch);
  const reference = diagnosis?.attribution?.overall ?? null;
  const overtrading = {
    referenceTrades: reference?.trades ?? baselineAggregate.totalTrades,
    referenceGrossPnlCny: reference?.grossPnlCny ?? baselineAggregate.grossPnlCny,
    referenceCostsCny: reference?.totalCostsCny ?? baselineAggregate.totalCostsCny,
    referenceNetPnlCny: reference?.netPnlCny ?? baselineAggregate.netPnlCny,
    detected: reference
      ? Number(reference.totalCostsCny) > Math.abs(Number(reference.grossPnlCny)) && Number(reference.netPnlCny) < 0
      : baselineAggregate.totalCostsCny > Math.abs(baselineAggregate.grossPnlCny) && baselineAggregate.netPnlCny < 0,
    reason: "Overtrading is flagged when total modeled friction exceeds absolute gross PnL while net PnL is negative; frequency profiles are then compared on net, not win rate."
  };
  const frozenChampionHash = sha256(await readFile(new URL("./analysis-engine.mjs", import.meta.url), "utf8")).toUpperCase();
  const report = {
    schemaVersion: 1,
    runType: "TRADABLE_EDGE_WALK_FORWARD_RESEARCH",
    generatedAt: new Date().toISOString(),
    safety: { paperOnly: true, htxPrivateApi: false, exchangeCredentials: false, exchangeWrites: false },
    frozenV12Champion: { changed: false, sha256: frozenChampionHash },
    restrictions: { newIndicators: false, ml: false, newDataSources: false, previouslyUsedFinalOosReadForTuning: false },
    development: {
      range: TRADABLE_EDGE_DEVELOPMENT_RANGE,
      dataManifestHash: development.manifest.manifestHash,
      labelRows: labelCatalog.rows.length,
      labelCatalogHash: labelCatalog.labelsHash,
      labelsPath,
      walkForwardWindows: windows,
      purged: true,
      embargoed: true
    },
    forwardPathAnalysis: forwardHorizonSummary(labelCatalog),
    tradableEdgeFormula: {
      expression: "net tradable edge = estimated effective gross price space - round-trip fee - round-trip slippage - adverse Funding - uncertainty buffer",
      policy: TRADABLE_EDGE_POLICY,
      effectiveGrossPriceSpace: "min(25th percentile MFE, max(median terminal return above zero, median MFE - 0.5 × absolute median MAE))",
      fundingCreditsUsedForGate: false,
      futureLabelsUsedAtSameTimestamp: false
    },
    scoreCalibration: calibration,
    pointInTimeConditionResearch: conditions,
    frequencyAndCost: {
      baseline: baselineAggregate,
      profiles: frequencyProfiles,
      optimizationTarget: ["OOS net Expectancy", "Profit Factor", "maximum drawdown", "stability", "cost/gross ratio"],
      winRateTargeted: false,
      overtrading
    },
    candidate: selected ? {
      status: "PRESELECTED_DEVELOPMENT_ONLY_AWAITING_NEW_FINAL_OOS",
      profile: selected,
      evidence: preselectedCandidate,
      mayEnterShadow: false,
      mayPromote: false
    } : {
      status: "NO_CHALLENGER_GENERATED",
      reason: "No frequency/edge threshold proved stable positive net edge across purged walk-forward OOS. A diagnostic evaluator is not represented as a profitable Challenger.",
      bestResearchOnlyProfile: diagnosticProfile,
      mayEnterShadow: false,
      mayPromote: false
    },
    nextUntouchedHoldout: holdout,
    finalOos: { status: "BLOCKED_NOT_MATURE", opened: false, read: false, mayTuneCandidate: false },
    monteCarlo: { status: "NOT_RUN_BEFORE_FINAL_OOS", reason: "Required order is development → untouched Final OOS → Monte Carlo; the new holdout has not matured." },
    liveResearchTelemetry: {
      status: activeResearch.status,
      observeOnly: true,
      newPositionsAllowed: false,
      modelPath,
      modelHash: finalDevelopmentModel.modelHash
    },
    conclusion: selected
      ? "A development-only edge profile passed the predeclared gate, but it is not a validated Challenger until the new untouched holdout matures."
      : "Current data and strategy structure did not prove a reliable positive net tradable edge; no profitable-looking Challenger was forced."
  };
  report.evidenceHash = hashObject(report);
  await writeJsonAtomic(join(outputDirectory, "tradable-edge-report.json"), report);
  return report;
}

export { labelSummary, scoreCalibration, conditionResearch, aggregateFrequency };
