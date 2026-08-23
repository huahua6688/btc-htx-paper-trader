import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { attachMultiLayerMarketContext } from "../src/market-context.mjs";
import { assertLayerEffectAllowed, validatePromotionEvidence } from "../src/feature-registry.mjs";
import { paperReport } from "./helpers.mjs";

const historicalEvidence = {
  candidateVersion: "200w-v1",
  historicalSamples: 5_000,
  outOfSampleTrades: 300,
  walkForwardWindows: 6,
  positiveWindows: 5,
  netSharpeDelta: 0.12,
  netProfitFactorDelta: 0.08,
  costsIncluded: true,
  noLookaheadAudit: true,
  missingDataPolicyTested: true,
  purgingApplied: true,
  embargoBars: 24,
  dataManifestHash: "sha256:test-data-manifest",
  featureCodeHash: "sha256:test-feature-code",
  trainEnd: "2024-12-31T00:00:00.000Z",
  testStart: "2025-01-01T00:00:00.000Z",
  historyStart: "2013-01-01T00:00:00.000Z",
  historyEnd: "2026-01-01T00:00:00.000Z"
};

test("new context features start research-only and caller-declared validation evidence is rejected", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const feature = db.getFeature("btc_200_week_ma");
    assert.equal(feature.status, "research-only");
    assert.equal(feature.current_weight, 0);
    assert.throws(() => db.recordFeatureValidation("btc_200_week_ma", historicalEvidence), /已废弃.*ValidationEngine/);
    assert.equal(db.getFeature("btc_200_week_ma").status, "research-only");
    assert.equal(db.getFeatureValidationRuns("btc_200_week_ma").length, 0);
  } finally {
    db.close();
  }
});

test("caller-declared Shadow evidence cannot create promotion rows or promote a feature", () => {
  const db = new PaperDatabase(":memory:");
  try {
    assert.throws(() => db.recordFeatureShadowValidation("btc_200_week_ma", {
      candidateVersion: "200w-v1",
      calendarDays: 45,
      signals: 180,
      missingRate: 0.01,
      paperOnly: true,
      championUnaffected: true,
      costsIncluded: true,
      netRiskAdjustedContribution: 0.09
    }), /已废弃.*Shadow/);
    assert.throws(() => db.promoteFeatureToChampion("btc_200_week_ma", {
      candidateVersion: "200w-v1",
      proposedWeight: 0.1,
      productionEffect: "RISK_MULTIPLIER",
      productionAdapterTested: true,
      layerContractTested: true,
      approvedBy: "paper-admin"
    }), /缺少已通过/);
    assert.equal(db.getFeature("btc_200_week_ma").status, "research-only");
    assert.equal(db.getFeaturePromotionAudit("btc_200_week_ma").length, 0);
  } finally {
    db.close();
  }
});

test("multi-layer context exposes only enabled production factors and audits source quality", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const report = paperReport({
      timeframes: {
        "15m": { score: 20 }, "1h": { score: 35 }, "4h": { score: 40 }, "1d": { score: 10 }
      },
      derivatives: { fundingRatePct: 0.01, directionalScore: 12, pressureScore: 30, signals: [{ label: "Order Book 前 20 档不平衡 3%" }] }
    });
    const market = { kline15m: { data: [{ id: 1_787_273_100 }] } };
    const context = attachMultiLayerMarketContext(db, report, market);
    assert.equal(context.report.multiLayerContext.longTermMayTriggerIntradayTrade, false);
    assert.ok(context.report.multiLayerContext.activeProductionFactors.length >= 5);
    assert.ok(context.report.multiLayerContext.researchOnlyFeatures.every((item) => item.weight === 0));
    const kline = context.observations.find((item) => item.sourceKey === "kline15m");
    assert.equal(kline.qualityStatus, "AVAILABLE");
    assert.equal(kline.details.coverageClaim, "OBSERVED_RESPONSE_RANGE");
  } finally {
    db.close();
  }
});

test("validation and time-layer contracts reject weak or forbidden evidence", () => {
  assert.equal(validatePromotionEvidence({}).passed, false);
  assert.throws(() => assertLayerEffectAllowed("EXECUTION", "STANDALONE_DIRECTION"), /禁止作用/);
  assert.equal(assertLayerEffectAllowed("LONG_TERM", "BACKGROUND"), true);
});
