import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBreakoutChallenger } from "../src/breakout-challenger.mjs";
import { manageOpenPosition } from "../src/position-manager.mjs";
import { REPLAY_STRATEGIES } from "../src/replay-engine.mjs";
import { paperReport } from "./helpers.mjs";

const HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * HOUR_MS;

function frame({ interval, now, count, side }) {
  return Array.from({ length: count }, (_, index) => {
    const rising = side === "LONG";
    const base = rising ? 100 + index * 0.2 : 120 - index * 0.2;
    const isLast = index === count - 1;
    const close = isLast ? base + (rising ? 3 : -3) : base + (rising ? 0.1 : -0.1);
    return {
      id: (now - (count - index) * interval) / 1000,
      open: base,
      high: Math.max(base, close) + 0.3,
      low: Math.min(base, close) - 0.3,
      close,
      amount: 100,
      vol: 10_000
    };
  });
}

function breakoutMarket(side, { offsetMs = 0 } = {}) {
  const boundary = Date.UTC(2026, 0, 2, 0, 0, 0);
  const now = boundary + offsetMs;
  const h4 = frame({ interval: FOUR_HOURS_MS, now: boundary, count: 70, side });
  const h1 = frame({ interval: HOUR_MS, now: boundary, count: 100, side });
  const currentPrice = h4.at(-1).close;
  return {
    ticker: { ts: now, tick: { close: currentPrice } },
    kline15m: { data: [] },
    kline1h: { data: h1 },
    kline4h: { data: h4 },
    kline1d: { data: [] },
    fundingCurrent: { data: { funding_rate: "0", source: "TEST_POINT_IN_TIME" } }
  };
}

test("Breakout V4 emits symmetric LONG and SHORT signals only on a completed 4h boundary", () => {
  const long = analyzeBreakoutChallenger(breakoutMarket("LONG"));
  const short = analyzeBreakoutChallenger(breakoutMarket("SHORT"));
  assert.equal(long.decision, "LONG");
  assert.equal(short.decision, "SHORT");
  assert.equal(long.breakout.isDecisionBoundary, true);
  assert.equal(short.breakout.isDecisionBoundary, true);
  assert.equal(long.plan.riskReward[0], 4);
  assert.equal(short.plan.riskReward[0], 4);
  assert.equal(long.strategy.positionManagementProfile, "HARD_BRACKET_HOLD_V1");
  assert.ok(long.plan.stopLoss < long.currentPrice);
  assert.ok(short.plan.stopLoss > short.currentPrice);

  const betweenBoundaries = analyzeBreakoutChallenger(breakoutMarket("LONG", { offsetMs: 15 * 60_000 }));
  assert.equal(betweenBoundaries.decision, "WAIT");
  assert.equal(betweenBoundaries.breakout.isDecisionBoundary, false);
});

test("HARD_BRACKET_HOLD_V1 never recreates break-even, trailing, target extension, or signal exits", () => {
  const generatedAt = "2026-08-21T04:00:00.000Z";
  const completedBarTs = new Date(generatedAt).getTime() - 15 * 60_000;
  const position = {
    side: "LONG", entry_price: 100, initial_stop_loss: 95, stop_loss: 95, take_profit: 120,
    entry_bar_ts: completedBarTs - 64 * 15 * 60_000, last_management_bar_ts: completedBarTs - 15 * 60_000,
    opposite_signal_count: 0, management: { events: [] }
  };
  const report = paperReport({
    generatedAt,
    currentPrice: 112,
    decision: "SHORT",
    candidateDecision: "SHORT",
    opportunities: { LONG: { score: 5 }, SHORT: { score: 95 } },
    latest15mBar: { timestamp: completedBarTs, open: 111, high: 113, low: 110, close: 112 },
    completed15mBar: { timestamp: completedBarTs, open: 111, high: 113, low: 110, close: 112 },
    strategy: { positionManagementProfile: "HARD_BRACKET_HOLD_V1" }
  });
  const result = manageOpenPosition(position, report);
  assert.equal(result.action, "HOLD");
  assert.equal(result.stopLoss, 95);
  assert.equal(result.takeProfit, 120);
  assert.equal(result.oppositeSignalCount, 0);
});

test("Breakout V4 is an explicit replay strategy rather than an implicit fallback", () => {
  assert.ok(REPLAY_STRATEGIES.includes("breakout-v4"));
});
