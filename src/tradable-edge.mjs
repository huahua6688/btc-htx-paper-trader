import { analyzeHistoricalCompatible, HISTORICAL_COMPATIBLE_PARAMETERS } from "./challenger-strategy.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { buildForwardPathLabels, TRADABLE_EDGE_HORIZONS } from "./forward-path-labels.mjs";
import { buildPointInTimeMarket, firstReplayableIndex } from "./replay-market.mjs";
import { BAR_MS, hashObject, mean, quantile, round, standardDeviation } from "./research-utils.mjs";

export const TRADABLE_EDGE_POLICY = Object.freeze({
  version: "tradable-edge-policy-v1",
  minimumSamples: 40,
  minimumNetEdgePct: 0.2,
  baseUncertaintyBufferPct: 0.05,
  missingFundingBufferPct: 0.03,
  horizonSelectionBufferPct: 0.03,
  scoreBands: Object.freeze([[0, 60], [60, 70], [70, 80], [80, 90], [90, 101]])
});

const SIDES = Object.freeze(["LONG", "SHORT"]);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function scoreBand(score) {
  const numeric = Number(score);
  const match = TRADABLE_EDGE_POLICY.scoreBands.find(([minimum, maximum]) => numeric >= minimum && numeric < maximum);
  return match ? `${match[0]}-${match[1] === 101 ? 100 : match[1]}` : "UNKNOWN";
}

function atrCostBand(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "UNKNOWN";
  if (numeric < 2) return "LT2";
  if (numeric < 4) return "2TO4";
  if (numeric < 8) return "4TO8";
  return "GTE8";
}

function fundingBand(ratePct, side) {
  if (!Number.isFinite(Number(ratePct))) return "MISSING";
  const adverse = (side === "LONG" ? 1 : -1) * Number(ratePct);
  if (adverse <= -0.005) return "CREDIT";
  if (adverse < 0.005) return "NEUTRAL";
  if (adverse < 0.02) return "ADVERSE";
  return "HIGH_ADVERSE";
}

export function pointInTimeEdgeState(report, side) {
  if (!SIDES.includes(side)) throw new Error(`Unknown Tradable Edge side: ${side}`);
  const rawDirectionalScore = Number(report.opportunities?.[side]?.rawDirectionalScore
    ?? report.opportunities?.[side]?.directionalScore
    ?? report.opportunities?.[side]?.score
    ?? (side === "LONG" ? report.scores?.longOpportunity : report.scores?.shortOpportunity));
  const atrToCost = Number(report.strategy?.entryFilters?.atrToRoundTripCost);
  const fundingRatePct = Number(report.derivatives?.fundingRatePct);
  return {
    side,
    regime: report.strategy?.marketRegime ?? "UNKNOWN",
    rawDirectionalScore: Number.isFinite(rawDirectionalScore) ? rawDirectionalScore : 50,
    scoreBand: scoreBand(rawDirectionalScore),
    atrToRoundTripCost: Number.isFinite(atrToCost) ? atrToCost : null,
    atrCostBand: atrCostBand(atrToCost),
    alignedTimeframes: Number(report.strategy?.entryFilters?.alignedTimeframes ?? 0),
    candleConfirmed: Boolean(report.strategy?.entryFilters?.candleConfirmed),
    fundingRatePct: Number.isFinite(fundingRatePct) ? fundingRatePct : null,
    fundingBand: fundingBand(fundingRatePct, side),
    baseDecision: report.decision,
    rawCandidateDecision: report.candidateDecision,
    entryMethod: report.entryAssessment?.method ?? report.strategy?.entryMethod ?? "UNKNOWN"
  };
}

function bucketKeys(state) {
  return [
    `L4|${state.side}|${state.regime}|${state.scoreBand}|${state.atrCostBand}`,
    `L3|${state.side}|${state.regime}|${state.scoreBand}`,
    `L2|${state.side}|${state.regime}`,
    `L1|${state.side}`
  ];
}

