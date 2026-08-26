import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BREAKOUT_V4_DEVELOPMENT_SPEC,
  BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC,
  BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC,
  breakoutV4CandidateGrid,
  runBreakoutV4ExactPaperDevelopmentSelection,
  runBreakoutV4DevelopmentSelection
} from "../src/breakout-v4-selection.mjs";
import { BREAKOUT_V4_PARAMETERS } from "../src/breakout-challenger.mjs";
import { hashObject } from "../src/research-utils.mjs";

const BAR_MS = 15 * 60 * 1000;

function syntheticCatalog() {
  const start = new Date(BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.from).getTime();
  const cutoff = new Date(BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.to).getTime();
  const candles = [];
  let prior = 100;
  for (let timestamp = start; timestamp <= cutoff + 10 * BAR_MS; timestamp += BAR_MS) {
    const index = candles.length;
    const close = 100 + index * 0.002 + Math.sin(index / 180) * 5 + Math.sin(index / 19) * 0.3;
    candles.push({
      timestamp,
      open: prior,
      high: Math.max(prior, close) + 0.15,
      low: Math.min(prior, close) - 0.15,
      close,
      volumeBtc: 1
    });
    prior = close;
  }
  return {
    manifest: {
      manifestHash: "synthetic-development-catalog",
      datasetId: "synthetic-development-catalog",
      requestedCoverage: {
        from: BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.from,
        to: BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.to
      }
    },
    candles,
    funding: [],
    series: {}
  };
}

function fakePaperReplay(parameters) {
  const start = new Date("2024-11-01T00:00:00.000Z").getTime();
  const end = new Date(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC.developmentRange.to).getTime();
  const width = (end - start + 1) / 4;
  const unstable = parameters.targetRiskMultiple === 5;
  const segmentNet = unstable ? [-10, 1_000, 10, -10] : [20, 20, 20, 20];
  const trades = [];
  for (let segment = 0; segment < 4; segment += 1) {
    const positiveGross = segmentNet[segment] > 0 ? segmentNet[segment] + 10 : 10;
    const negativeGross = positiveGross - segmentNet[segment];
    for (let index = 0; index < 10; index += 1) {
      const net = index < 5 ? positiveGross / 5 : -negativeGross / 5;
      trades.push({
        opened_at: new Date(start + segment * width + (index + 1) * 60_000).toISOString(),
        net_pnl_cny: net,
        gross_pnl_cny: net + 0.1
      });
    }
  }
  const netPnlCny = segmentNet.reduce((sum, value) => sum + value, 0);
  return {
    effectiveRange: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
    capital: { initialCapitalCny: 1_000 },
    trades,
    tradeCount: trades.length,
    performance: {
      totalTrades: trades.length,
      wins: 20,
      cumulativePnlCny: netPnlCny,
      cumulativeReturnPct: netPnlCny / 10,
      profitFactor: unstable ? 2.5 : 1.5,
      expectancyCny: netPnlCny / trades.length,
      maxDrawdownPct: unstable ? 20 : 8,
      tradeSharpe: unstable ? 1.8 : 1.1,
      totalCostsCny: 4
    },
    entryRejections: { total: 0 },
    portfolioLimits: { maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false }
  };
}

test("V4 development grid and selection are reproducible without post-cutoff outcomes", () => {
  assert.equal(breakoutV4CandidateGrid().length, 128);
  const dataset = syntheticCatalog();
  const baseline = runBreakoutV4DevelopmentSelection(dataset);
  const cutoff = new Date(BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange.to).getTime();
  const poisoned = {
    ...dataset,
    candles: dataset.candles.map((item) => item.timestamp + BAR_MS <= cutoff ? item : {
      ...item,
      open: 9_999_999,
      high: 99_999_999,
      low: 0.0001,
      close: 42
    })
  };
  const rerun = runBreakoutV4DevelopmentSelection(poisoned);
  assert.equal(baseline.search.candidateCount, 128);
  assert.equal(baseline.isolation.holdoutOpened, false);
  assert.equal(baseline.isolation.postCutoffOutcomeFieldsRead, false);
  assert.ok(new Date(baseline.isolation.maximumCandleVisibleAtRead).getTime() <= cutoff);
  assert.equal(rerun.selectionHash, baseline.selectionHash);
  assert.deepEqual(rerun.winner, baseline.winner);
  assert.equal(baseline.strategyRoleAfterSelection, "RESEARCH_SHADOW_CANDIDATE");
  assert.equal(baseline.championChanged, false);
});

test("the committed V4 selection record matches the executable spec and winner", () => {
  const record = JSON.parse(readFileSync(new URL("../BREAKOUT_V4_DEVELOPMENT_SELECTION_2026_08_24.json", import.meta.url), "utf8"));
  const grid = breakoutV4CandidateGrid();
  assert.equal(record.specHash, hashObject(BREAKOUT_V4_DEVELOPMENT_SPEC));
  assert.equal(record.candidateGridHash, hashObject(grid.map((item) => item.parameterHash)));
  assert.equal(record.winner.parameterHash, hashObject(BREAKOUT_V4_PARAMETERS));
  assert.equal(record.postSelectionRole, "RESEARCH_SHADOW_CANDIDATE");
  assert.equal(record.championChanged, false);
});

