import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PaperDatabase, positionGroupBackupPath } from "../src/db.mjs";
import { runMonitorCycle } from "../src/monitor-cycle.mjs";
import { calculateAccountState } from "../src/paper-engine.mjs";
import { formatStatus } from "../src/paper-format.mjs";
import { TelegramControlPanel } from "../src/telegram-control.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

function sideReport(side, { generatedAt = "2026-08-21T01:00:00.000Z", price = 100, barOffset = 0 } = {}) {
  const isLong = side === "LONG";
  const base = paperReport({ generatedAt });
  return paperReport({
    generatedAt,
    currentPrice: price,
    decision: side,
    candidateDecision: side,
    plan: {
      entryPrice: price,
      stopLoss: isLong ? price * 0.95 : price * 1.05,
      takeProfit: isLong ? [price * 1.11, price * 1.14] : [price * 0.89, price * 0.86],
      riskReward: [2.2, 2.8]
    },
    latest15mBar: { ...base.latest15mBar, timestamp: base.latest15mBar.timestamp + barOffset, close: price, high: price + 1, low: price - 1 },
    completed15mBar: { ...base.completed15mBar, timestamp: base.completed15mBar.timestamp + barOffset, close: price, high: price + 1, low: price - 1 },
    opportunities: {
      LONG: { ...base.opportunities.LONG, score: isLong ? 79 : 25 },
      SHORT: { ...base.opportunities.SHORT, score: isLong ? 25 : 82 }
    },
    strategy: { ...base.strategy, bias: side, state: "ENTER_NOW", riskPct: 0.01 },
    bullishReasons: isLong ? ["测试多头机会"] : ["多头条件弱"],
    bearishReasons: isLong ? ["空头条件弱"] : ["测试空头机会"]
  });
}

function candidate(side, {
  openedAt = "2026-08-21T01:00:00.000Z",
  entryBarTs = new Date(openedAt).getTime() - 900_000,
  entry = 100,
  stopLoss = side === "LONG" ? 95 : 105,
  takeProfit = side === "LONG" ? 111 : 89,
  riskCny = 1,
  marginCny = 3.6,
  notionalCny = 7.2,
  ...overrides
} = {}) {
  return directCandidate({
    side,
    openedAt,
    entryBarTs,
    signalEntryPrice: entry,
    entry,
    stopLoss,
    takeProfit,
    riskCny,
    expectedLossCny: riskCny,
    expectedProfitCny: riskCny * 2.1,
    riskPct: riskCny / 1_000,
    marginCny,
    notionalCny,
    leverage: notionalCny / marginCny,
    liquidationPriceEstimate: side === "LONG" ? entry * 0.5 : entry * 1.5,
    portfolioAfter: {
      positionCount: 1,
      totalRiskCny: riskCny,
      totalRiskPct: riskCny / 1_000,
      totalMarginCny: marginCny,
      totalNotionalCny: notionalCny,
      overallStopLoss: stopLoss,
      overallTakeProfit: takeProfit,
      liquidationPriceEstimate: side === "LONG" ? entry * 0.5 : entry * 1.5,
      liquidationDistancePct: 0.5,
      liquidationSource: "PAPER_TEST_ESTIMATE"
    },
    ...overrides
  });
}

function insertAndOpen(db, side, options = {}) {
  const report = sideReport(side, { generatedAt: options.openedAt, barOffset: options.barOffset ?? 0 });
  const snapshotId = db.insertSnapshot(report);
  return db.openPosition(candidate(side, options), snapshotId);
}

function closeLeg(db, position, at = "2026-08-21T02:00:00.000Z") {
  return db.closePosition(position.id, {
    closedAt: at,
    exitPrice: position.entry_price,
    exitTriggerPrice: position.entry_price,
    exitReason: "TEST_CLOSE",
    grossPnlCny: 0,
    exitFeeCny: 0,
    exitSlippageCny: 0
  });
}

test("HEDGE opens qualified LONG beside existing SHORT through the real monitor entry path", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    const short = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z" });
    const report = sideReport("LONG", { generatedAt: "2026-08-21T01:00:00.000Z" });
    const result = await runMonitorCycle(db, {
      collect: async () => report,
      analyze: (value) => value,
      now: () => report.generatedAt
    });
    const open = db.getOpenPositions();
    assert.equal(open.length, 2);
    assert.deepEqual(new Set(open.map((item) => item.side)), new Set(["LONG", "SHORT"]));
    assert.notEqual(open.find((item) => item.side === "LONG").position_group_id, short.position_group_id);
    assert.ok(result.actions.some((item) => item.type === "OPEN" && item.position.side === "LONG"));
  } finally { db.close(); }
});

