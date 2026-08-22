import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import {
  applyDueFunding,
  buildPaperCandidate,
  calculatePerformance,
  evaluatePaperEntry,
  evaluatePaperExit,
  fundingBoundaries,
  getDailyRiskState,
  shanghaiDayStartIso
} from "../src/paper-engine.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

test("candidate sizing respects 1% risk and requires net RR of at least 2", () => {
  const account = { cash_cny: 1_000 };
  const candidate = buildPaperCandidate(paperReport(), account);
  assert.ok(candidate);
  assert.ok(candidate.rr >= 2);
  assert.ok(candidate.riskCny <= 10);
  assert.ok(candidate.notionalCny <= 1_000);
  assert.equal(candidate.takeProfit, 111);

  const rejected = buildPaperCandidate(paperReport({
    plan: { stopLoss: 95, takeProfit: [108, 109], entryZone: [99, 101], riskReward: [1.6, 1.8] }
  }), account);
  assert.equal(rejected, null);
});

test("soft market warnings reduce position risk to 0.5% without weakening the 1% ceiling", () => {
  const account = { cash_cny: 1_000 };
  const reduced = buildPaperCandidate(paperReport({
    strategy: { riskPct: 0.005, setupType: "TREND_PULLBACK" }
  }), account);
  assert.ok(reduced);
  assert.equal(reduced.riskPct, 0.005);
  assert.ok(reduced.riskCny <= 5);

  const capped = buildPaperCandidate(paperReport({ strategy: { riskPct: 0.5 } }), account);
  assert.equal(capped.riskPct, 0.01);
  assert.ok(capped.riskCny <= 10);
});

test("WAIT, existing risk gates, and an existing position block entry", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const wait = evaluatePaperEntry(db, paperReport({ decision: "WAIT", candidateDecision: "WAIT" }));
    assert.equal(wait.allowed, false);
    const gated = evaluatePaperEntry(db, paperReport({ decision: "LONG", riskGates: ["过热"] }));
    assert.equal(gated.allowed, false);
    const snapshotId = db.insertSnapshot(paperReport());
    db.openPosition(directCandidate(), snapshotId);
    const occupied = evaluatePaperEntry(db, paperReport());
    assert.equal(occupied.allowed, false);
    assert.match(occupied.reasons.join(" "), /已有模拟仓位/);
  } finally {
    db.close();
  }
});

test("three consecutive losses pause new entries for the Shanghai day", () => {
  const db = new PaperDatabase(":memory:");
  try {
    for (let index = 0; index < 3; index += 1) {
      const openedAt = `2026-08-21T0${index + 1}:00:00.000Z`;
      const closedAt = `2026-08-21T0${index + 1}:05:00.000Z`;
      const snapshotId = db.insertSnapshot(paperReport({ generatedAt: openedAt }));
      const position = db.openPosition(directCandidate({ openedAt }), snapshotId);
      db.closePosition(position.id, {
        closedAt,
        exitPrice: 99,
        exitReason: "SL",
        grossPnlCny: -0.1,
        exitFeeCny: 0.01
      });
    }
    const state = getDailyRiskState(db, "2026-08-21T05:00:00.000Z");
    assert.equal(state.consecutiveLosses, 3);
    assert.equal(state.paused, true);
    assert.match(state.pauseReasons.join(" "), /连续亏损 3 笔/);
  } finally {
    db.close();
  }
});

test("daily realized loss of 3% pauses new entries", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport());
    const position = db.openPosition(directCandidate(), snapshotId);
    db.closePosition(position.id, {
      closedAt: "2026-08-21T02:00:00.000Z",
      exitPrice: 50,
      exitReason: "SL",
      grossPnlCny: -31,
      exitFeeCny: 0
    });
    const state = getDailyRiskState(db, "2026-08-21T03:00:00.000Z");
    assert.equal(state.paused, true);
    assert.match(state.pauseReasons.join(" "), /3%/);
  } finally {
    db.close();
  }
});

test("same-bar SL and TP collision closes conservatively at SL", () => {
  const position = {
    side: "LONG",
    entry_bar_ts: 1000,
    entry_price: 100,
    stop_loss: 95,
    take_profit: 111,
    quantity_btc: 0.01
  };
  const exit = evaluatePaperExit(position, paperReport({
    generatedAt: "2026-08-21T02:00:00.000Z",
    currentPrice: 105,
    latest15mBar: { timestamp: 2000, low: 94, high: 112 }
  }));
  assert.equal(exit.exitReason, "SL");
  assert.equal(exit.exitPrice, 95);
  assert.equal(exit.conservativeSameBar, true);
});

test("entry bar range is ignored because it contains pre-entry prices", () => {
  const position = {
    side: "LONG",
    entry_bar_ts: 2000,
    entry_price: 100,
    stop_loss: 95,
    take_profit: 111,
    quantity_btc: 0.01
  };
  const exit = evaluatePaperExit(position, paperReport({
    currentPrice: 100,
    latest15mBar: { timestamp: 2000, low: 90, high: 120 }
  }));
  assert.equal(exit, null);
});