function summarizeOutcomes(outcomes, policy) {
  const terminal = outcomes.map((item) => Number(item.terminalReturnPct)).filter(Number.isFinite);
  const netTerminal = outcomes.map((item) => Number(item.netTerminalReturnPct)).filter(Number.isFinite);
  const mfe = outcomes.map((item) => Number(item.mfePct)).filter(Number.isFinite);
  const mae = outcomes.map((item) => Number(item.maePct)).filter(Number.isFinite);
  const medianMfe = quantile(mfe, 0.5) ?? 0;
  const p25Mfe = quantile(mfe, 0.25) ?? 0;
  const medianMae = quantile(mae, 0.5) ?? 0;
  const medianTerminal = quantile(terminal, 0.5) ?? 0;
  const pathQualitySpace = medianMfe - Math.abs(medianMae) * 0.5;
  const terminalSupportedSpace = Math.max(0, medianTerminal);
  const effectiveGrossOpportunityPct = Math.max(0, Math.min(p25Mfe, Math.max(pathQualitySpace, terminalSupportedSpace)));
  const standardError = terminal.length > 1 ? standardDeviation(terminal) / Math.sqrt(terminal.length) : Infinity;
  const uncertaintyBufferPct = Number.isFinite(standardError)
    ? policy.baseUncertaintyBufferPct + 1.645 * standardError
    : Infinity;
  return {
    samples: outcomes.length,
    meanTerminalReturnPct: round(mean(terminal) ?? 0, 6),
    medianTerminalReturnPct: round(medianTerminal, 6),
    p25TerminalReturnPct: round(quantile(terminal, 0.25), 6),
    meanNetTerminalReturnPct: round(mean(netTerminal) ?? 0, 6),
    medianMfePct: round(medianMfe, 6),
    p25MfePct: round(p25Mfe, 6),
    medianMaePct: round(medianMae, 6),
    medianMfeMaeRatio: round(quantile(outcomes.map((item) => Number(item.mfeMaeRatio)).filter(Number.isFinite), 0.5), 6),
    medianTimeToMfeMinutes: round(quantile(outcomes.map((item) => Number(item.timeToMfeMinutes)), 0.5), 2),
    medianTimeToMaeMinutes: round(quantile(outcomes.map((item) => Number(item.timeToMaeMinutes)), 0.5), 2),
    mfeFirstPct: round(outcomes.filter((item) => item.firstExtreme === "MFE_FIRST").length / outcomes.length * 100, 2),
    effectiveGrossOpportunityPct: round(effectiveGrossOpportunityPct, 6),
    estimationUncertaintyPct: round(uncertaintyBufferPct, 6)
  };
}

export function trainTradableEdgeModel(labelCatalog, {
  from,
  to,
  baseParameters = HISTORICAL_COMPATIBLE_PARAMETERS,
  policy = TRADABLE_EDGE_POLICY
} = {}) {
  const start = new Date(from).getTime();
  const cutoff = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(cutoff) || cutoff <= start) throw new Error("Tradable Edge training requires a valid from/to range");
  const accumulators = new Map();
  let eligibleRows = 0;
  for (const row of labelCatalog.rows) {
    if (row.timestamp < start || row.timestamp > cutoff) continue;
    if (Object.values(TRADABLE_EDGE_HORIZONS).some((bars) => row.timestamp + bars * BAR_MS > cutoff)) continue;
    eligibleRows += 1;
    for (const side of SIDES) {
      const state = row.states[side];
      for (const key of bucketKeys(state)) {
        if (!accumulators.has(key)) accumulators.set(key, Object.fromEntries(Object.keys(TRADABLE_EDGE_HORIZONS).map((horizon) => [horizon, []])));
        for (const horizon of Object.keys(TRADABLE_EDGE_HORIZONS)) {
          const outcome = row.outcomes[side][horizon];
          if (outcome) accumulators.get(key)[horizon].push(outcome);
        }
      }
    }
  }
  const buckets = Object.fromEntries([...accumulators.entries()].map(([key, horizons]) => [key, {
    key,
    level: key.split("|")[0],
    samples: Math.max(...Object.values(horizons).map((items) => items.length)),
    horizons: Object.fromEntries(Object.entries(horizons).map(([horizon, outcomes]) => [horizon, outcomes.length ? summarizeOutcomes(outcomes, policy) : null]))
  }]));
  const model = {
    schemaVersion: 1,
    modelType: "NON_ML_HIERARCHICAL_EMPIRICAL_TRADABLE_EDGE",
    version: `tradable-edge-model-${baseParameters.version}`,
    generatedAt: new Date().toISOString(),
    trainingRange: { from: new Date(start).toISOString(), to: new Date(cutoff).toISOString() },
    dataManifestHash: labelCatalog.dataManifestHash,
    labelCatalogHash: labelCatalog.labelsHash,
    trainingRows: eligibleRows,
    baseParameters,
    baseStrategyHash: hashObject(baseParameters),
    policy,
    inputs: ["OHLCV", "timestamped Funding", "existing multi-timeframe technical score", "existing market regime"],
    scoreSemantics: "Opportunity Index is an ordinal ranking derived from estimated net tradable edge; it is not confidence and not a success probability.",
    buckets
  };
  model.modelHash = hashObject(model);
  return model;
}

