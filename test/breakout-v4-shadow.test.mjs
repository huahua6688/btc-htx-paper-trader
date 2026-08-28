import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateBreakoutV4Shadow,
  evaluateBreakoutV4ShadowEvidence,
  verifyBreakoutV4ActiveShadowConfiguration,
  verifyBreakoutV4RobustnessForShadow
} from "../src/breakout-v4-shadow.mjs";
import {
  evaluateV4RobustnessEvidence,
  robustnessParameterPerturbations,
  V4_ROBUSTNESS_POLICY
} from "../src/monte-carlo.mjs";
import { hashObject } from "../src/research-utils.mjs";

function fixtures() {
  const parameters = {
    version: "breakout-challenger-v4.0.0",
    breakoutLookback4h: 80,
    trendEma4h: 50,
    trendSlopeBars4h: 6,
    trendFilter: "EMA50_PRICE_ALIGNMENT",
    atrPeriod4h: 14,
    stopAtrMultiple: 1.5,
    targetRiskMultiple: 4,
    minimumBreakoutAtr: 0,
    positionManagementProfile: "HARD_BRACKET_HOLD_V1",
    researchOnly: true
  };
  const baseMetrics = {
    tradeCount: 136,
    netReturnPct: 45.5817,
    profitFactor: 1.2813,
    maxDrawdownPct: 14.4074
  };
  const perturbations = robustnessParameterPerturbations("breakout-v4", parameters).map((item, index) => {
    const perturbed = { ...parameters, ...item.patch, version: `${parameters.version}-${item.label}` };
    const metrics = {
      eligible: true,
      eligibilityReasons: [],
      tradeCount: 130 + index,
      netReturnPct: 20 + index,
      profitFactor: 1.1 + index / 100,
      maxDrawdownPct: 20 - index
    };
    return { label: item.label, parameters: perturbed, parameterHash: hashObject(perturbed), metrics };
  });
  const selection = {
    parameters,
    parameterHash: hashObject(parameters),
    selectionHash: "resilience-selection-hash",
    datasetManifestHash: "catalog-hash",
    report: {
      runType: "BREAKOUT_V4_LOCAL_RESILIENCE_DEVELOPMENT_ONLY_SELECTION",
      winner: { passed: true, parameters, parameterHash: hashObject(parameters), baseMetrics, perturbations },
      replayContract: {
        strategy: "breakout-v4",
        eventStride: 1,
        executionDelayBars: 1,
        forceCloseAtDevelopmentEnd: true,
        portfolio: { maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false }
      }
    }
  };
  const report = {
    status: "partial",
    reason: "DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE",
    runType: "MONTE_CARLO_AND_REPLAY_ROBUSTNESS",
    generatedAt: "2026-08-27T17:51:52.618Z",
    base: {
      strategyHash: selection.parameterHash,
      trades: baseMetrics.tradeCount,
      returnPct: baseMetrics.netReturnPct,
      profitFactor: baseMetrics.profitFactor,
      maxDrawdownPct: baseMetrics.maxDrawdownPct,
      executable: true
    },
    executionContract: {
      eventStride: 1,
      baseExecutionDelayBars: 1,
      forceCloseAtEnd: true,
      portfolio: { maxOpenPositions: 1, positionMode: "NET", allowPyramiding: false }
    },
    tradeOrderResampling: { lossProbabilityPct: 10, maxDrawdownPct: { p95: 30 } },
    blockBootstrap: { lossProbabilityPct: 10, maxDrawdownPct: { p95: 30 } },
    pairedAccounting: {
      observedTradeBaseline: { returnPct: 45, profitFactor: 1.28 },
      costDeterioration150Pct: { returnPct: 40, profitFactor: 1.2 },
      slippageDeterioration200Pct: { returnPct: 41, profitFactor: 1.21 }
    },
    parameterPerturbation: perturbations.map((item) => ({
      label: item.label,
      parameters: item.parameters,
      result: {
        strategyHash: item.parameterHash,
        trades: item.metrics.tradeCount,
        returnPct: item.metrics.netReturnPct,
        profitFactor: item.metrics.profitFactor,
        maxDrawdownPct: item.metrics.maxDrawdownPct,
        executable: true
      }
    })),
    deterministicStress: {
      costDeterioration150Pct: { returnPct: 40, sameTradePathAsBase: true },
      slippageDeterioration200Pct: { returnPct: 41, sameTradePathAsBase: true },
      allLossesFirst: { maxDrawdownPct: 80 }
    },
    delayedExecutionEvidence: { available: false, safetyRejectionExpected: true }
  };
  report.gate = evaluateV4RobustnessEvidence({
    tradeOrderResampling: report.tradeOrderResampling,
    blockBootstrap: report.blockBootstrap,
    pairedAccounting: report.pairedAccounting,
    parameterPerturbation: report.parameterPerturbation,
    delayedExecutionEvidence: report.delayedExecutionEvidence,
    deterministicStress: report.deterministicStress,
    base: report.base,
    policy: V4_ROBUSTNESS_POLICY
  });
  return { selection, report };
}

