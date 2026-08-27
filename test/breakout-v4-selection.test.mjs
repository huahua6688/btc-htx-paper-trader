import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BREAKOUT_V4_DEVELOPMENT_SPEC,
  BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC,
  BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC,
  breakoutV4CandidateGrid,
  runBreakoutV4ExactPaperDevelopmentSelection,
  runBreakoutV4LocalResilienceSelection,
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

test("--long-history 才切到扩展规格，默认保持已登记的选参可复现", async () => {
  const { breakoutV4SpecOption } = await import("../src/research-cli.mjs");
  const {
    BREAKOUT_V4_DEVELOPMENT_SPEC: base,
    BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC: extended
  } = await import("../src/breakout-v4-selection.mjs");

  // 不传参数必须拿到旧规格：已登记的 selection hash 依赖它逐字节不变。
  assert.equal(breakoutV4SpecOption({}), base);
  assert.equal(breakoutV4SpecOption({ "long-history": "false" }), base);
  assert.equal(breakoutV4SpecOption({ "long-history": "0" }), base);

  // 显式开启才用扩展规格。
  assert.equal(breakoutV4SpecOption({ "long-history": true }), extended);
  assert.equal(breakoutV4SpecOption({ "long-history": "true" }), extended);

  // 旧规格不得带净 RR 门槛，否则旧的 winner 会被重新筛掉。
  assert.equal(base.executionModel.minimumRiskReward, undefined);
  assert.ok(Number.isFinite(extended.executionModel.minimumRiskReward));

  // 两套规格的开发区间终点必须一致：只有起点前推，cutoff 不能被顺手放宽，
  // 否则「不打开未成熟 holdout」这条保证就破了。
  assert.equal(extended.developmentRange.to, base.developmentRange.to);
  assert.ok(new Date(extended.developmentRange.from) < new Date(base.developmentRange.from));
});