test("HEDGE opens qualified SHORT beside existing LONG through the real monitor entry path", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:30:00.000Z" });
    const report = sideReport("SHORT", { generatedAt: "2026-08-21T01:00:00.000Z" });
    const result = await runMonitorCycle(db, { collect: async () => report, analyze: (value) => value, now: () => report.generatedAt });
    assert.deepEqual(new Set(db.getOpenPositions().map((item) => item.side)), new Set(["LONG", "SHORT"]));
    assert.ok(result.actions.some((item) => item.type === "OPEN" && item.position.side === "SHORT"));
  } finally { db.close(); }
});

test("same-side controlled add-ons share their side group while LONG and SHORT never share a group", () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", allowPyramiding: true, maxOpenPositions: 4 }, { source: "TEST" });
    const long1 = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z" });
    const short1 = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z" });
    const long2 = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:45:00.000Z", entryBarTs: long1.entry_bar_ts + 900_000 });
    const short2 = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T01:00:00.000Z", entryBarTs: short1.entry_bar_ts + 900_000 });
    assert.equal(long1.position_group_id, long2.position_group_id);
    assert.equal(short1.position_group_id, short2.position_group_id);
    assert.notEqual(long1.position_group_id, short1.position_group_id);
    assert.equal(db.getOpenPositionGroups().length, 2);
  } finally { db.close(); }
});

test("closing or updating one side group leaves the opposite side group unchanged", () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    const long = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z" });
    const short = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z" });
    const shortBefore = db.getPosition(short.id);
    db.updatePositionGroupManagement(long.position_group_id, { stopLoss: 96, event: { type: "TEST_LONG_UPDATE" } });
    assert.equal(db.getPosition(long.id).stop_loss, 96);
    assert.deepEqual(db.getPosition(short.id), shortBefore);
    closeLeg(db, long);
    assert.equal(db.getPositionGroup(long.position_group_id).status, "CLOSED");
    assert.equal(db.getPosition(short.id).status, "OPEN");
    assert.equal(db.getPositionGroup(short.position_group_id).status, "OPEN");
  } finally { db.close(); }
});

test("closing SHORT leaves LONG open and its Position Group unchanged", () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    const long = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z" });
    const short = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z" });
    closeLeg(db, short);
    assert.equal(db.getPosition(short.id).status, "CLOSED");
    assert.equal(db.getPosition(long.id).status, "OPEN");
    assert.equal(db.getPositionGroup(long.position_group_id).status, "OPEN");
  } finally { db.close(); }
});

test("one leg TP in one group does not close the opposite group", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    const long = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z", takeProfit: 111 });
    const short = insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z", stopLoss: 120, takeProfit: 80 });
    const report = sideReport("SHORT", { generatedAt: "2026-08-21T01:00:00.000Z", price: 112 });
    report.latest15mBar = { ...report.latest15mBar, low: 110, high: 113 };
    await runMonitorCycle(db, { collect: async () => report, analyze: (value) => value, now: () => report.generatedAt });
    assert.equal(db.getPosition(long.id).status, "CLOSED");
    assert.equal(db.getPosition(short.id).status, "OPEN");
    assert.equal(db.getPositionGroup(short.position_group_id).status, "OPEN");
  } finally { db.close(); }
});

test("gross account risk sums LONG and SHORT and max_positions counts all actual legs", () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({
      positionMode: "HEDGE", allowPyramiding: true, maxOpenPositions: 2,
      totalRiskMode: "MANUAL", totalRiskManualPct: 0.20
    }, { source: "TEST" });
    insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z", riskCny: 20 });
    insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z", riskCny: 30 });
    const state = calculateAccountState(db, null);
    assert.equal(state.totalRiskCny, 50);
    assert.equal(state.longNotionalCny + state.shortNotionalCny, state.grossNotionalCny);
    const snapshotId = db.insertSnapshot(sideReport("LONG", { generatedAt: "2026-08-21T00:45:00.000Z" }));
    assert.throws(() => db.openPosition(candidate("LONG", { openedAt: "2026-08-21T00:45:00.000Z", entryBarTs: 3_000 }), snapshotId), /最大同时仓位数/);
  } finally { db.close(); }
});

