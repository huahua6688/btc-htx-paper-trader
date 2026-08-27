import { PAPER_CONFIG } from "./config.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { quantile, round, seededRandom } from "./research-utils.mjs";

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

function scenarioSummary(report) {
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
    executable: report.tradeCount > 0
  };
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
  const perturbations = strategy === "breakout-v4" ? [
    { label: "lookback-minus-5pct", patch: { breakoutLookback4h: Math.max(10, Math.round(parameters.breakoutLookback4h * 0.95)) } },
    { label: "lookback-plus-5pct", patch: { breakoutLookback4h: Math.round(parameters.breakoutLookback4h * 1.05) } },
    { label: "stop-atr-minus-5pct", patch: { stopAtrMultiple: parameters.stopAtrMultiple * 0.95 } },
    { label: "target-rr-plus-5pct", patch: { targetRiskMultiple: parameters.targetRiskMultiple * 1.05 } }
  ] : strategy === "multi-venue-v3" ? [
    { label: "opportunity-score-minus-5pct", patch: { minimumOpportunityScore: parameters.minimumOpportunityScore * 0.95 } },
    { label: "opportunity-score-plus-5pct", patch: { minimumOpportunityScore: parameters.minimumOpportunityScore * 1.05 } },
    { label: "net-edge-plus-5pct", patch: { minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct * 1.05 } },
    { label: "runner-break-even-plus-5pct", patch: { breakEvenTargetFraction: parameters.breakEvenTargetFraction * 1.05 } }
  ] : strategy === "research-v2" ? [
    { label: "direction-strength-minus-5pct", patch: { minimumDirectionStrength: parameters.minimumDirectionStrength * 0.95 } },
    { label: "direction-strength-plus-5pct", patch: { minimumDirectionStrength: parameters.minimumDirectionStrength * 1.05 } },
    { label: "net-edge-minus-5pct", patch: { minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct * 0.95 } },
    { label: "extension-plus-5pct", patch: { maximumExtensionAtr1h: parameters.maximumExtensionAtr1h * 1.05 } }
  ] : [
    { label: "signal-threshold-minus-5pct", patch: { signalThreshold: parameters.signalThreshold * 0.95 } },
    { label: "signal-threshold-plus-5pct", patch: { signalThreshold: parameters.signalThreshold * 1.05 } },
    { label: "stop-atr-minus-5pct", patch: { stopAtrMultiple: parameters.stopAtrMultiple * 0.95 } },
    { label: "target-rr-plus-5pct", patch: { targetRiskMultiple: parameters.targetRiskMultiple * 1.05 } }
  ];
  const parameterRuns = [];
  for (const item of perturbations) {
    const perturbed = { ...parameters, ...item.patch, version: `${parameters.version}-${item.label}` };
    const report = await runHistoricalReplay(dataset, {
      ...common,
      parameters: perturbed,
      outputDirectory: outputDirectory ? `${outputDirectory}/${item.label}` : undefined
    });
    parameterRuns.push({ label: item.label, parameters: perturbed, result: scenarioSummary(report) });
  }
  const delay2Summary = scenarioSummary(delay2);
  const delay3Summary = scenarioSummary(delay3);
  const delayedExecutionEvidenceAvailable = delay2Summary.executable && delay3Summary.executable;
  const delayedExecutionBlocksV4Robustness = strategy === "breakout-v4" && !delayedExecutionEvidenceAvailable;
  return {
    status: delayedExecutionBlocksV4Robustness ? "partial" : "ok",
    reason: delayedExecutionBlocksV4Robustness
      ? "Breakout V4 delayed-execution scenarios produced no executable trades under the maximum signal-age contract"
      : null,
    runType: "MONTE_CARLO_AND_REPLAY_ROBUSTNESS",
    generatedAt: new Date().toISOString(),
    seed,
    sourceTrades: trades.length,
    base: scenarioSummary(baseReplay),
    executionContract: {
      eventStride: replayOptions.eventStride ?? 1,
      baseExecutionDelayBars: replayOptions.executionDelayBars ?? 1,
      forceCloseAtEnd: replayOptions.forceCloseAtEnd ?? true,
      capitalProfile: baseReplay.capital?.capitalProfile ?? replayOptions.capitalProfile ?? null,
      portfolio: baseReplay.portfolioLimits ?? replayOptions.portfolio ?? null
    },
    tradeOrderResampling: summarizeDistribution(tradeOrderPaths),
    blockBootstrap: { blockSize, ...summarizeDistribution(blockPaths) },
    deterministicStress: {
      costDeterioration150Pct: scenarioSummary(costWorse),
      slippageDeterioration200Pct: scenarioSummary(slippageWorse),
      executionDelay2Bars: delay2Summary,
      executionDelay3Bars: delay3Summary,
      allLossesFirst: { returnPct: round(lossStreak.returnPct, 4), maxDrawdownPct: round(lossStreak.maxDrawdownPct, 4), endingEquity: round(lossStreak.endingEquity, 4) }
    },
    parameterPerturbation: parameterRuns,
    delayedExecutionEvidence: {
      available: delayedExecutionEvidenceAvailable,
      interpretation: delayedExecutionEvidenceAvailable
        ? "Both delayed-entry scenarios produced executable trades"
        : "At least one delayed-entry scenario produced zero trades and cannot count as a robustness pass"
    },
    interpretation: "Resampling distributions preserve observed net trade outcomes; deterministic stresses are fresh event-by-event replays with worsened assumptions."
  };
}
