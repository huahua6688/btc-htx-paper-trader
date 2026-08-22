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
    assert.equal(second.actions[0].type, "CLOSE");
    assert.equal(second.actions[0].exit.exitReason, "TP");
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
