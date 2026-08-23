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
    totalCostsCny: report.performance.totalCostsCny
  };
}

export async function runMonteCarloRobustness(dataset, baseReplay, {
  parameters,
  from = baseReplay.requestedRange.from,
  to = baseReplay.requestedRange.to,
  iterations = 2_000,
  seed = 20260822,
  outputDirectory
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
  const common = { strategy: "challenger", parameters, from, to, collectTrace: false };
  const [costWorse, slippageWorse, delay2, delay3] = await Promise.all([
    runHistoricalReplay(dataset, { ...common, paperConfig: { ...PAPER_CONFIG, feeRatePerSide: PAPER_CONFIG.feeRatePerSide * 1.5 }, outputDirectory: outputDirectory ? `${outputDirectory}/cost-150pct` : undefined }),
    runHistoricalReplay(dataset, { ...common, paperConfig: { ...PAPER_CONFIG, slippageRate: PAPER_CONFIG.slippageRate * 2 }, outputDirectory: outputDirectory ? `${outputDirectory}/slippage-200pct` : undefined }),
    runHistoricalReplay(dataset, { ...common, executionDelayBars: 2, outputDirectory: outputDirectory ? `${outputDirectory}/delay-2bars` : undefined }),
    runHistoricalReplay(dataset, { ...common, executionDelayBars: 3, outputDirectory: outputDirectory ? `${outputDirectory}/delay-3bars` : undefined })
  ]);
  const perturbations = [
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
  return {
    status: "ok",
    runType: "MONTE_CARLO_AND_REPLAY_ROBUSTNESS",
    generatedAt: new Date().toISOString(),
    seed,
    sourceTrades: trades.length,
    base: scenarioSummary(baseReplay),
    tradeOrderResampling: summarizeDistribution(tradeOrderPaths),
    blockBootstrap: { blockSize, ...summarizeDistribution(blockPaths) },
    deterministicStress: {
      costDeterioration150Pct: scenarioSummary(costWorse),
      slippageDeterioration200Pct: scenarioSummary(slippageWorse),
      executionDelay2Bars: scenarioSummary(delay2),
      executionDelay3Bars: scenarioSummary(delay3),
      allLossesFirst: { returnPct: round(lossStreak.returnPct, 4), maxDrawdownPct: round(lossStreak.maxDrawdownPct, 4), endingEquity: round(lossStreak.endingEquity, 4) }
    },
    parameterPerturbation: parameterRuns,
    interpretation: "Resampling distributions preserve observed net trade outcomes; deterministic stresses are fresh event-by-event replays with worsened assumptions."
  };
}