test("--retry-unavailable 只清掉保留窗口拒绝的完成标记", async () => {
  // 模拟 checkpoint 的清理逻辑：只有带 historicalUnavailableReason 的条目会被删，
  // 真正成功下载过的条目必须原样保留，否则一次开关会让整个目录重下。
  const completed = {
    kline: { at: "2026-08-26T00:00:00.000Z", records: 67104 },
    funding: { at: "2026-08-26T00:00:00.000Z", records: 2098 },
    settlement: { at: "2026-08-26T00:00:00.000Z", records: 0, historicalUnavailableReason: "HTX_RETENTION_BOUNDED_REQUEST_REJECTED" }
  };
  const cleared = { ...completed };
  for (const [type, entry] of Object.entries(cleared)) {
    if (entry?.historicalUnavailableReason) delete cleared[type];
  }
  assert.deepEqual(Object.keys(cleared).sort(), ["funding", "kline"]);
  assert.equal(cleared.kline.records, 67104);
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

test("exact-Paper winner artifact is hash-verified before downstream research", async () => {
  const { verifyBreakoutV4SelectionReport } = await import("../src/research-cli.mjs");
  const candidate = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC)
    .find((item) => item.parameters.targetRiskMultiple === 4);
  const report = await runBreakoutV4ExactPaperDevelopmentSelection(syntheticCatalog(), {
    candidates: [candidate],
    replayRunner: async (dataset, options) => fakePaperReplay(options.parameters)
  });
  const selected = verifyBreakoutV4SelectionReport(report);
  assert.equal(selected.parameterHash, candidate.parameterHash);
  assert.equal(selected.parameters.targetRiskMultiple, 4);
  assert.equal(selected.replayOptions.executionDelayBars, 1);
  assert.deepEqual(selected.replayOptions.portfolio, { maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false });
  assert.equal(selected.developmentRange.to, "2026-01-17T06:15:00.000Z");

  assert.throws(
    () => verifyBreakoutV4SelectionReport({ ...report, winner: { ...report.winner, parameterHash: "tampered" } }),
    /parameterHash/
  );
  assert.throws(
    () => verifyBreakoutV4SelectionReport({ ...report, selectionHash: "tampered" }),
    /selectionHash/
  );
  assert.throws(
    () => verifyBreakoutV4SelectionReport({ ...report, selectionStatus: "NO_ELIGIBLE_WINNER", winner: null }),
    /没有通过 eligibility gate/
  );
});

test("local-resilience selection rejects an isolated winner and advances to the first stable candidate", async () => {
  const dataset = syntheticCatalog();
  const candidates = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC)
    .filter((item) => item.parameters.targetRiskMultiple === 4
      && item.parameters.stopAtrMultiple === 1.5
      && item.parameters.trendFilter === "EMA50_PRICE_ALIGNMENT")
    .slice(0, 2);
  const source = await runBreakoutV4ExactPaperDevelopmentSelection(dataset, {
    candidates,
    replayRunner: async (cutoffDataset, options) => fakePaperReplay(options.parameters)
  });
  const ordered = source.candidates.filter((item) => item.metrics.eligible);
  assert.equal(ordered.length, 2);
  const isolatedLookback = Math.round(ordered[0].parameters.breakoutLookback4h * 0.95);
  const calls = [];
  const report = await runBreakoutV4LocalResilienceSelection(dataset, source, {
    replayRunner: async (cutoffDataset, options) => {
      calls.push(options.parameters.version);
      const isolated = options.parameters.version.endsWith("lookback-minus-5pct")
        && options.parameters.breakoutLookback4h === isolatedLookback;
      return isolated
        ? fakePaperReplay({ ...options.parameters, targetRiskMultiple: 5 })
        : fakePaperReplay(options.parameters);
    }
  });
  assert.equal(calls.length, 7);
  assert.equal(report.selectionStatus, "LOCAL_RESILIENCE_WINNER_FOUND");
  assert.equal(report.evaluatedCandidates.length, 2);
  assert.equal(report.evaluatedCandidates[0].passed, false);
  assert.equal(report.evaluatedCandidates[0].perturbations.length, 1);
  assert.equal(report.evaluatedCandidates[0].unrunPerturbations.length, 5);
  assert.equal(report.winner.sourceRank, ordered[1].rank);
  assert.equal(report.winner.perturbations.length, 6);
  assert.ok(report.winner.perturbations.every((item) => item.metrics.eligible));
  assert.equal(report.isolation.holdoutOpened, false);
  assert.equal(report.championChanged, false);

  const { verifyBreakoutV4ResilienceReport } = await import("../src/research-cli.mjs");
  const selected = verifyBreakoutV4ResilienceReport(report);
  assert.equal(selected.parameterHash, report.winner.parameterHash);
  assert.equal(selected.replayOptions.executionDelayBars, 1);
  assert.throws(
    () => verifyBreakoutV4ResilienceReport({ ...report, resilienceSelectionHash: "tampered" }),
    /selectionHash/
  );
});

test("local-resilience selection returns no winner instead of promoting a least-bad candidate", async () => {
  const dataset = syntheticCatalog();
  const candidate = breakoutV4CandidateGrid(BREAKOUT_V4_EXACT_PAPER_DEVELOPMENT_SPEC)
    .find((item) => item.parameters.targetRiskMultiple === 4);
  const source = await runBreakoutV4ExactPaperDevelopmentSelection(dataset, {
    candidates: [candidate],
    replayRunner: async (cutoffDataset, options) => fakePaperReplay(options.parameters)
  });
  const report = await runBreakoutV4LocalResilienceSelection(dataset, source, {
    replayRunner: async (cutoffDataset, options) => fakePaperReplay({ ...options.parameters, targetRiskMultiple: 5 })
  });
  assert.equal(report.selectionStatus, "NO_LOCAL_RESILIENCE_WINNER");
  assert.equal(report.winner, null);
  assert.equal(report.search.evaluatedCandidateCount, 1);
  assert.equal(report.search.perturbationReplayCount, 1);
  assert.equal(report.strategyRoleAfterSelection, "NO_CANDIDATE");
});
