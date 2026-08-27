import { PAPER_CONFIG } from "./config.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { hashObject, quantile, round, seededRandom } from "./research-utils.mjs";

// V4 参数扰动沿用 exact-Paper 选参已经预先声明的 PF / 回撤门槛；
// Monte Carlo 亏损概率沿用现有 Promotion Gate 的 50% 上限，避免看完结果再改线。
export const V4_ROBUSTNESS_POLICY = Object.freeze({
  maximumLossProbabilityPct: 50,
  minimumStressProfitFactor: 1.05,
  minimumStressReturnPct: 0,
  minimumPerturbationProfitFactor: 1.05,
  minimumPerturbationReturnPct: 0,
  maximumPerturbationDrawdownPct: 25,
  requireDelayedExecutionEvidence: true
});

function pathMetrics(netPnl, initialCapital) {
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const pnl of netPnl) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    returnPct: (equity - initialCapital) / initialCapital * 100,
    maxDrawdownPct: peak > 0 ? maxDrawdown / peak * 100 : 100,
    endingEquity: equity
  };
}

function summarizeDistribution(paths) {
  const returns = paths.map((item) => item.returnPct);
  const drawdowns = paths.map((item) => item.maxDrawdownPct);
  return {
    simulations: paths.length,
    returnPct: {
      p05: round(quantile(returns, 0.05), 4), p25: round(quantile(returns, 0.25), 4),
      median: round(quantile(returns, 0.5), 4), p75: round(quantile(returns, 0.75), 4), p95: round(quantile(returns, 0.95), 4)
    },
    maxDrawdownPct: {
      p05: round(quantile(drawdowns, 0.05), 4), median: round(quantile(drawdowns, 0.5), 4),
      p95: round(quantile(drawdowns, 0.95), 4), worst: round(Math.max(...drawdowns), 4)
    },
    lossProbabilityPct: round(paths.filter((item) => item.returnPct < 0).length / paths.length * 100, 2)
  };
}

function outcomeSummary(values, initialCapital) {
  const path = pathMetrics(values, initialCapital);
  const profits = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    trades: values.length,
    returnPct: round(path.returnPct, 4),
    maxDrawdownPct: round(path.maxDrawdownPct, 4),
    endingEquity: round(path.endingEquity, 4),
    profitFactor: losses > 0 ? round(profits / losses, 4) : profits > 0 ? Number.MAX_SAFE_INTEGER : null,
    expectancyCny: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : 0
  };
}

/**
 * 在完全相同的 交易/仓位/退出 路径上只恶化费用，保证压力方向单调。
 * fresh replay 仍保留，用来观察成本改变最小合约步进和仓位占用后真实路径会怎样；
 * 但它不能替代这个 apples-to-apples 成本压力测试。
 */
export function repriceObservedTrades(trades, initialCapital, { feeMultiplier = 1, slippageMultiplier = 1 } = {}) {
  const values = trades.map((trade) => {
    const fees = Number(trade.entry_fee_cny ?? 0) + Number(trade.exit_fee_cny ?? 0);
    const slippage = Number(trade.entry_slippage_cny ?? 0) + Number(trade.exit_slippage_cny ?? 0);
    return Number(trade.net_pnl_cny) - Math.max(0, feeMultiplier - 1) * fees - Math.max(0, slippageMultiplier - 1) * slippage;
  });
  return outcomeSummary(values, initialCapital);
}

function resampleTrades(values, random) {
  return Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
}

function blockBootstrap(values, random, blockSize) {
  const output = [];
  while (output.length < values.length) {
    const start = Math.floor(random() * values.length);
    for (let offset = 0; offset < blockSize && output.length < values.length; offset += 1) output.push(values[(start + offset) % values.length]);
  }
  return output;
}

function tradePathHash(report) {
  return hashObject((report.trades ?? []).map((trade) => ({
    side: trade.side,
    openedAt: trade.opened_at,
    closedAt: trade.closed_at,
    exitReason: trade.exit_reason,
    quantityBtc: Number(trade.quantity_btc),
    entryPrice: Number(trade.entry_price),
    exitPrice: Number(trade.exit_price)
  })));
}

function scenarioSummary(report, basePathHash = null) {
  const pathHash = tradePathHash(report);
  return {
    strategyVersion: report.strategyVersion,
    strategyHash: report.strategyHash,
    trades: report.tradeCount,
    returnPct: report.performance.cumulativeReturnPct,
    maxDrawdownPct: report.performance.maxDrawdownPct,
    profitFactor: report.performance.profitFactor,
    tradeSharpe: report.performance.tradeSharpe,
    totalCostsCny: report.performance.totalCostsCny,
    portfolioLimits: report.portfolioLimits,
    tradePathHash: pathHash,
    sameTradePathAsBase: basePathHash === null ? true : pathHash === basePathHash,
    executable: report.tradeCount > 0
  };
}

