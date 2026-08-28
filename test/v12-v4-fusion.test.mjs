import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activateV12V4FusionShadow,
  combineV12V4Reports,
  V12_V4_FUSION_PARAMETERS,
  verifyV12V4FusionActiveShadowConfiguration
} from "../src/v12-v4-fusion.mjs";
import { REPLAY_STRATEGIES, runHistoricalReplay } from "../src/replay-engine.mjs";
import { hashObject } from "../src/research-utils.mjs";

function reports({ baseDecision = "LONG", trend = "LONG", breakout = false } = {}) {
  const base = {
    version: "V1.2",
    generatedAt: "2026-08-28T00:00:00.000Z",
    currentPrice: 100,
    decision: baseDecision,
    candidateDecision: baseDecision,
    confidencePct: 70,
    completed15mBar: { timestamp: 1_000 },
    plan: { entryPrice: 100, stopLoss: 98, takeProfit: [104], riskReward: [2] },
    entryAssessment: { enterNow: baseDecision !== "WAIT", riskPct: 0.5 },
    opportunities: {
      LONG: { side: "LONG", score: 70, supportingReasons: ["V1.2 long"], opposingReasons: [] },
      SHORT: { side: "SHORT", score: 30, supportingReasons: [], opposingReasons: ["V1.2 long"] }
    },
    strategy: { marketRegime: "4H_UPTREND" },
    scores: { longOpportunity: 70, shortOpportunity: 30 },
    dataQuality: { validForEntry: true, failures: [] },
    derivatives: {}
  };
  const v4 = {
    version: "breakout-challenger-v4.0.0",
    decision: breakout ? trend : "WAIT",
    entryAssessment: { enterNow: breakout, signalKey: "v4-signal-1" },
    plan: { entryPrice: 100, stopLoss: 97, takeProfit: [112], riskReward: [4], managementContract: { profile: "HARD_BRACKET_HOLD_V1" } },
    breakout: { longTrend: trend === "LONG", shortTrend: trend === "SHORT" },
    opportunities: {
      LONG: { side: "LONG", score: trend === "LONG" ? 80 : 10, supportingReasons: [], opposingReasons: [] },
      SHORT: { side: "SHORT", score: trend === "SHORT" ? 80 : 10, supportingReasons: [], opposingReasons: [] }
    },
    scores: { longOpportunity: 80, shortOpportunity: 10 },
    dataQuality: { validForEntry: true, failures: [] }
  };
  return { base, v4 };
}

test("fusion emits one LONG decision only when V1.2 and V4 agree", () => {
  const { base, v4 } = reports({ breakout: true });
  const report = combineV12V4Reports(base, v4, V12_V4_FUSION_PARAMETERS, Date.UTC(2026, 0, 1));
  assert.equal(report.decision, "LONG");
  assert.equal(report.entryAssessment.enterNow, true);
  assert.equal(report.plan.stopLoss, 97, "confirmed breakout uses the one selected V4 bracket");
  assert.equal(report.strategy.positionManagementProfile, "HARD_BRACKET_HOLD_V1");
  assert.match(report.entryAssessment.method, /BREAKOUT_CONFIRMATION/);
  assert.equal(report.fusion.components.v12, base);
  assert.equal(report.fusion.components.v4, v4);
});

test("fusion waits on disagreement and never creates an opposite trade", () => {
  const { base, v4 } = reports({ trend: "SHORT" });
  const report = combineV12V4Reports(base, v4, V12_V4_FUSION_PARAMETERS, Date.UTC(2026, 0, 1));
  assert.equal(report.decision, "WAIT");
  assert.equal(report.candidateDecision, "WAIT");
  assert.equal(report.entryAssessment.enterNow, false);
  assert.equal(report.plan.entryPrice, null);
  assert.equal(report.entryAssessment.signalKey, null);
});

test("fusion keeps V1.2's single plan when V4 only supplies the 4h guard", () => {
  const { base, v4 } = reports({ breakout: false });
  const report = combineV12V4Reports(base, v4, V12_V4_FUSION_PARAMETERS, Date.UTC(2026, 0, 1));
  assert.equal(report.decision, "LONG");
  assert.equal(report.plan.stopLoss, 98);
  assert.match(report.entryAssessment.method, /DIRECTION_GUARD/);
});

test("fusion is a first-class replay strategy without replacing existing strategies", async () => {
  assert.ok(REPLAY_STRATEGIES.includes("v12-v4-fusion"));
  for (const strategy of ["champion", "breakout-v4", "v12-v4-fusion"]) assert.ok(REPLAY_STRATEGIES.includes(strategy));
  await assert.rejects(
    runHistoricalReplay({ manifest: { requestedCoverage: {} }, candles: [], funding: [] }, { strategy: "v12-v4-fusion" }),
    (error) => !/Unknown replay strategy/.test(error.message)
  );
});

test("fusion Shadow config requires research-only hash and an independent database", () => {
  const config = {
    schemaVersion: 3,
    paperOnly: true,
    strategyType: "v12-v4-fusion",
    version: V12_V4_FUSION_PARAMETERS.version,
    parameters: V12_V4_FUSION_PARAMETERS,
    strategyHash: "",
    databasePath: "/tmp/fusion-shadow.sqlite",
    championChanged: false,
    safety: { exchangeWrites: false }
  };
  config.strategyHash = hashObject(config.parameters);
  config.configHash = hashObject({ ...config, configHash: undefined });
  assert.doesNotThrow(() => verifyV12V4FusionActiveShadowConfiguration(config, { productionDatabasePath: "/tmp/production.sqlite" }));
});

test("fusion Shadow activation is isolated, hashed and refuses an incomplete gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-fusion-shadow-"));
  try {
    const strategyHash = hashObject(V12_V4_FUSION_PARAMETERS);
    const replay = { strategy: "v12-v4-fusion", strategyHash, dataManifestHash: "fusion-manifest" };
    const robustnessReport = {
      runType: "MONTE_CARLO_AND_REPLAY_ROBUSTNESS",
      status: "ok",
      base: { strategyHash },
      gate: { passed: true }
    };
    const activeConfigPath = join(directory, "active-shadow.json");
    const activation = await activateV12V4FusionShadow({
      replay,
      replayPath: join(directory, "replay.json"),
      robustnessReport,
      robustnessPath: join(directory, "robustness.json"),
      activeConfigPath,
      databasePath: join(directory, "fusion.sqlite"),
      productionDatabasePath: join(directory, "production.sqlite")
    });
    assert.equal(activation.activated, true);
    assert.equal(activation.config.paperOnly, true);
    assert.equal(activation.config.championChanged, false);
    assert.doesNotThrow(() => verifyV12V4FusionActiveShadowConfiguration(activation.config, { productionDatabasePath: join(directory, "production.sqlite") }));
    await assert.rejects(
      activateV12V4FusionShadow({ replay, replayPath: "x", robustnessReport: { ...robustnessReport, gate: { passed: false } }, robustnessPath: "y", activeConfigPath: join(directory, "other.json"), databasePath: join(directory, "other.sqlite") }),
      /robustness gate has not passed/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