test("V4 Shadow accepts only the numerically-passed robustness bound to the resilient winner", () => {
  const { selection, report } = fixtures();
  const verified = verifyBreakoutV4RobustnessForShadow(selection, report);
  assert.equal(verified.numericalGatesPassed, true);
  assert.deepEqual(verified.pendingEvidence, ["DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE"]);

  const tampered = structuredClone(report);
  tampered.parameterPerturbation[0].result.strategyHash = "tampered";
  assert.throws(() => verifyBreakoutV4RobustnessForShadow(selection, tampered), /perturbation hash mismatch/);

  const failed = structuredClone(report);
  failed.tradeOrderResampling.lossProbabilityPct = 60;
  failed.gate = evaluateV4RobustnessEvidence({
    tradeOrderResampling: failed.tradeOrderResampling,
    blockBootstrap: failed.blockBootstrap,
    pairedAccounting: failed.pairedAccounting,
    parameterPerturbation: failed.parameterPerturbation,
    delayedExecutionEvidence: failed.delayedExecutionEvidence,
    deterministicStress: failed.deterministicStress,
    base: failed.base,
    policy: V4_ROBUSTNESS_POLICY
  });
  failed.status = failed.gate.status;
  assert.throws(() => verifyBreakoutV4RobustnessForShadow(selection, failed), /numerical robustness did not pass/);
});

test("V4 Shadow activation is hashed, isolated, idempotent and refuses silent replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-v4-shadow-"));
  try {
    const { selection, report } = fixtures();
    const activeConfigPath = join(directory, "active-shadow-strategy.json");
    const databasePath = join(directory, "candidate.sqlite");
    const first = await activateBreakoutV4Shadow({
      selection,
      robustnessReport: report,
      selectionPath: join(directory, "selection.json"),
      robustnessPath: join(directory, "robustness.json"),
      activeConfigPath,
      databasePath,
      now: "2026-08-28T00:00:00.000Z"
    });
    assert.equal(first.activated, true);
    assert.equal(first.config.paperOnly, true);
    assert.equal(first.config.safety.exchangeWrites, false);
    assert.notEqual(first.config.databasePath, first.config.selectionPath);
    verifyBreakoutV4ActiveShadowConfiguration(first.config, { productionDatabasePath: join(directory, "production.sqlite") });
    assert.deepEqual(JSON.parse(await readFile(activeConfigPath, "utf8")), first.config);

    const second = await activateBreakoutV4Shadow({
      selection,
      robustnessReport: report,
      selectionPath: join(directory, "selection.json"),
      robustnessPath: join(directory, "robustness.json"),
      activeConfigPath,
      databasePath
    });
    assert.equal(second.activated, false);
    assert.equal(second.idempotent, true);

    const different = structuredClone(report);
    different.generatedAt = "2026-08-28T01:00:00.000Z";
    assert.rejects(() => activateBreakoutV4Shadow({
      selection,
      robustnessReport: different,
      selectionPath: join(directory, "selection.json"),
      robustnessPath: join(directory, "robustness-2.json"),
      activeConfigPath,
      databasePath: join(directory, "candidate-2.sqlite")
    }), /already active/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V4 Shadow evidence counts unique directional signals and never auto-promotes", () => {
  const start = Date.parse("2026-08-28T00:00:00.000Z");
  const snapshots = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    captured_at: new Date(start + index * 31 * 86_400_000 / 99).toISOString(),
    decision: index % 2 ? "LONG" : "SHORT",
    report: {
      entryAssessment: { signalKey: `signal-${index}` },
      execution: { signalAgeMs: 60_000 }
    }
  }));
  snapshots.push({ ...snapshots.at(-1), id: 101 });
  const evidence = evaluateBreakoutV4ShadowEvidence({
    config: { paperOnly: true, championChanged: false },
    snapshots,
    performance: { cumulativeReturnPct: 5, profitFactor: 1.2 }
  });
  assert.equal(evidence.directionalSignals, 100);
  assert.equal(evidence.status, "ELIGIBLE_FOR_EXPLICIT_PROMOTION_REVIEW");
  assert.equal(evidence.automaticPromotion, false);

  snapshots[0].report.execution.signalAgeMs = 6 * 60_000;
  const stale = evaluateBreakoutV4ShadowEvidence({
    config: { paperOnly: true, championChanged: false },
    snapshots,
    performance: { cumulativeReturnPct: 5, profitFactor: 1.2 }
  });
  assert.equal(stale.status, "COLLECTING");
  assert.ok(stale.reasons.includes("SHADOW_SIGNAL_AGE_EXCEEDED"));
});