export function evaluateV4RobustnessEvidence({
  tradeOrderResampling,
  blockBootstrap: block,
  pairedAccounting,
  parameterPerturbation,
  delayedExecutionEvidence,
  deterministicStress,
  base,
  policy = V4_ROBUSTNESS_POLICY
}) {
  const failureReasons = [];
  const blockedReasons = [];
  const warnings = [];
  if (Number(tradeOrderResampling?.lossProbabilityPct ?? 100) > policy.maximumLossProbabilityPct) {
    failureReasons.push("TRADE_ORDER_LOSS_PROBABILITY_EXCEEDED");
  }
  if (Number(block?.lossProbabilityPct ?? 100) > policy.maximumLossProbabilityPct) {
    failureReasons.push("BLOCK_BOOTSTRAP_LOSS_PROBABILITY_EXCEEDED");
  }
  for (const [label, stress] of Object.entries(pairedAccounting ?? {})) {
    if (label === "observedTradeBaseline") continue;
    if (!(Number(stress?.returnPct) >= policy.minimumStressReturnPct)) failureReasons.push(`PAIRED_STRESS_RETURN_FAILED:${label}`);
    if (!(Number(stress?.profitFactor) >= policy.minimumStressProfitFactor)) failureReasons.push(`PAIRED_STRESS_PROFIT_FACTOR_FAILED:${label}`);
  }
  for (const item of parameterPerturbation ?? []) {
    const result = item.result ?? {};
    if (!result.executable) failureReasons.push(`PARAMETER_PERTURBATION_NOT_EXECUTABLE:${item.label}`);
    if (!(Number(result.returnPct) >= policy.minimumPerturbationReturnPct)) failureReasons.push(`PARAMETER_PERTURBATION_RETURN_FAILED:${item.label}`);
    if (!(Number(result.profitFactor) >= policy.minimumPerturbationProfitFactor)) failureReasons.push(`PARAMETER_PERTURBATION_PROFIT_FACTOR_FAILED:${item.label}`);
    if (!(Number(result.maxDrawdownPct) <= policy.maximumPerturbationDrawdownPct)) failureReasons.push(`PARAMETER_PERTURBATION_DRAWDOWN_FAILED:${item.label}`);
  }
  if (policy.requireDelayedExecutionEvidence && !delayedExecutionEvidence?.available) {
    blockedReasons.push("DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE");
  }
  if (Number(tradeOrderResampling?.maxDrawdownPct?.p95 ?? 0) > policy.maximumPerturbationDrawdownPct) {
    warnings.push("TRADE_ORDER_P95_DRAWDOWN_ABOVE_DEVELOPMENT_LIMIT");
  }
  if (Number(block?.maxDrawdownPct?.p95 ?? 0) > policy.maximumPerturbationDrawdownPct) {
    warnings.push("BLOCK_BOOTSTRAP_P95_DRAWDOWN_ABOVE_DEVELOPMENT_LIMIT");
  }
  if (Number(deterministicStress?.allLossesFirst?.maxDrawdownPct ?? 0) > 100) {
    warnings.push("FIXED_PNL_PATH_CROSSES_ZERO_EQUITY");
  }
  for (const label of ["costDeterioration150Pct", "slippageDeterioration200Pct"]) {
    const stress = deterministicStress?.[label];
    if (stress && stress.sameTradePathAsBase === false && Number(stress.returnPct) > Number(base?.returnPct)) {
      warnings.push(`FRESH_REPLAY_OUTPERFORMED_AFTER_PATH_CHANGED:${label}`);
    }
  }
  const gateReasons = [...failureReasons, ...blockedReasons];
  const status = failureReasons.length ? "failed" : blockedReasons.length ? "partial" : "ok";
  return { passed: status === "ok", status, policy, failureReasons, blockedReasons, gateReasons, warnings };
}

