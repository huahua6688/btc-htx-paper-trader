import test from "node:test";
import assert from "node:assert/strict";
import { adx, ema, percentChange, percentileRank, rsi } from "../src/indicators.mjs";

test("percentChange handles a normal move", () => {
  assert.equal(percentChange(110, 100), 10);
});

test("EMA follows a rising series", () => {
  const series = ema([1, 2, 3, 4, 5], 3);
  assert.equal(series.length, 5);
  assert.ok(series.at(-1) > series[0]);
});

test("RSI is high for a persistent uptrend", () => {
  const values = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.equal(rsi(values, 14), 100);
});

test("percentile rank is bounded", () => {
  assert.equal(percentileRank([1, 2, 3, 4], 3), 75);
});

test("ADX detects a persistent directional trend", () => {
  const candles = Array.from({ length: 80 }, (_, index) => ({
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101.5 + index
  }));
  assert.ok(adx(candles, 14) > 50);
});
