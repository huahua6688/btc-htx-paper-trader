import { join } from "node:path";
import {
  HISTORICAL_COMPATIBLE_PARAMETERS,
  HISTORICAL_FEATURE_SETS
} from "./challenger-strategy.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { buildWalkForwardWindows } from "./validation-engine.mjs";
import { hashObject, mean, round, writeJsonAtomic } from "./research-utils.mjs";
import { summarizeAttribution } from "./attribution-engine.mjs";

export const FEATURE_ABLATION_LAYERS = Object.freeze([
  Object.freeze({ featureSet: "OHLC", label: "OHLC price structure only", complexity: 1 }),
  Object.freeze({ featureSet: "OHLCV", label: "OHLC + timestamped volume", complexity: 2 }),
  Object.freeze({ featureSet: "OHLCV_FUNDING", label: "OHLCV + timestamped HTX Funding", complexity: 3 })
]);

function parametersFor(layer) {
  return {
    ...HISTORICAL_COMPATIBLE_PARAMETERS,
    version: `historical-compatible-${layer.featureSet.toLowerCase().replaceAll("_", "-")}-v1`,
    featureSet: layer.featureSet
  };
}

function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

function replaySummary(replay) {
  return {
    strategyVersion: replay.strategyVersion,
    strategyHash: replay.strategyHash,
    eventCount: replay.eventCount,
    eventStreamHash: replay.eventStreamHash,
    tradeCount: replay.tradeCount,
    performance: replay.performance,
    attribution: summarizeAttribution(replay.tradeContexts)
  };
}

function compareWindows(baseline, candidate) {
  const windows = candidate.windows.map((item, index) => {
    const prior = baseline.windows[index];
    if (prior.eventStreamHash !== item.eventStreamHash) throw new Error("Feature ablation did not consume identical OOS events");
    return {
      index: item.index,
      netReturnPct: round(item.performance.cumulativeReturnPct - prior.performance.cumulativeReturnPct, 6),
      netExpectancyCny: round(item.attribution.netExpectancyCny - prior.attribution.netExpectancyCny, 6),
      netProfitFactor: round(finite(item.performance.profitFactor) - finite(prior.performance.profitFactor), 6),
      tradeSharpe: round(finite(item.performance.tradeSharpe) - finite(prior.performance.tradeSharpe), 6),
      maxDrawdownPct: round(item.performance.maxDrawdownPct - prior.performance.maxDrawdownPct, 6),
      tradeCount: item.tradeCount
    };
  });
  const positiveWindows = windows.filter((item) => item.netReturnPct > 0
    && item.netExpectancyCny > 0 && item.netProfitFactor >= 0).length;
  const aggregate = {
    netReturnPct: round(mean(windows.map((item) => item.netReturnPct)), 6),
    netExpectancyCny: round(mean(windows.map((item) => item.netExpectancyCny)), 6),
    netProfitFactor: round(mean(windows.map((item) => item.netProfitFactor)), 6),
    tradeSharpe: round(mean(windows.map((item) => item.tradeSharpe)), 6),
    maxDrawdownPct: round(mean(windows.map((item) => item.maxDrawdownPct)), 6),
    positiveWindows
  };
  const reasons = [];
  if (positiveWindows < 3) reasons.push("increment is positive in fewer than 3/4 OOS windows");
  if (!(aggregate.netReturnPct > 0)) reasons.push("mean OOS net-return increment is not positive");
  if (!(aggregate.netExpectancyCny > 0)) reasons.push("mean OOS net-expectancy increment is not positive");
  if (!(aggregate.netProfitFactor >= 0)) reasons.push("mean OOS Profit Factor increment is negative");
  if (!(aggregate.tradeSharpe > 0)) reasons.push("mean OOS Sharpe increment is not positive");
  return { accepted: reasons.length === 0, reasons, aggregate, windows };
}

export async function runHistoricalFeatureAblation(dataset, {
  outputDirectory,
  layers = FEATURE_ABLATION_LAYERS,
  onProgress = null
} = {}) {
  for (const layer of layers) {
    if (!HISTORICAL_FEATURE_SETS[layer.featureSet]) throw new Error(`Feature ablation contains an unsupported layer: ${layer.featureSet}`);
  }
  const windows = buildWalkForwardWindows(dataset, 4);
  const results = [];
  for (const layer of layers) {
    const parameters = parametersFor(layer);
    const windowResults = [];
    for (const window of windows) {
      onProgress?.({ stage: "feature-ablation", featureSet: layer.featureSet, window: window.index });
      const replay = await runHistoricalReplay(dataset, {
        strategy: "historical-compatible",
        parameters,
        from: window.testStart,
        to: window.testEnd,
        collectTrace: false,
        outputDirectory: outputDirectory ? join(outputDirectory, layer.featureSet, `window-${window.index}`) : undefined
      });
      windowResults.push({ index: window.index, range: { from: window.testStart, to: window.testEnd }, ...replaySummary(replay) });
    }
    results.push({ ...layer, parameters, strategyHash: hashObject(parameters), windows: windowResults });
  }
  const incremental = [];
  for (let index = 1; index < results.length; index += 1) {
    incremental.push({
      baseline: results[index - 1].featureSet,
      candidate: results[index].featureSet,
      addedFeature: results[index].featureSet === "OHLCV" ? "timestamped volume" : "timestamped HTX Funding",
      ...compareWindows(results[index - 1], results[index])
    });
  }
  let selected = results[0];
  for (let index = 0; index < incremental.length; index += 1) {
    if (incremental[index].accepted && selected.featureSet === incremental[index].baseline) selected = results[index + 1];
  }
  const totalOosTrades = selected.windows.reduce((sum, item) => sum + item.tradeCount, 0);
  const positivePerformanceWindows = selected.windows.filter((item) => item.performance.cumulativePnlCny > 0
    && Number(item.performance.profitFactor ?? 0) > 1).length;
  const report = {
    schemaVersion: 1,
    runType: "POINT_IN_TIME_HISTORICAL_FEATURE_ABLATION",
    generatedAt: new Date().toISOString(),
    dataManifestHash: dataset.manifest.manifestHash,
    range: dataset.manifest.requestedCoverage,
    layers: results,
    incremental,
    historicalCompatibleChampion: {
      version: selected.parameters.version,
      strategyHash: selected.strategyHash,
      featureSet: selected.featureSet,
      selectionRule: "Start at OHLC and add the next layer only when its incremental net contribution is positive in at least 3/4 OOS windows and all mean cost-adjusted metrics improve.",
      pointInTimeOnly: true,
      unavailableHistorySynthesized: false,
      totalOosTrades,
      positivePerformanceWindows,
      stableNetEdgeProven: totalOosTrades >= 100 && positivePerformanceWindows >= 3,
      liveChampionChanged: false
    },
    forbiddenInputs: ["historical Order Book", "historical OI", "historical liquidations", "historical elite positioning", "historical Mark/Basis"],
    note: "Feature selection uses only walk-forward OOS windows inside the development dataset. No sealed Final OOS event is read here."
  };
  if (outputDirectory) await writeJsonAtomic(join(outputDirectory, "feature-ablation-report.json"), report);
  return report;
}

export function historicalParametersForFeatureSet(featureSet) {
  const layer = FEATURE_ABLATION_LAYERS.find((item) => item.featureSet === featureSet);
  if (!layer) throw new Error(`Unknown historical feature set: ${featureSet}`);
  return parametersFor(layer);
}
