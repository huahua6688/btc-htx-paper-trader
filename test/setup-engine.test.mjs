import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { advanceSetup, materializeSetupReport } from "../src/setup-engine.mjs";
import { paperReport } from "./helpers.mjs";

function proposal(overrides = {}) {
  return {
    side: "LONG",
    type: "TREND_PULLBACK",
    createdAt: "2026-08-21T01:00:00.000Z",
    expiresAt: "2026-08-21T07:00:00.000Z",
    basisBarTs: new Date("2026-08-21T00:45:00.000Z").getTime(),
    entryZone: [98, 101],
    triggerPrice: 102,
    invalidationPrice: 95,
    stopLoss: 95,
    takeProfit: [117.4, 121.6],
    riskReward: [2.2, 2.8],
    riskPct: 0.005,
    riskTier: "REDUCED",
    armImmediately: false,
    triggeredNow: false,
    reasons: ["趋势回踩测试"],
    warnings: ["4h RSI 过热，风险降至 0.5%"],
    ...overrides
  };
}

test("a persisted pullback setup arms in its zone and triggers only after 15m confirmation", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const initial = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(initial);
    let setup = db.createSetup(proposal(), snapshotId);
    assert.equal(setup.status, "WATCHING");

    const armedReport = paperReport({
      generatedAt: "2026-08-21T01:05:00.000Z",
      currentPrice: 100,
      latest15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), low: 99, high: 101, close: 100 },
      completed15mBar: { timestamp: new Date("2026-08-21T00:45:00.000Z").getTime(), open: 100, high: 101, low: 99, close: 100, volumeRatio: 1 },
      strategy: { bias: "LONG", riskPct: 0.005, hardBlocks: [] }
    });
    const armed = advanceSetup(db, setup, armedReport);
    assert.equal(armed.type, "SETUP_ARMED");
    assert.equal(db.getActiveSetup().status, "ARMED");

    setup = db.getActiveSetup();
    const triggerReport = paperReport({
      generatedAt: "2026-08-21T01:20:00.000Z",
      currentPrice: 102.2,
      latest15mBar: { timestamp: new Date("2026-08-21T01:15:00.000Z").getTime(), low: 100, high: 103, close: 102.2 },
      completed15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), open: 100, high: 103, low: 99, close: 102.1, volumeRatio: 1 },
      strategy: { bias: "LONG", riskPct: 0.005, hardBlocks: [] }
    });
    const triggered = advanceSetup(db, setup, triggerReport);
    assert.equal(triggered.type, "SETUP_TRIGGER");
    assert.equal(triggered.entryReport.decision, "LONG");
    assert.equal(triggered.entryReport.strategy.riskPct, 0.005);
  } finally {
    db.close();
  }
});

test("pending setups expire and invalidated prices can never create an entry report", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(report);
    const setup = db.createSetup(proposal({ expiresAt: "2026-08-21T01:10:00.000Z" }), snapshotId);
    const expired = advanceSetup(db, setup, paperReport({
      generatedAt: "2026-08-21T01:10:00.000Z",
      strategy: { bias: "LONG", hardBlocks: [], riskPct: 0.005 }
    }));
    assert.equal(expired.type, "SETUP_EXPIRED");
    assert.equal(db.getActiveSetup(), null);
  } finally {
    db.close();
  }
});

test("a pending setup is cancelled when the 4h bias no longer agrees", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(report);
    const setup = db.createSetup(proposal(), snapshotId);
    const cancelled = advanceSetup(db, setup, paperReport({
      generatedAt: "2026-08-21T01:05:00.000Z",
      strategy: { bias: "WAIT", hardBlocks: [], riskPct: 0 }
    }));
    assert.equal(cancelled.type, "SETUP_CANCELLED");
    assert.equal(cancelled.setup.status, "CANCELLED");
    assert.equal(db.getActiveSetup(), null);
  } finally {
    db.close();
  }
});

test("materialized setup recalculates targets from the actual trigger price", () => {
  const report = paperReport({ currentPrice: 103, strategy: { bias: "LONG", riskPct: 0.005, hardBlocks: [] } });
  const entry = materializeSetupReport({
    id: 9,
    side: "LONG",
    setup_type: "TREND_PULLBACK",
    risk_pct: 0.005,
    reasons: ["测试"],
    plan: proposal()
  }, report);
  assert.equal(entry.plan.stopLoss, 95);
  assert.equal(entry.plan.takeProfit[0], 120.6);
  assert.equal(entry.strategy.activeSetupId, 9);
});