test("HEDGE groups and settings survive restart and Telegram exposes an editable position-mode panel", () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-hedge-restart-"));
  const path = join(directory, "paper.sqlite");
  try {
    let db = new PaperDatabase(path);
    db.updateRuntimeSettings({ positionMode: "HEDGE", maxOpenPositions: 4 }, { source: "TEST" });
    insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z" });
    insertAndOpen(db, "SHORT", { openedAt: "2026-08-21T00:30:00.000Z" });
    db.close();
    db = new PaperDatabase(path);
    assert.equal(db.getRuntimeSettings().positionMode, "HEDGE");
    assert.equal(db.getOpenPositionGroups().length, 2);
    const panel = new TelegramControlPanel(db);
    assert.ok(panel.view("position-mode").text.includes("双向 HEDGE"));
    assert.ok(panel.view("positions").text.includes("🟢 LONG"));
    assert.ok(panel.view("positions").text.includes("🔴 SHORT"));
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy #2 SHORT migration repairs a missing/closed group, status and monitor, and is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-position-repair-"));
  const path = join(directory, "paper.sqlite");
  try {
    let db = new PaperDatabase(path);
    const first = insertAndOpen(db, "LONG", { openedAt: "2026-08-20T23:30:00.000Z" });
    closeLeg(db, first, "2026-08-20T23:45:00.000Z");
    const legacy = insertAndOpen(db, "SHORT", {
      openedAt: "2026-08-21T00:00:00.000Z",
      entry: 76025.9,
      stopLoss: 77164.1,
      takeProfit: 72839.1,
      notionalCny: 547.38648,
      marginCny: 109.477296
    });
    assert.equal(legacy.id, 2);
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("UPDATE positions SET position_group_id = NULL, margin_cny = NULL, leverage = NULL, liquidation_price_estimate = NULL WHERE id = 2").run();
    raw.prepare("UPDATE position_groups SET status = 'CLOSED', closed_at = '2026-08-21T00:01:00.000Z' WHERE group_id = ?").run(legacy.position_group_id);
    raw.close();

    db = new PaperDatabase(path);
    const repaired = db.getPosition(2);
    assert.equal(repaired.status, "OPEN");
    assert.equal(repaired.side, "SHORT");
    assert.equal(repaired.entry_price, 76025.9);
    assert.equal(repaired.stop_loss, 77164.1);
    assert.equal(repaired.take_profit, 72839.1);
    assert.equal(repaired.margin_cny, null);
    assert.equal(repaired.leverage, null);
    assert.equal(repaired.liquidation_price_estimate, null);
    assert.equal(repaired.legacy_contract_math_status, "LEGACY_UNKNOWN");
    const repairedGroup = db.getPositionGroup(repaired.position_group_id);
    assert.equal(repairedGroup.status, "OPEN");
    assert.equal(repairedGroup.side, "SHORT");
    assert.doesNotThrow(() => db.updatePositionGroupManagement(repairedGroup.group_id, { oppositeSignalCount: 1 }));
    const validationReport = sideReport("SHORT", {
      generatedAt: "2026-08-21T00:30:00.000Z",
      price: 76025.9
    });
    validationReport.decision = "WAIT";
    validationReport.candidateDecision = "WAIT";
    validationReport.entryAssessment = { enterNow: false, methodLabel: "等待", reasons: [], missingConditions: ["当前无新仓条件"] };
    const monitor = await runMonitorCycle(db, {
      collect: async () => validationReport,
      analyze: (value) => value,
      now: () => validationReport.generatedAt
    });
    assert.ok(monitor.actions.some((item) => item.type === "POSITION_HELD" || item.type === "POSITION_MANAGED"));
    assert.equal(db.getLatestMonitorRun().status, "OK");
    assert.doesNotMatch(db.getLatestMonitorRun().message, /Paper position group is not open/);
    const status = formatStatus(db);
    assert.doesNotMatch(status, /Paper position group is not open/);
    assert.match(status, /旧仓合约数据缺失/);
    const countBefore = db.getPositionGroups().length;
    const repeated = db.repairPositionGroups();
    assert.equal(repeated.createdGroups, 0);
    assert.equal(repeated.changedPositions, 0);
    assert.equal(db.getPositionGroups().length, countBefore);
    assert.ok(existsSync(positionGroupBackupPath(path)));
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("NET mode preserves the original opposite-side prohibition", () => {
  const db = new PaperDatabase(":memory:");
  try {
    assert.equal(db.getRuntimeSettings().positionMode, "NET");
    db.updateRuntimeSettings({ allowPyramiding: true, maxOpenPositions: 2 }, { source: "TEST" });
    const long = insertAndOpen(db, "LONG", { openedAt: "2026-08-21T00:15:00.000Z" });
    const snapshotId = db.insertSnapshot(sideReport("SHORT", { generatedAt: "2026-08-21T00:30:00.000Z" }));
    assert.throws(() => db.openPosition(candidate("SHORT", { openedAt: "2026-08-21T00:30:00.000Z" }), snapshotId), /NET 模式|相反方向/);
    assert.equal(db.getPosition(long.id).status, "OPEN");
  } finally { db.close(); }
});
