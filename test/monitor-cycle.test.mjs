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
    assert.equal(first.actions[0].type, "SETUP_CREATED");
    assert.ok(first.actions.some((action) => action.type === "OPEN"));
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
