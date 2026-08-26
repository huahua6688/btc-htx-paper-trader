import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BREAKOUT_V4_DEVELOPMENT_SPEC,
  BREAKOUT_V4_LONG_HISTORY_DEVELOPMENT_SPEC,
  breakoutV4CandidateGrid,
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
  return { manifest: { manifestHash: "synthetic-development-catalog" }, candles };
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