function chooseBucket(model, state) {
  for (const key of bucketKeys(state)) {
    const bucket = model.buckets[key];
    if (bucket?.samples >= Number(model.policy.minimumSamples)) return bucket;
  }
  return null;
}

export function estimateTradableEdgeForState(state, model, config = PAPER_CONFIG, policyOverrides = {}) {
  const policy = { ...model.policy, ...policyOverrides };
  const bucket = chooseBucket(model, state);
  const feePct = 2 * Number(config.feeRatePerSide) * 100;
  const slippagePct = 2 * Number(config.slippageRate) * 100;
  if (!bucket) return {
    side: state.side,
    status: "INSUFFICIENT_EVIDENCE",
    eligible: false,
    samples: 0,
    estimatedFeePct: round(feePct, 6),
    estimatedSlippagePct: round(slippagePct, 6),
    reason: `No point-in-time bucket has ${policy.minimumSamples} matured training samples`,
    opportunityIndex: 0,
    scoreSemantics: "ordinal net-edge ranking, not confidence or probability"
  };
  const horizons = Object.fromEntries(Object.entries(bucket.horizons).map(([horizon, statistics]) => {
    if (!statistics) return [horizon, null];
    const horizonHours = TRADABLE_EDGE_HORIZONS[horizon] / 4;
    const currentFundingPct = Number(state.fundingRatePct);
    const adverseFundingPerSettlement = Number.isFinite(currentFundingPct)
      ? Math.max(0, (state.side === "LONG" ? 1 : -1) * currentFundingPct)
      : 0;
    const fundingCostPct = adverseFundingPerSettlement * horizonHours / 8;
    const missingFundingBuffer = Number.isFinite(currentFundingPct) ? 0 : policy.missingFundingBufferPct;
    const uncertaintyBufferPct = Number(statistics.estimationUncertaintyPct)
      + Number(policy.horizonSelectionBufferPct)
      + missingFundingBuffer;
    const netTradableEdgePct = Number(statistics.effectiveGrossOpportunityPct)
      - feePct - slippagePct - fundingCostPct - uncertaintyBufferPct;
    return [horizon, {
      ...statistics,
      estimatedFeePct: round(feePct, 6),
      estimatedSlippagePct: round(slippagePct, 6),
      estimatedFundingCostPct: round(fundingCostPct, 6),
      uncertaintyBufferPct: round(uncertaintyBufferPct, 6),
      netTradableEdgePct: round(netTradableEdgePct, 6)
    }];
  }));
  const selected = Object.entries(horizons).filter(([, value]) => value)
    .sort((a, b) => Number(b[1].netTradableEdgePct) - Number(a[1].netTradableEdgePct))[0];
  const selectedHorizon = selected?.[0] ?? null;
  const estimate = selected?.[1] ?? null;
  const net = Number(estimate?.netTradableEdgePct ?? -Infinity);
  const opportunityIndex = Number.isFinite(net)
    ? clamp(50 + net / Math.max(Number(policy.minimumNetEdgePct), 0.1) * 25, 0, 100)
    : 0;
  return {
    side: state.side,
    status: estimate ? "OK" : "INSUFFICIENT_EVIDENCE",
    eligible: Boolean(estimate) && net >= Number(policy.minimumNetEdgePct),
    minimumNetEdgePct: Number(policy.minimumNetEdgePct),
    bucketKey: bucket.key,
    bucketLevel: bucket.level,
    samples: estimate?.samples ?? bucket.samples,
    selectedHorizon,
    estimatedGrossOpportunityPct: estimate?.effectiveGrossOpportunityPct ?? null,
    estimatedFeePct: estimate?.estimatedFeePct ?? round(feePct, 6),
    estimatedSlippagePct: estimate?.estimatedSlippagePct ?? round(slippagePct, 6),
    estimatedFundingCostPct: estimate?.estimatedFundingCostPct ?? null,
    uncertaintyBufferPct: estimate?.uncertaintyBufferPct ?? null,
    netTradableEdgePct: estimate?.netTradableEdgePct ?? null,
    opportunityIndex: round(opportunityIndex, 1),
    scoreSemantics: "ordinal net-edge ranking, not confidence or probability",
    horizons
  };
}