test("long-history selection rejects proxy winners that cannot pass the real Paper net-RR gate", () => {
  const dataset = syntheticCatalog();
  const spec = {
    ...BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC,
    developmentRange: BREAKOUT_V4_DEVELOPMENT_SPEC.developmentRange
  };
  const result = runBreakoutV4DevelopmentSelection(dataset, { spec });
  const twoRiskCandidates = result.candidates.filter((item) => item.parameters.targetRiskMultiple === 2);
  assert.ok(twoRiskCandidates.length > 0);
  assert.ok(twoRiskCandidates.every((item) => item.metrics.tradeCount === 0));
  assert.ok(twoRiskCandidates.every((item) => item.metrics.eligible === false));
  assert.ok(twoRiskCandidates.every((item) => item.metrics.netRrRejectedSignals > 0));
  assert.ok(result.winner.parameters.targetRiskMultiple > spec.executionModel.minimumRiskReward);
  assert.equal(result.isolation.holdoutOpened, false);
});

test("exact-Paper selector prefers cross-segment stability over one concentrated profit period", async () => {
  const dataset = syntheticCatalog();
  const grid = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC);
  const stable = grid.find((item) => item.parameters.targetRiskMultiple === 4);
  const unstable = grid.find((item) => item.parameters.targetRiskMultiple === 5);
  let calls = 0;
  const replayRunner = async (cutoffDataset, options) => {
    calls += 1;
    const cutoff = new Date(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC.developmentRange.to).getTime();
    assert.ok(cutoffDataset.candles.every((item) => Number(item.timestamp) + BAR_MS <= cutoff));
    assert.ok(cutoffDataset.funding.every((item) => Number(item.timestamp) <= cutoff));
    return fakePaperReplay(options.parameters);
  };
  const result = await runBreakoutV4ExactPaperDevelopmentSelection(dataset, {
    candidates: [unstable, stable],
    replayRunner
  });
  assert.equal(calls, 2);
  assert.equal(result.search.candidateCount, 2);
  assert.equal(result.search.exactPaperCandidateCount, 2);
  assert.equal(result.winner.parameterHash, stable.parameterHash);
  assert.equal(result.winner.metrics.positiveSegments, 4);
  assert.equal(result.bestObservedCandidate.parameterHash, stable.parameterHash);
  const rejected = result.candidates.find((item) => item.parameterHash === unstable.parameterHash);
  assert.equal(rejected.metrics.eligible, false);
  assert.ok(rejected.metrics.eligibilityReasons.includes("MINIMUM_POSITIVE_SEGMENTS_NOT_MET"));
  assert.ok(rejected.metrics.eligibilityReasons.includes("SINGLE_SEGMENT_PROFIT_CONCENTRATION_EXCEEDED"));
  assert.equal(result.isolation.holdoutOpened, false);
});

test("exact-Paper selector excludes poisoned post-cutoff rows before every replay", async () => {
  const dataset = syntheticCatalog();
  const cutoff = new Date(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC.developmentRange.to).getTime();
  dataset.funding.push({ timestamp: cutoff + 1, rate: 999 });
  dataset.series.markPrice = [{ eventTime: cutoff + 1, visibleAt: cutoff + 1, close: 999_999 }];
  const candidate = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC)
    .find((item) => item.parameters.targetRiskMultiple === 4);
  const result = await runBreakoutV4ExactPaperDevelopmentSelection(dataset, {
    candidates: [candidate],
    replayRunner: async (cutoffDataset, options) => {
      assert.equal(cutoffDataset.funding.length, 0);
      assert.equal(cutoffDataset.series.markPrice.length, 0);
      return fakePaperReplay(options.parameters);
    }
  });
  assert.equal(result.isolation.postCutoffOutcomeFieldsRead, false);
  assert.ok(new Date(result.isolation.maximumCandleVisibleAtRead).getTime() <= cutoff);
  assert.equal(result.winner.parameterHash, candidate.parameterHash);
});

test("exact-Paper selector can invoke the real replay core for a candidate", async () => {
  const candidate = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC)
    .find((item) => item.parameters.targetRiskMultiple === 5 && item.parameters.stopAtrMultiple === 1.5);
  const result = await runBreakoutV4ExactPaperDevelopmentSelection(syntheticCatalog(), { candidates: [candidate] });
  assert.equal(result.search.exactPaperCandidateCount, 1);
  assert.equal(result.bestObservedCandidate.metrics.executionMode, "EXACT_PAPER");
  assert.ok(result.bestObservedCandidate.metrics.entryRejections);
  assert.equal(result.isolation.holdoutOpened, false);
  assert.equal(result.championChanged, false);
});
