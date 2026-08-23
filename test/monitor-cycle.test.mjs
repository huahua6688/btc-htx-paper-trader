import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { runMonitorCycle } from "../src/monitor-cycle.mjs";
import { paperReport } from "./helpers.mjs";

test("monitor cycle stores decisions, opens a paper position, then closes it at TP", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const firstReport = paperReport();
    const first = await runMonitorCycle(db, {
      collect: async () => firstReport,
      analyze: (value) => value,
      now: () => "2026-08-21T01:00:01.000Z"
    });
    assert.equal(first.actions[0].type, "OPEN");
    assert.equal(db.getOpenPosition().status, "OPEN");

    const secondReport = paperReport({
      generatedAt: "2026-08-21T01:15:00.000Z",
      currentPrice: 112,
      latest15mBar: { timestamp: firstReport.latest15mBar.timestamp + 15 * 60 * 1000, low: 100, high: 112, close: 112 }
    });
    const second = await runMonitorCycle(db, {
      collect: async () => secondReport,
      analyze: (value) => value,
      now: () => "2026-08-21T01:15:01.000Z"
    });
    const closeAction = second.actions.find((action) => action.type === "CLOSE");
    assert.ok(closeAction, "本轮应在持仓管理后触发止盈平仓");
    assert.equal(closeAction.exit.exitReason, "TP");
    assert.equal(db.getOpenPosition(), null);
    assert.equal(db.countSnapshots(), 2);
    assert.equal(db.getLatestMonitorRun().status, "OK");
  } finally {
    db.close();
  }
});

test("monitor cancels a legacy fixed-price setup and evaluates the current round independently", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const legacyReport = paperReport({ generatedAt: "2026-08-21T00:30:00.000Z" });
    const snapshotId = db.insertSnapshot(legacyReport);
    db.createSetup({
      side: "LONG",
      type: "TREND_PULLBACK",
      createdAt: legacyReport.generatedAt,
      expiresAt: "2026-08-21T06:30:00.000Z",
      basisBarTs: legacyReport.completed15mBar.timestamp,
      entryZone: [90, 92],
      triggerPrice: 93,
      invalidationPrice: 88,
      stopLoss: 88,
      takeProfit: [103, 108],
      riskReward: [2.2, 3],
      riskPct: 0.005,
      riskTier: "REDUCED",
      armImmediately: false,
      reasons: ["旧版测试计划"],
      warnings: []
    }, snapshotId);
    const waitReport = paperReport({
      generatedAt: "2026-08-21T01:00:00.000Z",
      decision: "WAIT",
      candidateDecision: "SHORT",
      plan: { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null },
      entryAssessment: {
        enterNow: false,
        method: "PREFER_STRENGTH_CONFIRMATION",
        methodLabel: "方向成立，但等待短周期重新走弱更合适",
        reasons: ["短周期尚未走弱"],
        missingConditions: ["等待短周期重新走弱"],
        riskPct: 0
      },
      strategy: { ...paperReport().strategy, bias: "SHORT", state: "WAIT", riskPct: 0, entryMethod: "PREFER_STRENGTH_CONFIRMATION" }
    });
    const result = await runMonitorCycle(db, {
      collect: async () => waitReport,
      analyze: (value) => value,
      now: () => "2026-08-21T01:00:01.000Z"
    });
    assert.equal(result.actions[0].type, "LEGACY_SETUP_CANCELLED");
    assert.ok(result.actions.some((action) => action.type === "NO_ENTRY"));
    assert.equal(db.getActiveSetup(), null);
    assert.equal(db.getOpenPosition(), null);
  } finally {
    db.close();
  }
});

test("monitor failure is recorded and fails safely", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    await assert.rejects(() => runMonitorCycle(db, {
      collect: async () => { throw new Error("public feed unavailable"); },
      now: () => "2026-08-21T01:00:00.000Z"
    }), /public feed unavailable/);
    assert.equal(db.getLatestMonitorRun().status, "ERROR");
    assert.equal(db.getOpenPosition(), null);
  } finally {
    db.close();
  }
});

test("stale core price never triggers stop, target, management or a new position", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const opening = paperReport({ generatedAt: "2026-08-21T00:30:00.000Z" });
    const opened = await runMonitorCycle(db, {
      collect: async () => opening,
      analyze: (value) => value,
      now: () => opening.generatedAt
    });
    assert.ok(opened.actions.some((item) => item.type === "OPEN"));
    const stale = paperReport({
      generatedAt: "2026-08-21T02:00:00.000Z",
      currentPrice: 80,
      latest15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), open: 100, high: 120, low: 70, close: 80 },
      completed15mBar: { timestamp: new Date("2026-08-21T00:45:00.000Z").getTime(), open: 100, high: 120, low: 70, close: 80 }
    });
    const result = await runMonitorCycle(db, {
      collect: async () => stale,
      analyze: (value) => value,
      now: () => stale.generatedAt
    });
    assert.equal(db.getOpenPositions().length, 1);
    assert.equal(result.actions.some((item) => item.type === "CLOSE"), false);
    assert.equal(result.actions.some((item) => item.type === "OPEN"), false);
    assert.ok(result.actions.some((item) => item.type === "POSITION_HELD" && item.management.dataSafe === false));
  } finally {
    db.close();
  }
});

test("a Telegram-style settings update between sizing and insert atomically cancels the entry", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const originalOpen = db.openPosition.bind(db);
    db.openPosition = (candidate, snapshotId, options) => {
      db.updateRuntimeSettings({ riskProfile: "CONSERVATIVE" }, { source: "TELEGRAM_ADMIN_CHAT", sourceEventId: "telegram:race" });
      return originalOpen(candidate, snapshotId, options);
    };
    const report = paperReport();
    const result = await runMonitorCycle(db, {
      collect: async () => report,
      analyze: (value) => value,
      now: () => report.generatedAt
    });
    assert.equal(db.getOpenPosition(), null);
    assert.ok(result.actions.some((item) => item.type === "NO_ENTRY" && item.reasons.join(" ").includes("设置版本已变化")));
  } finally {
    db.close();
  }
});