export function estimateTradableEdges(report, model, config = PAPER_CONFIG, policyOverrides = {}) {
  return Object.fromEntries(SIDES.map((side) => [side,
    estimateTradableEdgeForState(pointInTimeEdgeState(report, side), model, config, policyOverrides)
  ]));
}

export function applyTradableEdgeGate(baseReport, model, config = PAPER_CONFIG, policyOverrides = {}) {
  const report = structuredClone(baseReport);
  const rawDecision = baseReport.decision;
  const rawCandidateDecision = baseReport.candidateDecision;
  const estimates = estimateTradableEdges(baseReport, model, config, policyOverrides);
  const selectedSide = SIDES.includes(rawDecision) ? rawDecision : null;
  const selected = selectedSide ? estimates[selectedSide] : null;
  const observeOnly = policyOverrides.observeOnly === true;
  const allowed = Boolean(selectedSide && selected?.eligible && !observeOnly);
  report.mode = "TRADABLE_EDGE_SHADOW_PAPER_ONLY";
  report.version = policyOverrides.version ?? `tradable-edge-${baseReport.version}`;
  report.strategyHash = hashObject({ base: baseReport.strategyHash, model: model.modelHash, policyOverrides });
  report.directionDecision = rawCandidateDecision;
  report.preEdgeDecision = rawDecision;
  report.decision = allowed ? rawDecision : "WAIT";
  report.candidateDecision = allowed ? rawDecision : "WAIT";
  report.tradableEdge = {
    formula: "estimated gross opportunity - fees - slippage - adverse Funding - uncertainty buffer",
    modelHash: model.modelHash,
    trainingRange: model.trainingRange,
    estimates,
    selectedSide,
    allowed,
    observeOnly,
    rejectionReason: selectedSide && !allowed
      ? observeOnly
        ? "研究实时观测模式：新 Final OOS 尚未成熟，禁止创建候选模拟仓位"
        : (selected?.status === "INSUFFICIENT_EVIDENCE" ? selected.reason : `净可交易优势 ${selected?.netTradableEdgePct}% 未达到 ${selected?.minimumNetEdgePct}%`)
      : !selectedSide ? "方向/入场核心尚未给出可执行 LONG 或 SHORT" : null,
    scoreSemantics: model.scoreSemantics
  };
  for (const side of SIDES) {
    report.opportunities[side].rawDirectionalScore = Number(baseReport.opportunities?.[side]?.score ?? 50);
    report.opportunities[side].opportunityIndex = estimates[side].opportunityIndex;
    report.opportunities[side].score = estimates[side].opportunityIndex;
    report.opportunities[side].scoreSemantics = estimates[side].scoreSemantics;
  }
  const selectedIndex = estimates[selectedSide ?? rawCandidateDecision]?.opportunityIndex ?? Math.max(estimates.LONG.opportunityIndex, estimates.SHORT.opportunityIndex);
  report.confidencePct = selectedIndex;
  report.confidenceSemanticsDeprecated = true;
  report.opportunityIndex = selectedIndex;
  report.strategy = {
    ...report.strategy,
    version: report.version,
    baseStrategyVersion: baseReport.version,
    tradableEdgeGate: { allowed, minimumNetEdgePct: Number(policyOverrides.minimumNetEdgePct ?? model.policy.minimumNetEdgePct) }
  };
  if (!allowed) {
    report.hypotheticalPlanBeforeEdgeGate = structuredClone(baseReport.plan);
    report.plan = { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null };
    report.entryAssessment = {
      ...report.entryAssessment,
      enterNow: false,
      missingConditions: [...new Set([...(report.entryAssessment?.missingConditions ?? []), report.tradableEdge.rejectionReason])]
    };
    if (selectedSide) report.riskGates = [...(report.riskGates ?? []), `TRADABLE_EDGE: ${report.tradableEdge.rejectionReason}`];
  } else {
    report.entryAssessment.reasons = [
      `预计毛机会 ${selected.estimatedGrossOpportunityPct}%，扣除成本与不确定性后净优势 ${selected.netTradableEdgePct}%`,
      ...(report.entryAssessment?.reasons ?? [])
    ];
  }
  return report;
}