export function robustnessParameterPerturbations(strategy, parameters) {
  if (strategy === "breakout-v4") return [
    { label: "lookback-minus-5pct", patch: { breakoutLookback4h: Math.max(10, Math.round(parameters.breakoutLookback4h * 0.95)) } },
    { label: "lookback-plus-5pct", patch: { breakoutLookback4h: Math.round(parameters.breakoutLookback4h * 1.05) } },
    { label: "stop-atr-minus-5pct", patch: { stopAtrMultiple: parameters.stopAtrMultiple * 0.95 } },
    { label: "stop-atr-plus-5pct", patch: { stopAtrMultiple: parameters.stopAtrMultiple * 1.05 } },
    { label: "target-rr-minus-5pct", patch: { targetRiskMultiple: parameters.targetRiskMultiple * 0.95 } },
    { label: "target-rr-plus-5pct", patch: { targetRiskMultiple: parameters.targetRiskMultiple * 1.05 } }
  ];
  if (strategy === "multi-venue-v3") return [
    { label: "opportunity-score-minus-5pct", patch: { minimumOpportunityScore: parameters.minimumOpportunityScore * 0.95 } },
    { label: "opportunity-score-plus-5pct", patch: { minimumOpportunityScore: parameters.minimumOpportunityScore * 1.05 } },
    { label: "net-edge-plus-5pct", patch: { minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct * 1.05 } },
    { label: "runner-break-even-plus-5pct", patch: { breakEvenTargetFraction: parameters.breakEvenTargetFraction * 1.05 } }
  ];
  if (strategy === "research-v2") return [
    { label: "direction-strength-minus-5pct", patch: { minimumDirectionStrength: parameters.minimumDirectionStrength * 0.95 } },
    { label: "direction-strength-plus-5pct", patch: { minimumDirectionStrength: parameters.minimumDirectionStrength * 1.05 } },
    { label: "net-edge-minus-5pct", patch: { minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct * 0.95 } },
    { label: "extension-plus-5pct", patch: { maximumExtensionAtr1h: parameters.maximumExtensionAtr1h * 1.05 } }
  ];
  return [
    { label: "signal-threshold-minus-5pct", patch: { signalThreshold: parameters.signalThreshold * 0.95 } },
    { label: "signal-threshold-plus-5pct", patch: { signalThreshold: parameters.signalThreshold * 1.05 } },
    { label: "stop-atr-minus-5pct", patch: { stopAtrMultiple: parameters.stopAtrMultiple * 0.95 } },
    { label: "target-rr-plus-5pct", patch: { targetRiskMultiple: parameters.targetRiskMultiple * 1.05 } }
  ];
}

