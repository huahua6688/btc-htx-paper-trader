import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { resolveExchangeConstraints } from "../src/exchange-constraints.mjs";
import {
  applyDueFunding,
  buildPaperCandidate,
  calculateAccountState,
  calculatePerformance,
  evaluatePaperEntry,
  evaluatePaperExit,
  fundingBoundaries,
  getDailyRiskState,
  shanghaiDayStartIso
} from "../src/paper-engine.mjs";
import { RUNTIME_SETTINGS_DEFAULTS } from "../src/config.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

const closeLoss = (db, position, closedAt, grossPnlCny = -1) => db.closePosition(position.id, {
  closedAt,
  exitPrice: 95,
  exitTriggerPrice: 95,
  exitReason: "SL",
  grossPnlCny,
  exitFeeCny: 0.01,
  exitSlippageCny: 0
});

test("contract candidate fields are mathematically consistent after fees, funding and slippage", () => {
  const candidate = buildPaperCandidate(paperReport(), { cash_cny: 1_000 });
  assert.ok(candidate);
  assert.equal(candidate.quantityBtc % 0.001 < 1e-10, true);
  assert.ok(Math.abs(candidate.notionalCny - candidate.quantityBtc * candidate.entry * 7.2) < 0.001);
  assert.ok(Math.abs(candidate.marginCny - candidate.notionalCny / candidate.leverage) < 0.001);
  assert.ok(Math.abs(candidate.netRr - candidate.expectedProfitCny / candidate.expectedLossCny) < 0.001);
  assert.equal(candidate.riskCny, candidate.expectedLossCny);
  assert.ok(candidate.expectedLossCny <= candidate.riskBudgetCny + 0.01);
  assert.ok(candidate.netRr >= 2);
  assert.ok(candidate.stopLoss > candidate.liquidationPriceEstimate);
  assert.match(candidate.liquidationSource, /PAPER.*NOT_HTX/);
});

test("position sizing follows equity and opportunity quality rather than a fixed CNY risk", () => {
  const lowEquity = buildPaperCandidate(paperReport(), { cash_cny: 800 });
  const highEquity = buildPaperCandidate(paperReport(), { cash_cny: 1_200 });
  const lowerQuality = buildPaperCandidate(paperReport({
    opportunities: { ...paperReport().opportunities, LONG: { ...paperReport().opportunities.LONG, score: 68 } }
  }), { cash_cny: 1_200 });
  assert.ok(lowEquity && highEquity && lowerQuality);
  assert.ok(highEquity.expectedLossCny > lowEquity.expectedLossCny);
  assert.ok(highEquity.quantityBtc > lowEquity.quantityBtc);
  assert.ok(lowerQuality.expectedLossCny < highEquity.expectedLossCny);
});

test("dynamic leverage allocates margin but never raises the allowed loss", () => {
  const conservative = buildPaperCandidate(paperReport(), { cash_cny: 1_000 }, {
    ...RUNTIME_SETTINGS_DEFAULTS,
    leverageMode: "MANUAL", leverageManual: 2, userMaxLeverage: 2
  });
  const widerLimit = buildPaperCandidate(paperReport(), { cash_cny: 1_000 }, {
    ...RUNTIME_SETTINGS_DEFAULTS,
    leverageMode: "MANUAL", leverageManual: 8, userMaxLeverage: 8
  });
  assert.ok(conservative && widerLimit);
  assert.ok(conservative.leverage <= 2);
  assert.ok(widerLimit.leverage > conservative.leverage);
  assert.ok(widerLimit.expectedLossCny <= widerLimit.riskBudgetCny + 0.01);
  assert.ok(Math.abs(widerLimit.notionalCny / widerLimit.leverage - widerLimit.marginCny) < 0.001);
});

