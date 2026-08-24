import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBreakoutChallenger } from "../src/breakout-challenger.mjs";
import { PaperDatabase } from "../src/db.mjs";
import { manageOpenPosition } from "../src/position-manager.mjs";
import { buildPointInTimeMarket } from "../src/replay-market.mjs";
import { REPLAY_STRATEGIES, runHistoricalReplay } from "../src/replay-engine.mjs";
import { runMonitorCycle } from "../src/monitor-cycle.mjs";
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

test("Breakout V4 binds LONG and SHORT signals to the latest completed 4h signal bar", () => {
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

  for (const offsetMs of [37_000, 3 * 60_000]) {
    const liveStyle = analyzeBreakoutChallenger(breakoutMarket("LONG", { offsetMs }));
    assert.equal(liveStyle.decision, "LONG");
    assert.equal(liveStyle.breakout.signalBarAvailable, true);
    assert.equal(liveStyle.breakout.isExactWallClockBoundary, false);
    assert.equal(liveStyle.entryAssessment.signalKey, long.entryAssessment.signalKey);
    assert.equal(liveStyle.entryAssessment.signalBarTimestamp, long.entryAssessment.signalBarTimestamp);
  }
});

test("Replay-boundary and live Shadow timestamps have decision and signal identity parity", () => {
  const replay = analyzeBreakoutChallenger(breakoutMarket("SHORT"));
  const shadow = analyzeBreakoutChallenger(breakoutMarket("SHORT", { offsetMs: 3 * 60_000 }));
  assert.deepEqual(
    { decision: shadow.decision, signalKey: shadow.entryAssessment.signalKey, signalBarTimestamp: shadow.entryAssessment.signalBarTimestamp },
    { decision: replay.decision, signalKey: replay.entryAssessment.signalKey, signalBarTimestamp: replay.entryAssessment.signalBarTimestamp }
  );
});

test("real Replay orchestration and live Shadow monitor keep decision parity after a delayed 4h close observation", async () => {
  const barMs = 15 * 60_000;
  const start = Date.UTC(2025, 8, 1);
  const candles = [];
  let prior = 100;
  for (let index = 0; index < 86 * 96; index += 1) {
    const timestamp = start + index * barMs;
    const close = 100 + index * 0.01;
    candles.push({ timestamp, open: prior, high: close + 0.04, low: prior - 0.04, close, volumeBtc: 1, volumeContracts: 1, turnoverUsdt: close, trades: 1 });
    prior = close;
  }
  const boundaryIndex = candles.findLastIndex((item, index) => index < candles.length - 1 && (item.timestamp + barMs) % FOUR_HOURS_MS === 0);
  const boundaryCandle = candles[boundaryIndex];
  const dataset = {
    manifest: {
      manifestHash: "breakout-shadow-parity-test",
      datasetId: "breakout-shadow-parity-test",
      requestedCoverage: { from: new Date(start).toISOString(), to: new Date(candles.at(-1).timestamp).toISOString() },
      actualCoverage: { from: new Date(start).toISOString(), to: new Date(candles.at(-1).timestamp).toISOString() }
    },
    candles,
    funding: [],
    series: {}
  };
  const replay = await runHistoricalReplay(dataset, {
    strategy: "breakout-v4",
    from: new Date(boundaryCandle.timestamp).toISOString(),
    to: new Date(boundaryCandle.timestamp + barMs).toISOString(),
    forceCloseAtEnd: true
  });
  const replayDecision = replay.trace.find((item) => item.eventTimestamp === boundaryCandle.timestamp);
  assert.ok(replayDecision?.signalKey, "synthetic 4h boundary must produce a real Replay signal");

  const shadowMarket = buildPointInTimeMarket(candles, [], boundaryIndex, { historicalSeries: {} });
  shadowMarket.ticker.ts += 3 * 60_000;
  const db = new PaperDatabase(":memory:");
  try {
    const shadow = await runMonitorCycle(db, {
      collect: async () => shadowMarket,
      analyze: (market) => analyzeBreakoutChallenger(market),
      now: () => new Date(shadowMarket.ticker.ts).toISOString()
    });
    assert.deepEqual(
      { decision: shadow.report.decision, signalKey: shadow.report.entryAssessment.signalKey, signalBarTimestamp: shadow.report.entryAssessment.signalBarTimestamp },
      { decision: replayDecision.decision, signalKey: replayDecision.signalKey, signalBarTimestamp: replayDecision.signalBarTimestamp }
    );
    assert.equal(shadow.report.breakout.isExactWallClockBoundary, false);
  } finally {
    db.close();
  }
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
