import test from "node:test";
import assert from "node:assert/strict";
import { manageOpenPosition } from "../src/position-manager.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

function position(overrides = {}) {
  const candidate = directCandidate();
  return {
    id: 1,
    side: candidate.side,
    entry_price: candidate.entry,
    signal_entry_price: candidate.signalEntryPrice,
    initial_stop_loss: candidate.stopLoss,
    stop_loss: candidate.stopLoss,
    take_profit: candidate.takeProfit,
    entry_bar_ts: candidate.entryBarTs,
    last_management_bar_ts: candidate.entryBarTs,
    opposite_signal_count: 0,
    management: { events: [] },
    ...overrides
  };
}

test("position management ignores 5-minute noise until a new completed 15m bar exists", () => {
  const current = position();
  const report = paperReport({
    currentPrice: 103,
    completed15mBar: { timestamp: current.last_management_bar_ts, open: 100, high: 104, low: 99, close: 103 },
    latest15mBar: { timestamp: current.last_management_bar_ts, open: 100, high: 104, low: 99, close: 103 }
  });
  const result = manageOpenPosition(current, report);
  assert.equal(result.action, "HOLD");
  assert.match(result.reason, /完整15分钟K线/);
});

test("profit moves risk toward break-even and strong trend can trail without extending forever", () => {
  const current = position();
  const report = paperReport({
    generatedAt: "2026-08-21T01:15:00.000Z",
    currentPrice: 108,
    completed15mBar: { timestamp: current.last_management_bar_ts + 900_000, open: 105, high: 109, low: 106, close: 108 },
    latest15mBar: { timestamp: current.last_management_bar_ts + 900_000, open: 105, high: 109, low: 106, close: 108 },
    opportunities: {
      LONG: { score: 82 },
      SHORT: { score: 24 }
    },
    timeframes: { "15m": { atr14: 2 } }
  });
  const result = manageOpenPosition(current, report);
  assert.equal(result.action, "UPDATE");
  assert.ok(result.stopLoss > current.entry_price, "止损应覆盖基础成本并锁定风险");
  assert.ok(result.takeProfit > current.take_profit, "高质量延续可适度延长止盈");
  assert.match(result.reason, /保本|趋势|止盈/);
});

test("opposite direction needs two completed bars before exiting and does not mechanically reverse", () => {
  const firstPosition = position();
  const opportunities = { LONG: { score: 30 }, SHORT: { score: 82 } };
  const first = manageOpenPosition(firstPosition, paperReport({
    generatedAt: "2026-08-21T01:15:00.000Z",
    currentPrice: 99,
    decision: "SHORT",
    candidateDecision: "SHORT",
    opportunities,
    completed15mBar: { timestamp: firstPosition.last_management_bar_ts + 900_000, open: 101, high: 102, low: 98, close: 99 },
    latest15mBar: { timestamp: firstPosition.last_management_bar_ts + 900_000, open: 101, high: 102, low: 98, close: 99 }
  }));
  assert.equal(first.action, "UPDATE");
  assert.equal(first.oppositeSignalCount, 1);
  assert.match(first.reason, /先观察/);

  const secondPosition = position({
    opposite_signal_count: first.oppositeSignalCount,
    last_management_bar_ts: first.lastManagementBarTs
  });
  const second = manageOpenPosition(secondPosition, paperReport({
    generatedAt: "2026-08-21T01:30:00.000Z",
    currentPrice: 98,
    decision: "SHORT",
    candidateDecision: "SHORT",
    opportunities,
    completed15mBar: { timestamp: first.lastManagementBarTs + 900_000, open: 99, high: 100, low: 97, close: 98 },
    latest15mBar: { timestamp: first.lastManagementBarTs + 900_000, open: 99, high: 100, low: 97, close: 98 }
  }));
  assert.equal(second.action, "EXIT");
  assert.equal(second.exitReason, "SIGNAL_INVALIDATED");
});