test("public 200x product range is recorded while account and tier eligibility remain unknown", () => {
  const constraints = resolveExchangeConstraints({
    contractElements: { data: [{ contract_code: "BTC-USDT", instrument_value: "0.001", max_level: "200" }] }
  });
  assert.equal(constraints.contractSizeBtc, 0.001);
  assert.equal(constraints.publicAdvertisedMaxLeverage, 200);
  assert.equal(constraints.verifiedPositionTierMaxLeverage, null);
  assert.equal(constraints.tierLimitVerified, false);
  assert.equal(constraints.hardMaxLeverage, 200);
  assert.match(constraints.note, /账户|KYC|档位/);
});

test("automatic and manual risk remain inside the configured minimum/maximum interval", () => {
  const reduced = buildPaperCandidate(paperReport({ strategy: { riskPct: 0.005 } }), { cash_cny: 1_000 });
  const manual = buildPaperCandidate(paperReport({ strategy: { riskPct: 0.5 } }), { cash_cny: 1_000 }, {
    ...RUNTIME_SETTINGS_DEFAULTS,
    riskMode: "MANUAL", riskMinPct: 0.005, riskMaxPct: 0.10, riskManualPct: 0.08,
    riskPerTradePct: 0.08, maxTotalRiskPct: 0.20
  });
  assert.ok(reduced && manual);
  assert.ok(reduced.riskBudgetCny / 1_000 >= RUNTIME_SETTINGS_DEFAULTS.riskMinPct);
  assert.ok(reduced.riskPct <= RUNTIME_SETTINGS_DEFAULTS.riskMaxPct);
  assert.ok(manual.riskPct <= 0.08);
  assert.ok(reduced.expectedLossCny < manual.expectedLossCny);
});

test("default blocks duplicate positions and controlled pyramiding requires favorable high-quality progress", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport());
    db.openPosition(directCandidate(), snapshotId);
    const blocked = evaluatePaperEntry(db, paperReport({
      generatedAt: "2026-08-21T01:15:00.000Z",
      currentPrice: 103,
      latest15mBar: { ...paperReport().latest15mBar, timestamp: paperReport().latest15mBar.timestamp + 900_000 }
    }));
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reasons.join(" "), /加仓已关闭/);

    db.updateRuntimeSettings({ allowPyramiding: true, maxOpenPositions: 2 }, { source: "TEST" });
    const addReport = paperReport({
      generatedAt: "2026-08-21T01:15:00.000Z",
      currentPrice: 103,
      plan: { entryPrice: 103, stopLoss: 97, takeProfit: [117, 120], riskReward: [2.2, 2.8] },
      latest15mBar: { ...paperReport().latest15mBar, timestamp: paperReport().latest15mBar.timestamp + 900_000 },
      opportunities: { ...paperReport().opportunities, LONG: { ...paperReport().opportunities.LONG, score: 82 } }
    });
    const allowed = evaluatePaperEntry(db, addReport);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.candidate.isAddOn, true);
    assert.equal(allowed.candidate.portfolioAfter.positionCount, 2);
    assert.ok(allowed.candidate.portfolioAfter.totalRiskPct <= allowed.settings.maxTotalRiskPct);
    assert.ok(allowed.candidate.portfolioAfter.totalMarginPct <= allowed.settings.maxMarginUsagePct);
    const addSnapshotId = db.insertSnapshot(addReport);
    db.openPosition(allowed.candidate, addSnapshotId, { settingsUpdatedAt: allowed.settings.updatedAt });
    const grouped = db.getOpenPositions();
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].position_group_id, grouped[1].position_group_id);
    assert.equal(grouped[0].stop_loss, 95, "旧腿保留自己的止损，不被新腿覆盖");
    assert.equal(grouped[1].stop_loss, allowed.candidate.stopLoss);
    assert.equal(grouped[0].take_profit, 111, "旧腿保留自己的止盈");
    assert.notEqual(grouped[0].liquidation_price_estimate, grouped[1].liquidation_price_estimate, "每腿保留独立强平估算");
    assert.equal(grouped[1].liquidation_price_estimate, allowed.candidate.liquidationPriceEstimate);
    assert.equal(grouped[0].management.events.at(-1).type, "PORTFOLIO_REBASED");
  } finally {
    db.close();
  }
});

