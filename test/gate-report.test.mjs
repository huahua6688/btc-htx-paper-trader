import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { calculateGateReport, formatGateReport } from "../src/gate-reporting.mjs";
import { paperReport } from "./helpers.mjs";

test("gate report separates historical versions and summarizes dynamic two-sided decisions", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const legacy = paperReport({ generatedAt: "2026-08-21T00:00:00.000Z" });
    delete legacy.strategy;
    delete legacy.version;
    legacy.riskGates = ["4h RSI 过热，禁止追多"];
    legacy.decision = "WAIT";
    db.insertSnapshot(legacy);

    const v11 = paperReport({ generatedAt: "2026-08-21T00:30:00.000Z", version: "V1.1" });
    v11.strategy = { bias: "LONG", marketRegime: "TRENDING", hardBlocks: [], softWarnings: ["日线 RSI 过热，风险降至 0.5%"] };
    db.insertSnapshot(v11);

    const modern = paperReport({
      generatedAt: "2026-08-21T01:00:00.000Z",
      decision: "WAIT",
      candidateDecision: "SHORT",
      entryAssessment: {
        enterNow: false,
        method: "PREFER_STRENGTH_CONFIRMATION",
        methodLabel: "方向成立，但等待短周期重新走弱更合适",
        reasons: ["短周期时机一般"],
        missingConditions: ["等待短周期重新走弱"],
        riskPct: 0
      },
      opportunities: {
        LONG: { score: 42 },
        SHORT: { score: 64 }
      },
      strategy: {
        ...paperReport().strategy,
        bias: "SHORT",
        state: "WAIT",
        riskPct: 0,
        softWarnings: ["短周期入场质量一般"],
        entryMethod: "PREFER_STRENGTH_CONFIRMATION"
      }
    });
    db.insertSnapshot(modern);

    const report = calculateGateReport(db);
    assert.equal(report.snapshotCount, 3);
    assert.equal(report.legacySnapshots, 1);
    assert.equal(report.v11Snapshots, 1);
    assert.equal(report.v12Snapshots, 1);
    assert.equal(report.entryMethods.PREFER_STRENGTH_CONFIRMATION, 1);
    assert.equal(report.averageLongScore, 42);
    assert.equal(report.averageShortScore, 64);
    assert.equal(report.hardBlocks["4h RSI"], undefined);
    assert.equal(report.historicalHardBlocks["4h RSI"], 1);
    assert.equal(report.softWarnings["短周期入场质量一般"], 1);
    assert.equal(report.historicalSoftWarnings["日线 RSI"], 1);
    assert.match(formatGateReport(report), /V1\.2 Dynamic Gate 统计/);
  } finally {
    db.close();
  }
});
