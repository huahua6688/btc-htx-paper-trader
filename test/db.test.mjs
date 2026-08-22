import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

test("SQLite initializes the paper account and persists a complete position lifecycle", () => {
  const db = new PaperDatabase(":memory:");
  try {
    assert.equal(db.getAccount().cash_cny, 1_000);
    const snapshotId = db.insertSnapshot(paperReport());
    const opened = db.openPosition(directCandidate(), snapshotId);
    assert.equal(opened.status, "OPEN");
    assert.equal(opened.entry_price, 100);
    assert.equal(opened.stop_loss, 95);
    assert.equal(opened.take_profit, 111);
    assert.equal(opened.openingReasons[0], "测试模拟理由");
    assert.equal(db.getAccount().cash_cny, 999.9);

    db.applyFunding(opened.id, -0.02, "2026-08-21T08:00:00.000Z", { rate: 0.001 });
    const closed = db.closePosition(opened.id, {
      closedAt: "2026-08-21T09:00:00.000Z",
      exitPrice: 111,
      exitReason: "TP",
      grossPnlCny: 0.792,
      exitFeeCny: 0.04
    });
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.funding_cny, -0.02);
    assert.equal(closed.net_pnl_cny, 0.632);
    assert.equal(db.getOpenPosition(), null);
    assert.equal(db.countSnapshots(), 1);
    assert.equal(db.getAccountEvents().length, 3);
  } finally {
    db.close();
  }
});

test("SQLite enforces one open paper position", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport());
    db.openPosition(directCandidate(), snapshotId);
    assert.throws(() => db.openPosition(directCandidate(), snapshotId), /already open/);
  } finally {
    db.close();
  }
});

test("SQLite persists one active V1.1 setup and its terminal lifecycle", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport();
    const snapshotId = db.insertSnapshot(report);
    const setup = db.createSetup({
      ...report.strategy.setupProposal,
      armImmediately: false,
      triggeredNow: false
    }, snapshotId);
    assert.equal(setup.status, "WATCHING");
    assert.equal(db.getActiveSetup().plan.triggerPrice, 100);
    assert.throws(() => db.createSetup(report.strategy.setupProposal, snapshotId), /already active/);
    const armed = db.armSetup(setup.id, report.generatedAt, report.completed15mBar.timestamp);
    assert.equal(armed.status, "ARMED");
    const finished = db.finishSetup(setup.id, "TRIGGERED", report.generatedAt, "test");
    assert.equal(finished.status, "TRIGGERED");
    assert.equal(db.getActiveSetup(), null);
  } finally {
    db.close();
  }
});
