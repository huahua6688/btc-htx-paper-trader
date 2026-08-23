import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEntryGeometry, trimMarketToClosedCandles } from "../src/anti-chase-challenger.mjs";

function rows({ count = 80, intervalMs, start = 1_700_000_000_000, first = 100, step = 0.05, lastVolume = 100 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const open = first + index * step;
    const close = open + step * 0.8;
    return {
      id: (start + index * intervalMs) / 1000,
      open, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, close,
      amount: index === count - 1 ? lastVolume : 50
    };
  });
}

function report(currentPrice, overrides = {}) {
  return {
    decision: "LONG",
    candidateDecision: "LONG",
    currentPrice,
    plan: { stopLoss: currentPrice - 4 },
    derivatives: { fundingRatePct: 0.01 },
    timeframes: {
      "15m": { atr14: 2, ema20: currentPrice - 1 },
      "1h": { atr14: 10, ema20: 100 }
    },
    ...overrides
  };
}

test("Anti-Chase removes every still-open candle before analysis", () => {
  const interval = 15 * 60_000;
  const closed = rows({ intervalMs: interval });
  const visibleAt = closed.at(-1).id * 1000 + interval;
  const syntheticOpen = { ...closed.at(-1), id: visibleAt / 1000, open: 999, high: 999, low: 999, close: 999 };
  const market = {
    ticker: { ts: visibleAt, tick: { close: closed.at(-1).close } },
    kline15m: { data: [...closed, syntheticOpen] },
    kline1h: { data: rows({ intervalMs: 60 * 60_000 }) },
    kline4h: { data: rows({ intervalMs: 4 * 60 * 60_000 }) },
    kline1d: { data: rows({ intervalMs: 24 * 60 * 60_000 }) }
  };
  const trimmed = trimMarketToClosedCandles(market);
  assert.equal(trimmed.kline15m.data.some((item) => item.open === 999), false);
  assert.ok(trimmed.kline15m.data.every((item) => item.id * 1000 + interval <= visibleAt));
});

test("Anti-Chase blocks an extended momentum LONG instead of buying after the move", () => {
  const interval = 15 * 60_000;
  const kline15m = rows({ intervalMs: interval, step: 0.12 });
  for (let offset = 5; offset >= 1; offset -= 1) {
    const candle = kline15m.at(-offset);
    candle.open = 114 + (5 - offset) * 3;
    candle.close = candle.open + 2;
    candle.high = candle.close + 0.4;
    candle.low = candle.open - 0.4;
  }
  kline15m.at(-1).close = 130;
  kline15m.at(-1).high = 130.4;
  const kline1h = rows({ intervalMs: 60 * 60_000, step: 0.04 });
  const market = { kline15m: { data: kline15m }, kline1h: { data: kline1h } };
  const geometry = evaluateEntryGeometry(report(130), market);
  assert.equal(geometry.blocked, true);
  assert.equal(geometry.entryType, "WAIT_NOT_CHASE");
  assert.ok(geometry.reasons.some((item) => item.includes("禁止追价") || item.includes("等待消化")));
});

test("Anti-Chase permits a fresh controlled retest near the breakout instead of requiring a fixed entry price", () => {
  const interval = 15 * 60_000;
  const kline15m = rows({ intervalMs: interval, first: 100, step: 0.05, lastVolume: 120 });
  const priorHigh = Math.max(...kline15m.slice(-21, -1).map((item) => item.high));
  const last = kline15m.at(-1);
  last.open = priorHigh - 0.1;
  last.close = priorHigh + 0.2;
  last.high = priorHigh + 0.3;
  last.low = priorHigh - 0.2;
  const currentPrice = priorHigh + 0.05;
  const kline1h = rows({ intervalMs: 60 * 60_000, first: 90, step: 0.02 });
  const market = { kline15m: { data: kline15m }, kline1h: { data: kline1h } };
  const geometry = evaluateEntryGeometry(report(currentPrice, {
    plan: { stopLoss: currentPrice - 2 },
    timeframes: { "15m": { atr14: 2, ema20: currentPrice - 0.5 }, "1h": { atr14: 8, ema20: currentPrice - 1 } }
  }), market);
  assert.equal(geometry.validRetest, true);
  assert.equal(geometry.blocked, false);
  assert.equal(geometry.entryType, "FRESH_BREAKOUT_WITH_ROOM");
});

test("Anti-Chase does not let one ordinary extension input veto an otherwise balanced entry", () => {
  const market = {
    kline15m: { data: rows({ intervalMs: 15 * 60_000, first: 100, step: 0.05 }) },
    kline1h: { data: rows({ intervalMs: 60 * 60_000, first: 90, step: 0.5 }) }
  };
  const geometry = evaluateEntryGeometry(report(114, {
    plan: { stopLoss: 110 },
    timeframes: { "15m": { atr14: 2, ema20: 103 }, "1h": { atr14: 10, ema20: 100 } }
  }), market);
  assert.equal(geometry.extensionStretched, true);
  assert.equal(geometry.impulseStretched, false);
  assert.equal(geometry.blocked, false);
});
