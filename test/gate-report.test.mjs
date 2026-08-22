import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { calculateGateReport, formatGateReport } from "../src/gate-reporting.mjs";
import { paperReport } from "./helpers.mjs";

test("gate report separates legacy hard blocks from V1.1 risk downgrades and setup states", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const legacy = paperReport({ generatedAt: "2026-08-21T00:00:00.000Z" });
    delete legacy.strategy;
    legacy.riskGates = ["4h RSI 过热，禁止追多"];
    legacy.decision = "WAIT";
    db.insertSnapshot(legacy);

    const modern = paperReport({
      generatedAt: "2026-08-21T01:00:00.000Z",
      decision: "WAIT",
      strategy: {
        bias: "LONG",
        marketRegime: "TRENDING",
        state: "WATCHING",
        hardBlocks: [],
        softWarnings: ["日线 RSI 过热，风险降至 0.5%"]
      }
    });
    const snapshotId = db.insertSnapshot(modern);
    db.createSetup({
      ...paperReport().strategy.setupProposal,
      createdAt: modern.generatedAt,
      expiresAt: "2026-08-21T07:00:00.000Z",
      triggeredNow: false,
      armImmediately: false
    }, snapshotId);

    const report = calculateGateReport(db);
    assert.equal(report.snapshotCount, 2);
    assert.equal(report.legacySnapshots, 1);
    assert.equal(report.v11Snapshots, 1);
    assert.equal(report.hardBlocks["4h RSI"], 1);
    assert.equal(report.softWarnings["日线 RSI"], 1);
    assert.equal(report.setupStatuses.WATCHING, 1);
    assert.match(formatGateReport(report), /V1\.1 Gate 统计/);
  } finally {
    db.close();
  }
});

