import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFundingCarry,
  normalizeFundingSeries,
  shortLegLiquidationThresholds
} from "../src/funding-carry.mjs";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const START = Date.UTC(2024, 8, 1, 0, 0, 0);

function series(rates) {
  return rates.map((rate, index) => ({ timestamp: START + index * EIGHT_HOURS, fundingRate: rate }));
}

test("累计资金费与年化按已知输入算得出正确结果", () => {
  // 一整年的结算，每次 0.01%。1095 次 x 0.01% = 10.95% 毛收益。
  const rates = Array.from({ length: 1095 }, () => 0.0001);
  const report = analyzeFundingCarry(series(rates), {
    perpFeeRatePerSide: 0, spotFeeRatePerSide: 0, slippageRatePerSide: 0
  });
  assert.equal(report.fundingPct.cumulative, 10.95);
  assert.equal(report.coverage.settlements, 1095);
  // 区间是 1094 个间隔 = 364.67 天，年化略高于累计值。
  assert.ok(report.netPct.annualized > 10.95 && report.netPct.annualized < 11.1);
  assert.equal(report.netPct.positive, true);
});

test("一个来回的成本是 4 次成交，而不是 2 次", () => {
  const report = analyzeFundingCarry(series([0.0001, 0.0001]), {
    perpFeeRatePerSide: 0.0005, spotFeeRatePerSide: 0.0005, slippageRatePerSide: 0.0002
  });
  // 2 x (0.05% + 0.02%) 永续 + 2 x (0.05% + 0.02%) 现货 = 0.28%
  assert.equal(report.costPct.roundTrip, 0.28);
  // 毛 0.02%，成本 0.28% => 净为负。短持有期一定被成本吃掉。
  assert.equal(report.netPct.positive, false);
  assert.equal(report.netPct.total, round4(0.02 - 0.28));
});

test("负费率与最长连负段被如实记录", () => {
  // 正 正 负 负 负 正
  const report = analyzeFundingCarry(series([0.0002, 0.0002, -0.0003, -0.0003, -0.0003, 0.0002]), {
    perpFeeRatePerSide: 0, spotFeeRatePerSide: 0, slippageRatePerSide: 0
  });
  assert.equal(report.risk.negativeSettlements, 3);
  assert.equal(report.risk.longestNegativeStreak, 3);
  assert.equal(report.risk.longestNegativeStreakHours, 24);
  // 累计从 +0.04% 回撤到 -0.05%，最大回撤 -0.09%。
  assert.equal(report.risk.worstCumulativeDrawdownPct, -0.09);
});

test("缺失的结算被点名，而不是插值补齐", () => {
  // 5 条记录、每条间隔 2 天 => 区间 8 天，应有 24 次结算，实得 5 次，缺 19 次。
  const sparse = Array.from({ length: 5 }, (_, index) => ({
    timestamp: START + index * 2 * 24 * 60 * 60 * 1000,
    fundingRate: 0.0001
  }));
  const report = analyzeFundingCarry(sparse, {
    perpFeeRatePerSide: 0, spotFeeRatePerSide: 0, slippageRatePerSide: 0
  });
  assert.equal(report.coverage.settlements, 5);
  assert.equal(report.coverage.days, 8);
  assert.equal(report.coverage.expectedSettlements, 24);
  assert.equal(report.coverage.missingSettlements, 19);
  // 缺失时累计值被低估，报告必须说明，不能让读者以为那就是真实收益。
  assert.ok(report.limitations.some((item) => item.includes("missingSettlements")));
});

test("重复时间戳去重，残缺记录直接丢弃而不是当成 0", () => {
  const rows = [
    { timestamp: START, fundingRate: 0.0001 },
    { timestamp: START, fundingRate: 0.0001 },
    { timestamp: START + EIGHT_HOURS, fundingRate: null },
    { timestamp: null, fundingRate: 0.0001 },
    { timestamp: START + 2 * EIGHT_HOURS, fundingRate: 0.0002 }
  ];
  const normalized = normalizeFundingSeries(rows);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((item) => item.rate), [0.0001, 0.0002]);
});

test("空头腿强平阈值随杠杆收敛，且必须单列而不是混进收益", () => {
  const thresholds = shortLegLiquidationThresholds({ maintenanceMarginRate: 0.005 });
  const byLeverage = Object.fromEntries(thresholds.map((item) => [item.shortLegLeverage, item.priceRisePctToLiquidate]));
  // 1 倍杠杆要涨约 99.5% 才强平；10 倍只要约 9.5%。
  assert.equal(byLeverage[1], 99.5);
  assert.equal(byLeverage[10], 9.5);
  // 杠杆越高阈值越低，必须单调。
  const values = thresholds.map((item) => item.priceRisePctToLiquidate);
  for (let index = 1; index < values.length; index += 1) assert.ok(values[index] < values[index - 1]);
});

test("记录不足时报错，不返回一个看起来能用的空结果", () => {
  assert.throws(() => analyzeFundingCarry([]), /记录不足/);
  assert.throws(() => analyzeFundingCarry(series([0.0001])), /记录不足/);
});

function round4(value) { return Number(value.toFixed(4)); }
