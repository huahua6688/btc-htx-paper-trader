import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PaperDatabase } from "../src/db.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

test("range migration preserves legacy runtime values even below new defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-legacy-settings-"));
  const path = join(directory, "paper.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE runtime_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), risk_profile TEXT NOT NULL,
      risk_per_trade_pct REAL NOT NULL, max_margin_usage_pct REAL NOT NULL,
      user_max_leverage REAL NOT NULL, max_total_notional_multiple REAL NOT NULL,
      allow_pyramiding INTEGER NOT NULL, max_open_positions INTEGER NOT NULL,
      max_total_risk_pct REAL NOT NULL, max_daily_loss_pct REAL NOT NULL,
      max_consecutive_losses INTEGER NOT NULL, new_entries_paused INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
    );
    INSERT INTO runtime_settings VALUES
      (1, 'CONSERVATIVE', 0.001, 0.05, 2, 0.25, 0, 1, 0.005, 0.01, 2, 0, 7, '2026-01-01T00:00:00.000Z', 'LEGACY');
  `);
  legacy.close();
  const db = new PaperDatabase(path);
  try {
    const settings = db.getRuntimeSettings();
    assert.equal(settings.riskMode, "MANUAL");
    assert.equal(settings.riskManualPct, 0.001);
    assert.equal(settings.riskMinPct, 0.001);
    assert.equal(settings.totalRiskManualPct, 0.005);
    assert.equal(settings.dailyLossManualPct, 0.01);
    assert.equal(settings.lossStreakManual, 2);
    assert.equal(settings.revision, 7);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    assert.throws(() => db.openPosition(directCandidate(), snapshotId), /已有模拟仓位|already open/);
  } finally {
    db.close();
  }
});

test("SQLite keeps legacy setup rows readable so V1.2 can cancel them safely", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport();
    const snapshotId = db.insertSnapshot(report);
    const legacyProposal = {
      side: "LONG",
      type: "TREND_PULLBACK",
      createdAt: report.generatedAt,
      expiresAt: "2026-08-21T07:00:00.000Z",
      basisBarTs: report.completed15mBar.timestamp,
      entryZone: [99, 101],
      triggerPrice: 100,
      invalidationPrice: 95,
      stopLoss: 95,
      takeProfit: [111, 114],
      riskReward: [2.2, 2.8],
      riskPct: 0.005,
      riskTier: "REDUCED",
      reasons: ["旧版兼容测试"],
      warnings: [],
      armImmediately: false,
      triggeredNow: false
    };
    const setup = db.createSetup(legacyProposal, snapshotId);
    assert.equal(setup.status, "WATCHING");
    assert.equal(db.getActiveSetup().plan.triggerPrice, 100);
    assert.throws(() => db.createSetup(legacyProposal, snapshotId), /already active/);
    const armed = db.armSetup(setup.id, report.generatedAt, report.completed15mBar.timestamp);
    assert.equal(armed.status, "ARMED");
    const finished = db.finishSetup(setup.id, "TRIGGERED", report.generatedAt, "test");
    assert.equal(finished.status, "TRIGGERED");
    assert.equal(db.getActiveSetup(), null);
  } finally {
    db.close();
  }
});
