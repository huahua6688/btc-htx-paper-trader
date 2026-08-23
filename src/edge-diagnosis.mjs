import { join } from "node:path";
import { buildTradeAttribution } from "./attribution-engine.mjs";
import { CHALLENGER_BASE_PARAMETERS } from "./challenger-strategy.mjs";
import { runHistoricalReplay } from "./replay-engine.mjs";
import { buildWalkForwardWindows } from "./validation-engine.mjs";
import { hashObject, writeJsonAtomic } from "./research-utils.mjs";

export function datasetView(dataset, { from, to }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("Invalid dataset view range");
  return {
    ...dataset,
    manifest: {
      ...dataset.manifest,
      requestedCoverage: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      viewOfManifestHash: dataset.manifest.manifestHash,
      manifestHash: hashObject({ source: dataset.manifest.manifestHash, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() })
    },
    candles: dataset.candles.filter((item) => item.timestamp <= toMs),
    funding: dataset.funding.filter((item) => item.timestamp <= toMs + 8 * 60 * 60 * 1000)
  };
}

function flattenEntryGroups(attribution) {
  return Object.entries(attribution.dimensions)
    .filter(([, value]) => value.eligibleAtEntry)
    .flatMap(([dimension, value]) => Object.entries(value.groups).map(([group, metrics]) => ({ dimension, group, ...metrics })))
    .sort((a, b) => a.netExpectancyPct - b.netExpectancyPct);
}

function rootCauseSummary(replay, attribution) {
  const groups = flattenEntryGroups(attribution);
  const grossPositiveNetNegative = groups.filter((item) => item.grossEdgeCnyPerTrade > 0 && item.netExpectancyCny <= 0);
  const worstEntrySubsets = groups.filter((item) => item.trades >= 20).slice(0, 10);
  const bestEntrySubsets = groups.filter((item) => item.trades >= 20).slice(-10).reverse();
  const overall = attribution.overall;
  const reasons = [];
  if (overall.grossPnlCny > 0 && overall.netPnlCny < 0) reasons.push("The raw signal produced positive gross PnL, but fees, slippage and Funding exceeded the entire gross edge.");
  if (overall.grossPnlCny <= 0) reasons.push("The raw directional/lifecycle edge was non-positive before costs.");
  if (Number(overall.netProfitFactor ?? 0) < 1) reasons.push("Losses exceed profits after costs; net Profit Factor is below 1.");
  if (replay.actionCounts.DELAYED_ENTRY_REJECTED > replay.tradeCount * 5) reasons.push("The strategy emits many repeated signals while an entry is pending or risk-blocked, indicating weak event selectivity.");
  if (attribution.stableSubsets.length === 0) reasons.push("No entry-time subset passes the predeclared multi-window stability and confidence policy.");
  return {
    reasons,
    grossPositiveButCostsDestroyedEdge: grossPositiveNetNegative,
    worstEntryTimeSubsets: worstEntrySubsets,
    bestObservedEntryTimeSubsets: bestEntrySubsets,
    stableEntryTimeSubsets: attribution.stableSubsets.filter((item) => item.eligibleAtEntry),
    postOutcomeWarning: "Exit reason and holding duration can explain lifecycle losses but are forbidden as candidate entry filters."
  };
}

export async function runCurrentChallengerDiagnosis(dataset, {
  from = dataset.manifest.requestedCoverage.from,
  to = dataset.manifest.requestedCoverage.to,
  outputDirectory,
  onProgress = null
} = {}) {
  const view = datasetView(dataset, { from, to });
  const windows = buildWalkForwardWindows(view, 4);
  onProgress?.({ stage: "current-challenger-replay", status: "started" });
  const replay = await runHistoricalReplay(view, {
    strategy: "challenger",
    parameters: CHALLENGER_BASE_PARAMETERS,
    from,
    to,
    collectTrace: false,
    outputDirectory: outputDirectory ? join(outputDirectory, "current-challenger-replay") : undefined
  });
  const attribution = buildTradeAttribution(replay, { windows });
  const report = {
    schemaVersion: 1,
    runType: "CURRENT_CHALLENGER_EDGE_DIAGNOSIS",
    generatedAt: new Date().toISOString(),
    dataManifestHash: dataset.manifest.manifestHash,
    developmentRange: { from, to },
    strategyVersion: replay.strategyVersion,
    strategyHash: replay.strategyHash,
    replay: {
      eventCount: replay.eventCount,
      eventStreamHash: replay.eventStreamHash,
      tradeCount: replay.tradeCount,
      actionCounts: replay.actionCounts,
      performance: replay.performance
    },
    attribution,
    diagnosis: rootCauseSummary(replay, attribution),
    candidateInputPolicy: {
      mayUse: ["entry-time subsets stable under the declared OOS policy", "cost and lifecycle diagnostics"],
      forbidden: ["Final untouched OOS results", "exit type as an entry feature", "realized holding duration as an entry feature", "unavailable historical data", "ML"]
    }
  };
  if (outputDirectory) await writeJsonAtomic(join(outputDirectory, "challenger-diagnosis.json"), report);
  onProgress?.({ stage: "current-challenger-replay", status: "completed", trades: replay.tradeCount });
  return report;
}