test("SHORT exits at TP when price falls and receives positive funding", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const openedAt = "2026-08-21T00:01:00.000Z";
    const snapshotId = db.insertSnapshot(paperReport({ generatedAt: openedAt, decision: "SHORT", candidateDecision: "SHORT" }));
    const position = db.openPosition(directCandidate({
      side: "SHORT",
      openedAt,
      entry: 100,
      stopLoss: 105,
      takeProfit: 89,
      notionalCny: 100
    }), snapshotId);
    const funded = applyDueFunding(db, position, paperReport({
      generatedAt: "2026-08-21T08:01:00.000Z",
      derivatives: { fundingRatePct: 0.01 }
    }));
    assert.equal(funded.settlements[0].cashflowCny, 0.01);
    const exit = evaluatePaperExit(funded.position, paperReport({
      generatedAt: "2026-08-21T08:15:00.000Z",
      currentPrice: 88,
      latest15mBar: { timestamp: Number(position.entry_bar_ts) + 15 * 60 * 1000, low: 88, high: 101 }
    }));
    assert.equal(exit.exitReason, "TP");
    assert.equal(exit.exitPrice, 89);
    assert.ok(exit.grossPnlCny > 0);
  } finally {
    db.close();
  }
});

test("funding boundaries are UTC 00/08/16 and positive funding charges longs", () => {
  assert.deepEqual(
    fundingBoundaries("2026-08-20T23:00:00.000Z", "2026-08-21T16:01:00.000Z"),
    ["2026-08-21T00:00:00.000Z", "2026-08-21T08:00:00.000Z", "2026-08-21T16:00:00.000Z"]
  );
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T00:01:00.000Z" }));
    const opened = db.openPosition(directCandidate({ openedAt: "2026-08-21T00:01:00.000Z", notionalCny: 100 }), snapshotId);
    const funding = applyDueFunding(db, opened, paperReport({
      generatedAt: "2026-08-21T08:01:00.000Z",
      derivatives: { fundingRatePct: 0.01 }
    }));
    assert.equal(funding.settlements.length, 1);
    assert.equal(funding.settlements[0].cashflowCny, -0.01);
    assert.equal(funding.position.funding_cny, -0.01);
  } finally {
    db.close();
  }
});

test("performance includes fees, funding, PF, expectancy, drawdown and cumulative return", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const firstId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" }));
    const first = db.openPosition(directCandidate({ openedAt: "2026-08-21T01:00:00.000Z" }), firstId);
    db.applyFunding(first.id, -0.02, "2026-08-21T08:00:00.000Z", {});
    const win = db.closePosition(first.id, { closedAt: "2026-08-21T09:00:00.000Z", exitPrice: 111, exitReason: "TP", grossPnlCny: 10, exitFeeCny: 0.1 });

    const secondId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T10:00:00.000Z" }));
    const second = db.openPosition(directCandidate({ openedAt: "2026-08-21T10:00:00.000Z" }), secondId);
    const loss = db.closePosition(second.id, { closedAt: "2026-08-21T11:00:00.000Z", exitPrice: 95, exitReason: "SL", grossPnlCny: -5, exitFeeCny: 0.1 });

    const result = calculatePerformance(db);
    assert.equal(result.totalTrades, 2);
    assert.equal(result.winRatePct, 50);
    assert.equal(result.profitFactor, Number((win.net_pnl_cny / Math.abs(loss.net_pnl_cny)).toFixed(4)));
    assert.equal(result.expectancyCny, Number(((win.net_pnl_cny + loss.net_pnl_cny) / 2).toFixed(4)));
    assert.ok(result.maxDrawdownCny > 0);
    assert.equal(result.fundingCny, -0.02);
    assert.equal(result.feesCny, 0.4);
    assert.equal(result.cumulativePnlCny, 4.58);
  } finally {
    db.close();
  }
});

test("Shanghai day boundary is fixed at UTC+8", () => {
  assert.equal(shanghaiDayStartIso("2026-08-21T15:59:59.000Z"), "2026-08-20T16:00:00.000Z");
  assert.equal(shanghaiDayStartIso("2026-08-21T16:00:00.000Z"), "2026-08-21T16:00:00.000Z");
});

test("loss streak resets at the next Shanghai day", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T15:00:00.000Z" }));
    const position = db.openPosition(directCandidate({ openedAt: "2026-08-21T15:00:00.000Z" }), snapshotId);
    db.closePosition(position.id, {
      closedAt: "2026-08-21T15:30:00.000Z",
      exitPrice: 95,
      exitReason: "SL",
      grossPnlCny: -1,
      exitFeeCny: 0
    });
    const state = getDailyRiskState(db, "2026-08-21T16:01:00.000Z");
    assert.equal(state.consecutiveLosses, 0);
    assert.equal(state.dailyPnlCny, 0);
    assert.equal(state.paused, false);
  } finally {
    db.close();
  }
});
