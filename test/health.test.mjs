import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { evaluateHealth, evaluateHealthWithInfrastructure, formatHealth } from "../src/health-check.mjs";
import { paperReport } from "./helpers.mjs";

test("health is green when SQLite, snapshot, and a recent successful monitor are present", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(report);
    db.recordMonitorRun({
      startedAt: "2026-08-21T00:59:55.000Z",
      finishedAt: "2026-08-21T01:00:05.000Z",
      status: "OK",
      message: "NO_ENTRY",
      snapshotId
    });
    const health = evaluateHealth(db, {
      nowMs: new Date("2026-08-21T01:10:00.000Z").getTime(),
      maxAgeMs: 15 * 60 * 1000
    });
    assert.equal(health.healthy, true);
    assert.equal(health.snapshot.count, 1);
    assert.equal(health.account.cashCny, 1_000);
  } finally {
    db.close();
  }
});

test("health fails on an error run or stale monitor timestamp", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(report);
    db.recordMonitorRun({
      startedAt: "2026-08-21T00:59:55.000Z",
      finishedAt: "2026-08-21T01:00:05.000Z",
      status: "ERROR",
      message: "public feed unavailable",
      snapshotId
    });
    const health = evaluateHealth(db, {
      nowMs: new Date("2026-08-21T01:30:00.000Z").getTime(),
      maxAgeMs: 15 * 60 * 1000
    });
    assert.equal(health.healthy, false);
    assert.match(health.failures.join(" "), /ERROR/);
    assert.match(health.failures.join(" "), /超过 15 分钟/);
  } finally {
    db.close();
  }
});

test("health fails cleanly before the first monitor snapshot", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const health = evaluateHealth(db);
    assert.equal(health.healthy, false);
    assert.match(health.failures.join(" "), /尚无 monitor/);
    assert.match(health.failures.join(" "), /尚无行情快照/);
  } finally {
    db.close();
  }
});

test("research infrastructure failure is degraded warning while healthy Paper core stays healthy", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" });
    const snapshotId = db.insertSnapshot(report);
    db.recordMonitorRun({
      startedAt: "2026-08-21T00:59:55.000Z",
      finishedAt: "2026-08-21T01:00:05.000Z",
      status: "OK",
      message: "NO_ENTRY",
      snapshotId
    });
    const health = await evaluateHealthWithInfrastructure(db, {
      nowMs: new Date("2026-08-21T01:10:00.000Z").getTime(),
      maxAgeMs: 15 * 60 * 1000,
      infrastructureBuilder: async () => { throw new Error("catalog unavailable"); }
    });
    assert.equal(health.healthy, true);
    assert.deepEqual(health.failures, []);
    assert.equal(health.degradedInfrastructure, true);
    assert.match(health.infrastructureWarnings.join(" "), /catalog unavailable/);
    assert.match(formatHealth(health), /不影响 Paper health/);
  } finally {
    db.close();
  }
});