export function analyzeTradableEdge(market, parameters, config = PAPER_CONFIG, options = {}) {
  if (!parameters?.model) throw new Error("Tradable Edge analyzer requires a frozen empirical model");
  const baseParameters = parameters.baseParameters ?? parameters.model.baseParameters ?? HISTORICAL_COMPATIBLE_PARAMETERS;
  const base = analyzeHistoricalCompatible(market, baseParameters, config, options);
  return applyTradableEdgeGate(base, parameters.model, config, {
    minimumNetEdgePct: parameters.minimumNetEdgePct ?? parameters.model.policy.minimumNetEdgePct,
    observeOnly: parameters.observeOnly === true,
    version: parameters.version ?? `tradable-edge-${baseParameters.version}`
  });
}

export function buildTradableEdgeLabelCatalog(dataset, {
  from,
  to,
  sampleStrideBars = 4,
  baseParameters = HISTORICAL_COMPATIBLE_PARAMETERS,
  config = PAPER_CONFIG,
  onProgress = null
} = {}) {
  const start = new Date(from).getTime();
  const cutoff = new Date(to).getTime();
  const maximumHorizon = Math.max(...Object.values(TRADABLE_EDGE_HORIZONS));
  const first = Math.max(firstReplayableIndex(dataset.candles), dataset.candles.findIndex((row) => row.timestamp + BAR_MS >= start));
  const last = dataset.candles.findLastIndex((row) => row.timestamp + (maximumHorizon + 1) * BAR_MS <= cutoff);
  if (first < 0 || last < first) throw new Error("Tradable Edge label interval has no mature point-in-time samples");
  const decisions = [];
  for (let index = first; index <= last; index += sampleStrideBars) {
    const market = buildPointInTimeMarket(dataset.candles, dataset.funding, index);
    const report = analyzeHistoricalCompatible(market, baseParameters, config);
    decisions.push({
      timestamp: new Date(report.generatedAt).getTime(),
      price: report.currentPrice,
      baseDecision: report.decision,
      rawCandidateDecision: report.candidateDecision,
      entryMethod: report.entryAssessment?.method ?? "UNKNOWN",
      states: Object.fromEntries(SIDES.map((side) => [side, pointInTimeEdgeState(report, side)]))
    });
    if (decisions.length % 1_000 === 0) onProgress?.({ stage: "forward-labels", completed: decisions.length });
  }
  const catalog = buildForwardPathLabels(dataset, decisions, {
    feeRatePerSide: config.feeRatePerSide,
    slippageRate: config.slippageRate
  });
  catalog.sampleStrideBars = sampleStrideBars;
  catalog.range = { from: new Date(start).toISOString(), to: new Date(cutoff).toISOString() };
  catalog.baseParameters = baseParameters;
  catalog.baseStrategyHash = hashObject(baseParameters);
  catalog.labelsHash = hashObject({ ...catalog, labelsHash: undefined });
  return catalog;
}

export { scoreBand, atrCostBand, fundingBand };