test("WAIT, data gates, manual pause, daily loss and loss streak block new entries", () => {
  const db = new PaperDatabase(":memory:");
  try {
    assert.equal(evaluatePaperEntry(db, paperReport({ decision: "WAIT", candidateDecision: "WAIT" })).allowed, false);
    assert.equal(evaluatePaperEntry(db, paperReport({ riskGates: ["核心K线过期"] })).allowed, false);
    db.updateRuntimeSettings({ newEntriesPaused: true }, { source: "TEST" });
    const paused = evaluatePaperEntry(db, paperReport());
    assert.equal(paused.allowed, false);
    assert.match(paused.reasons.join(" "), /管理员已暂停/);
  } finally {
    db.close();
  }
});

test("three consecutive losses and 3% daily loss pause entries for the Shanghai day", () => {
  const db = new PaperDatabase(":memory:");
  try {
    db.updateRuntimeSettings({
      dailyLossMode: "MANUAL", dailyLossManualPct: 0.03,
      lossStreakMode: "MANUAL", lossStreakManual: 3
    }, { source: "TEST" });
    for (let index = 0; index < 3; index += 1) {
      const openedAt = `2026-08-21T0${index + 1}:00:00.000Z`;
      const snapshotId = db.insertSnapshot(paperReport({ generatedAt: openedAt }));
      const position = db.openPosition(directCandidate({ openedAt, entryBarTs: 1_000 + index }), snapshotId);
      closeLoss(db, position, `2026-08-21T0${index + 1}:05:00.000Z`, -10);
    }
    const state = getDailyRiskState(db, "2026-08-21T05:00:00.000Z");
    assert.equal(state.consecutiveLosses, 3);
    assert.equal(state.paused, true);
    assert.match(state.pauseReasons.join(" "), /连续亏损 3 笔|当日损失/);
  } finally {
    db.close();
  }
});

test("SL/TP collisions choose SL and adverse slippage is recorded separately", () => {
  const position = {
    side: "LONG", entry_bar_ts: 1_000, signal_entry_price: 100, entry_price: 100.02,
    stop_loss: 95, take_profit: 111, quantity_btc: 0.01, liquidation_price_estimate: 50
  };
  const exit = evaluatePaperExit(position, paperReport({
    generatedAt: "2026-08-21T02:00:00.000Z",
    currentPrice: 105,
    latest15mBar: { timestamp: 2_000, open: 100, low: 94, high: 112 }
  }));
  assert.equal(exit.exitReason, "SL");
  assert.equal(exit.exitTriggerPrice, 95);
  assert.ok(exit.exitPrice < exit.exitTriggerPrice);
  assert.ok(exit.exitSlippageCny > 0);
  assert.equal(exit.conservativeSameBar, true);
});

test("entry bar is ignored, SHORT TP uses adverse buy slippage, and funding follows public rate", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const openedAt = "2026-08-21T00:01:00.000Z";
    const snapshotId = db.insertSnapshot(paperReport({ generatedAt: openedAt }));
    const position = db.openPosition(directCandidate({
      side: "SHORT", openedAt, entryBarTs: 2_000, signalEntryPrice: 100,
      entry: 99.98, stopLoss: 105, takeProfit: 89, notionalCny: 100,
      liquidationPriceEstimate: 150
    }), snapshotId);
    assert.equal(evaluatePaperExit(position, paperReport({ currentPrice: 100, latest15mBar: { timestamp: 2_000, low: 80, high: 120 } })), null);
    const funded = applyDueFunding(db, position, paperReport({
      generatedAt: "2026-08-21T08:01:00.000Z",
      derivatives: { fundingRatePct: 0.01 }
    }));
    assert.equal(funded.settlements[0].cashflowCny, 0.01);
    const exit = evaluatePaperExit(funded.position, paperReport({
      generatedAt: "2026-08-21T08:15:00.000Z",
      currentPrice: 88,
      latest15mBar: { timestamp: 3_000, open: 100, low: 88, high: 101 }
    }));
    assert.equal(exit.exitReason, "TP");
    assert.equal(exit.exitTriggerPrice, 89);
    assert.ok(exit.exitPrice > 89);
  } finally {
    db.close();
  }
});