export async function runMonteCarloRobustness(dataset, baseReplay, {
  parameters,
  strategy = baseReplay.strategy ?? "challenger",
  from = baseReplay.requestedRange.from,
  to = baseReplay.requestedRange.to,
  iterations = 2_000,
  seed = 20260822,
  outputDirectory,
  replayOptions = {}
} = {}) {
  const trades = baseReplay.trades;
  if (!trades.length) {
    return { status: "insufficient evidence", reason: "Monte Carlo requires at least one closed trade", trades: 0 };
  }
  const initialCapital = baseReplay.performance.initialCapitalCny;
  const values = trades.map((trade) => Number(trade.net_pnl_cny));
  const basePathHash = tradePathHash(baseReplay);
  const randomOrder = seededRandom(seed);
  const randomBlock = seededRandom(seed + 1);
  const blockSize = Math.max(2, Math.round(Math.sqrt(values.length)));
  const tradeOrderPaths = Array.from({ length: iterations }, () => pathMetrics(resampleTrades(values, randomOrder), initialCapital));
  const blockPaths = Array.from({ length: iterations }, () => pathMetrics(blockBootstrap(values, randomBlock, blockSize), initialCapital));
  const losses = values.filter((value) => value < 0).sort((a, b) => a - b);
  const wins = values.filter((value) => value >= 0);
  const lossStreak = pathMetrics([...losses, ...wins], initialCapital);
  const common = {
    ...replayOptions,
    strategy,
    parameters,
    from,
    to,
    collectTrace: false,
    capitalProfile: baseReplay.capital?.capitalProfile,
    referenceCapitalCny: baseReplay.capital?.initialCapitalCny
  };
  const [costWorse, slippageWorse, delay2, delay3] = await Promise.all([
    runHistoricalReplay(dataset, { ...common, paperConfig: { ...PAPER_CONFIG, feeRatePerSide: PAPER_CONFIG.feeRatePerSide * 1.5 }, outputDirectory: outputDirectory ? `${outputDirectory}/cost-150pct` : undefined }),
    runHistoricalReplay(dataset, { ...common, paperConfig: { ...PAPER_CONFIG, slippageRate: PAPER_CONFIG.slippageRate * 2 }, outputDirectory: outputDirectory ? `${outputDirectory}/slippage-200pct` : undefined }),
    runHistoricalReplay(dataset, { ...common, executionDelayBars: 2, outputDirectory: outputDirectory ? `${outputDirectory}/delay-2bars` : undefined }),
    runHistoricalReplay(dataset, { ...common, executionDelayBars: 3, outputDirectory: outputDirectory ? `${outputDirectory}/delay-3bars` : undefined })
  ]);
  const perturbations = robustnessParameterPerturbations(strategy, parameters);
  const parameterRuns = [];
  for (const item of perturbations) {
    const perturbed = { ...parameters, ...item.patch, version: `${parameters.version}-${item.label}` };
    const report = await runHistoricalReplay(dataset, {
      ...common,
      parameters: perturbed,
      outputDirectory: outputDirectory ? `${outputDirectory}/${item.label}` : undefined
    });
    parameterRuns.push({ label: item.label, parameters: perturbed, result: scenarioSummary(report, basePathHash) });
  }
  const baseSummary = scenarioSummary(baseReplay);
  const costWorseSummary = scenarioSummary(costWorse, basePathHash);
  const slippageWorseSummary = scenarioSummary(slippageWorse, basePathHash);
  const delay2Summary = scenarioSummary(delay2, basePathHash);
  const delay3Summary = scenarioSummary(delay3, basePathHash);
  const delayedExecutionEvidenceAvailable = delay2Summary.executable && delay3Summary.executable;
  const delayedExecutionEvidence = {
    available: delayedExecutionEvidenceAvailable,
    safetyRejectionExpected: strategy === "breakout-v4" && !delayedExecutionEvidenceAvailable,
    interpretation: delayedExecutionEvidenceAvailable
      ? "Both delayed-entry scenarios produced executable trades"
      : strategy === "breakout-v4"
        ? "The 15m delay scenarios exceed V4's five-minute signal-age contract. Zero trades proves the safety rejection, but 1-5 minute latency robustness remains historically unobservable at 15m resolution."
        : "At least one delayed-entry scenario produced zero trades and cannot count as a robustness pass"
  };
  const tradeOrderResampling = summarizeDistribution(tradeOrderPaths);
  const blockBootstrapSummary = { blockSize, ...summarizeDistribution(blockPaths) };
  const pairedAccounting = {
    observedTradeBaseline: repriceObservedTrades(trades, initialCapital),
    costDeterioration150Pct: repriceObservedTrades(trades, initialCapital, { feeMultiplier: 1.5 }),
    slippageDeterioration200Pct: repriceObservedTrades(trades, initialCapital, { slippageMultiplier: 2 })
  };
  const deterministicStress = {
    costDeterioration150Pct: costWorseSummary,
    slippageDeterioration200Pct: slippageWorseSummary,
    executionDelay2Bars: delay2Summary,
    executionDelay3Bars: delay3Summary,
    allLossesFirst: { returnPct: round(lossStreak.returnPct, 4), maxDrawdownPct: round(lossStreak.maxDrawdownPct, 4), endingEquity: round(lossStreak.endingEquity, 4) }
  };
  const gate = strategy === "breakout-v4"
    ? evaluateV4RobustnessEvidence({
      tradeOrderResampling,
      blockBootstrap: blockBootstrapSummary,
      pairedAccounting,
      parameterPerturbation: parameterRuns,
      delayedExecutionEvidence,
      deterministicStress,
      base: baseSummary
    })
    : { passed: true, status: "ok", policy: null, failureReasons: [], blockedReasons: [], gateReasons: [], warnings: [] };
  return {
    status: gate.status,
    reason: gate.gateReasons.length ? gate.gateReasons.join(", ") : null,
    runType: "MONTE_CARLO_AND_REPLAY_ROBUSTNESS",
    generatedAt: new Date().toISOString(),
    seed,
    sourceTrades: trades.length,
    base: baseSummary,
    executionContract: {
      eventStride: replayOptions.eventStride ?? 1,
      baseExecutionDelayBars: replayOptions.executionDelayBars ?? 1,
      forceCloseAtEnd: replayOptions.forceCloseAtEnd ?? true,
      capitalProfile: baseReplay.capital?.capitalProfile ?? replayOptions.capitalProfile ?? null,
      portfolio: baseReplay.portfolioLimits ?? replayOptions.portfolio ?? null
    },
    tradeOrderResampling,
    blockBootstrap: blockBootstrapSummary,
    pairedAccounting,
    deterministicStress,
    parameterPerturbation: parameterRuns,
    delayedExecutionEvidence,
    gate,
    modelLimitations: [
      "Trade-order and block-bootstrap paths reuse fixed observed CNY outcomes; they do not dynamically resize after equity changes or stop at zero equity.",
      "Paired-accounting drawdown is calculated from closed-trade CNY outcomes and must be compared with observedTradeBaseline, not the full replay's intratrade drawdown.",
      "Fresh cost/slippage replays may change contract-step acceptance and single-slot occupancy. Paired accounting is the monotonic same-trade cost stress; fresh replay is path-dependence evidence.",
      "Fifteen-minute history cannot reproduce a one-to-five-minute delayed fill without fabricating sub-bar prices; that evidence must come from timestamped Shadow/Paper observations."
    ],
    interpretation: "Resampling distributions preserve observed net trade outcomes; paired accounting holds the trade path fixed; fresh event-by-event replays expose path dependence under worsened assumptions."
  };
}