test("funding boundaries are UTC 00/08/16 and missing funding never fabricates a settlement", () => {
  assert.deepEqual(
    fundingBoundaries("2026-08-20T23:00:00.000Z", "2026-08-21T16:01:00.000Z"),
    ["2026-08-21T00:00:00.000Z", "2026-08-21T08:00:00.000Z", "2026-08-21T16:00:00.000Z"]
  );
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport());
    const position = db.openPosition(directCandidate(), snapshotId);
    const skipped = applyDueFunding(db, position, paperReport({ derivatives: {} }));
    assert.equal(skipped.settlements.length, 0);
    assert.match(skipped.skipped, /不可用/);
  } finally {
    db.close();
  }
});

test("performance separates direction, gross profit, costs, net profit, leverage and margin", () => {
  const db = new PaperDatabase(":memory:");
  try {
    const firstId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" }));
    const first = db.openPosition(directCandidate({ openedAt: "2026-08-21T01:00:00.000Z", entryBarTs: 1_000 }), firstId);
    db.applyFunding(first.id, -0.02, "2026-08-21T08:00:00.000Z", {});
    db.closePosition(first.id, { closedAt: "2026-08-21T09:00:00.000Z", exitPrice: 111, exitReason: "TP", grossPnlCny: 10, exitFeeCny: 0.1, exitSlippageCny: 0.02 });

    const secondId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T10:00:00.000Z" }));
    const second = db.openPosition(directCandidate({ side: "SHORT", openedAt: "2026-08-21T10:00:00.000Z", entryBarTs: 2_000, leverage: 3, marginUsagePct: 0.01 }), secondId);
    db.closePosition(second.id, { closedAt: "2026-08-21T11:00:00.000Z", exitPrice: 105, exitReason: "SL", grossPnlCny: -5, exitFeeCny: 0.1, exitSlippageCny: 0.02 });

    const result = calculatePerformance(db);
    assert.equal(result.totalTrades, 2);
    assert.equal(result.longTrades, 1);
    assert.equal(result.shortTrades, 1);
    assert.equal(result.winRatePct, 50);
    assert.ok(result.averageProfitCny > 0);
    assert.ok(result.averageLossCny < 0);
    assert.equal(result.averageLeverage, 2.5);
    assert.equal(result.maxLeverage, 3);
    assert.equal(result.feesCny, 0.4);
    assert.equal(result.slippageCny, 0.04);
    assert.equal(result.fundingCny, -0.02);
    assert.ok(result.grossPnlCny > result.cumulativePnlCny);
  } finally {
    db.close();
  }
});

test("Shanghai day boundary resets loss streak and account state restores open margin", () => {
  assert.equal(shanghaiDayStartIso("2026-08-21T15:59:59.000Z"), "2026-08-20T16:00:00.000Z");
  assert.equal(shanghaiDayStartIso("2026-08-21T16:00:00.000Z"), "2026-08-21T16:00:00.000Z");
  const db = new PaperDatabase(":memory:");
  try {
    const snapshotId = db.insertSnapshot(paperReport({ generatedAt: "2026-08-21T15:00:00.000Z" }));
    const position = db.openPosition(directCandidate({ openedAt: "2026-08-21T15:00:00.000Z" }), snapshotId);
    const state = calculateAccountState(db, 101);
    assert.equal(state.positions.length, 1);
    assert.equal(state.marginUsedCny, 3.6);
    closeLoss(db, position, "2026-08-21T15:30:00.000Z");
    assert.equal(getDailyRiskState(db, "2026-08-21T16:01:00.000Z").consecutiveLosses, 0);
  } finally {
    db.close();
  }
});
