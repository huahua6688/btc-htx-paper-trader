import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PAPER_CONFIG, RUNTIME_SETTINGS_DEFAULTS } from "../src/config.mjs";
import { PaperDatabase } from "../src/db.mjs";
import {
  classifyDataQuality,
  DATA_POLICIES,
  DATA_STATUS,
  formatDataQuality,
  PROVENANCE
} from "../src/data-quality.mjs";
import { applyTieredDataPolicy, DATA_TIERED_PARAMETERS } from "../src/data-tiered-strategy.mjs";
import {
  applyDynamicLimits,
  materializeRuntimeSettings,
  resolveDynamicLimits
} from "../src/runtime-settings.mjs";
import { calculateAccountState, evaluatePaperExit } from "../src/paper-engine.mjs";
import { collectMarketSnapshot, CORE_RETRY } from "../src/market-data.mjs";
import { collectProviderTimestamps } from "../src/market-context.mjs";
import { TelegramControlPanel } from "../src/telegram-control.mjs";
import { paperReport } from "./helpers.mjs";

function withTempDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-refactor-"));
  const db = new PaperDatabase(join(directory, "paper.sqlite"));
  try {
    return work(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function fullReport(overrides = {}) {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    currentPrice: 100_000,
    latest15mBar: { timestamp: new Date("2026-08-24T00:00:00.000Z").getTime() - 60_000 },
    timeframes: { "1h": { close: 100_000 }, "4h": { close: 100_000 }, "1d": { close: 100_000 } },
    derivatives: {
      orderBook: { bestBid: 99_990, bestAsk: 100_010 },
      fundingRatePct: 0.01,
      oiUsd: 1e9,
      eliteAccountRatio: 1.1,
      elitePositionRatio: 1.2,
      markPrice: 100_005,
      basisPct: 0.02,
      pressureComponentsAvailable: 5
    },
    dataQuality: { validForEntry: true, failures: [] },
    ...overrides
  };
}

// ---------------------------------------------------------------- B. 分级数据门禁

test("data quality is OK when every tier is present", () => {
  const quality = classifyDataQuality(fullReport(), {}, { policy: DATA_POLICIES.TIERED_DEGRADED });
  assert.equal(quality.status, DATA_STATUS.OK);
  assert.deepEqual(quality.missingKeys, []);
  assert.equal(quality.riskMultiplier, 1);
});

test("a missing critical source is a hard block under both policies", () => {
  const report = fullReport({ currentPrice: null });
  for (const policy of Object.values(DATA_POLICIES)) {
    const quality = classifyDataQuality(report, {}, { policy });
    assert.equal(quality.status, DATA_STATUS.BLOCKED, `policy=${policy}`);
    assert.equal(quality.riskMultiplier, 0);
    assert.ok(quality.missingByTier.CRITICAL.includes("price"));
  }
});

test("one missing secondary feed degrades instead of stopping everything under the tiered policy", () => {
  const report = fullReport();
  report.derivatives = { ...report.derivatives, orderBook: null };
  const strict = classifyDataQuality(report, {}, { policy: DATA_POLICIES.FROZEN_V12_STRICT });
  const tiered = classifyDataQuality(report, {}, { policy: DATA_POLICIES.TIERED_DEGRADED });
  // 冻结 V1.2 的行为必须原样保留，作为可复现 baseline。
  assert.equal(strict.status, DATA_STATUS.BLOCKED);
  // 分级政策把它降级，而不是一票否决。
  assert.equal(tiered.status, DATA_STATUS.DEGRADED);
  assert.equal(tiered.missingByTier.IMPORTANT[0], "orderBook");
  assert.ok(tiered.riskMultiplier > 0 && tiered.riskMultiplier < 1, "降级必须收缩风险预算");
  assert.ok(tiered.entryScoreBonus > 0, "降级必须提高入场质量门槛");
});

test("too much missing evidence still hard blocks under the tiered policy", () => {
  const report = fullReport();
  report.derivatives = {
    orderBook: null,
    fundingRatePct: null,
    oiUsd: null,
    eliteAccountRatio: null,
    elitePositionRatio: null,
    markPrice: null,
    basisPct: null,
    pressureComponentsAvailable: 0
  };
  const quality = classifyDataQuality(report, {}, { policy: DATA_POLICIES.TIERED_DEGRADED });
  assert.equal(quality.status, DATA_STATUS.BLOCKED);
  assert.ok(quality.hardBlockReasons.some((item) => item.includes("剩余证据不足")));
});

test("historically unavailable is distinguished from a live failure and never synthesized", () => {
  const report = fullReport({ replay: { pointInTime: true, unavailableSources: ["depth", "oiCurrent"] } });
  report.derivatives = { ...report.derivatives, orderBook: null, oiUsd: null };
  const quality = classifyDataQuality(report, {}, { policy: DATA_POLICIES.TIERED_DEGRADED });
  assert.deepEqual(quality.liveFailureKeys, []);
  assert.ok(quality.historicallyUnavailableKeys.includes("orderBook"));
  assert.ok(quality.historicallyUnavailableKeys.includes("openInterest"));
  assert.equal(quality.missing.every((item) => item.provenance === PROVENANCE.HISTORICAL_UNAVAILABLE), true);
  assert.equal(quality.unavailableNeverSynthesized, true);

  const live = fullReport();
  live.derivatives = { ...live.derivatives, orderBook: null };
  const liveQuality = classifyDataQuality(live, { collectionWarnings: ["depth: timeout"] }, {
    policy: DATA_POLICIES.TIERED_DEGRADED
  });
  assert.deepEqual(liveQuality.liveFailureKeys, ["orderBook"]);
  assert.deepEqual(liveQuality.historicallyUnavailableKeys, []);
});

test("STALE replay evidence has its own quality bucket and display label", () => {
  const report = fullReport();
  report.derivatives = { ...report.derivatives, oiUsd: null };
  const quality = classifyDataQuality(report, {
    dataProvenance: { oiCurrent: PROVENANCE.STALE, oiHistory: PROVENANCE.STALE },
    replay: { pointInTime: true, unavailableSources: ["openInterest"] }
  }, { policy: DATA_POLICIES.TIERED_DEGRADED });
  assert.ok(quality.staleKeys.includes("openInterest"));
  assert.equal(quality.historicallyUnavailableKeys.includes("openInterest"), false);
  assert.equal(quality.liveFailureKeys.includes("openInterest"), false);
  assert.match(formatDataQuality(quality), /数据过期/);
});

test("historical replay without point-in-time depth is no longer forced to WAIT forever", () => {
  const base = fullReport({
    replay: { pointInTime: true, unavailableSources: ["depth", "oiCurrent", "eliteAccount", "markPrice"] },
    decision: "WAIT",
    candidateDecision: "LONG",
    opportunities: { LONG: { score: 82 }, SHORT: { score: 50 } },
    dataQuality: { validForEntry: false, failures: ["Order Book 不完整", "Open Interest 数据不可用"] },
    riskGates: ["Order Book 不完整", "Open Interest 数据不可用"],
    plan: { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null },
    entryAssessment: { enterNow: false, missingConditions: [] },
    strategy: { marketRegime: "TRENDING" }
  });
  base.derivatives = { ...base.derivatives, orderBook: null, oiUsd: null };
  const market = {
    kline15m: { data: syntheticCandles(60, 100_000) },
    kline1h: { data: syntheticCandles(60, 100_000) }
  };
  const quality = classifyDataQuality(base, market, { policy: DATA_POLICIES.TIERED_DEGRADED });
  const policed = applyTieredDataPolicy(base, market, quality, DATA_TIERED_PARAMETERS, PAPER_CONFIG);
  assert.equal(policed.decision, "LONG", "缺少历史盘口不应让所有时点永远是 WAIT");
  assert.ok(Number.isFinite(Number(policed.plan.stopLoss)), "降级放行必须仍然能构造止损");
  assert.equal(policed.dataPolicy.championDecisionUnchanged, "WAIT", "必须记录冻结 Champion 原本的判断");
  assert.equal(policed.dataPolicy.strategyVersion, "V1.3-DATA-TIERED-CANDIDATE");
  assert.equal(policed.strategy.frozenChampionUnchanged, true);
});

test("degraded pass-through still refuses a signal that is below the raised score bar", () => {
  const base = fullReport({
    replay: { pointInTime: true, unavailableSources: ["depth"] },
    decision: "WAIT",
    candidateDecision: "LONG",
    opportunities: { LONG: { score: 61 }, SHORT: { score: 50 } },
    dataQuality: { validForEntry: false, failures: ["Order Book 不完整"] },
    riskGates: ["Order Book 不完整"],
    plan: { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null },
    entryAssessment: { enterNow: false, missingConditions: [] },
    strategy: {}
  });
  base.derivatives = { ...base.derivatives, orderBook: null };
  const market = { kline15m: { data: syntheticCandles(60, 100_000) }, kline1h: { data: syntheticCandles(60, 100_000) } };
  const quality = classifyDataQuality(base, market, { policy: DATA_POLICIES.TIERED_DEGRADED });
  const policed = applyTieredDataPolicy(base, market, quality, DATA_TIERED_PARAMETERS, PAPER_CONFIG);
  assert.equal(policed.decision, "WAIT");
  assert.ok(policed.dataPolicy.actions.some((item) => item.includes("降级放行被拒")));
});

function syntheticCandles(count, price) {
  // 仅用于单元测试构造 K 线形状，不代表任何真实行情，也不进入任何研究结论。
  return Array.from({ length: count }, (_, index) => ({
    id: Math.floor(Date.UTC(2026, 7, 1) / 1000) + index * 900,
    open: price, high: price * 1.002, low: price * 0.998, close: price, vol: 100, amount: 1, count: 10
  }));
}

// ---------------------------------------------------------------- D. 真正的 AUTO

test("AUTO limits are no longer pinned to the maximum", () => {
  const settings = materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS });
  const { limits } = resolveDynamicLimits(settings, {
    equityCny: 1_000,
    opportunityScore: 68,
    volatilityPct: 0.03,
    stopDistancePct: 0.025,
    marginUsedCny: 0,
    totalRiskCny: 0,
    grossNotionalCny: 0,
    drawdownPct: 0,
    dailyLossPct: 0,
    lossStreak: 0,
    positionCount: 0
  });
  for (const key of ["risk", "margin", "leverage", "notional"]) {
    assert.ok(limits[key].value < limits[key].maximum,
      `${key} 的 AUTO 值仍然等于区间上限（${limits[key].value}）`);
    assert.ok(limits[key].value >= limits[key].minimum, `${key} 的 AUTO 值低于区间下限`);
    assert.ok(limits[key].reasons.length > 0, `${key} 必须解释为什么选这个值`);
  }
});

test("AUTO limits respond to opportunity quality, volatility, drawdown, loss streak and crowding", () => {
  const settings = materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS });
  const base = {
    equityCny: 10_000, opportunityScore: 88, volatilityPct: 0.01, stopDistancePct: 0.01,
    marginUsedCny: 0, totalRiskCny: 0, grossNotionalCny: 0, drawdownPct: 0,
    dailyLossPct: 0, lossStreak: 0, positionCount: 0
  };
  const strong = resolveDynamicLimits(settings, base).limits;
  const weak = resolveDynamicLimits(settings, { ...base, opportunityScore: 62 }).limits;
  const volatile = resolveDynamicLimits(settings, { ...base, volatilityPct: 0.06 }).limits;
  const drawn = resolveDynamicLimits(settings, { ...base, drawdownPct: 0.18 }).limits;
  const streaking = resolveDynamicLimits(settings, { ...base, lossStreak: 5 }).limits;
  const crowded = resolveDynamicLimits(settings, { ...base, positionCount: 1 }).limits;

  assert.ok(weak.risk.value < strong.risk.value, "机会质量下降必须收缩风险");
  assert.ok(volatile.risk.value < strong.risk.value, "波动升高必须收缩风险");
  assert.ok(drawn.risk.value < strong.risk.value, "回撤必须收缩风险");
  assert.ok(streaking.risk.value < strong.risk.value, "连亏必须收缩风险");
  assert.ok(crowded.notional.value < strong.notional.value, "已有仓位必须收缩名义仓位上限");
  assert.ok(volatile.leverage.value < strong.leverage.value, "波动升高必须收缩杠杆上限");
});

test("MANUAL mode bypasses the dynamic calculation but still respects the user range", () => {
  const settings = materializeRuntimeSettings({
    ...RUNTIME_SETTINGS_DEFAULTS,
    riskMode: "MANUAL", riskMinPct: 0.005, riskMaxPct: 0.05, riskManualPct: 0.02
  });
  const { limits } = resolveDynamicLimits(settings, { equityCny: 1_000, opportunityScore: 90 });
  assert.equal(limits.risk.mode, "MANUAL");
  assert.equal(limits.risk.value, 0.02);
});

test("dynamic limits never exceed the stored ceiling that the atomic re-check uses", () => {
  const settings = materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS });
  for (const score of [60, 70, 80, 90, 100]) {
    for (const volatilityPct of [0.005, 0.01, 0.05]) {
      const { settings: applied } = applyDynamicLimits(settings, {
        equityCny: 10_000, opportunityScore: score, volatilityPct, stopDistancePct: volatilityPct
      });
      assert.ok(applied.maxMarginUsagePct <= settings.maxMarginUsagePct + 1e-12);
      assert.ok(applied.userMaxLeverage <= settings.userMaxLeverage + 1e-12);
      assert.ok(applied.maxTotalNotionalMultiple <= settings.maxTotalNotionalMultiple + 1e-12);
      assert.ok(applied.maxTotalRiskPct <= settings.maxTotalRiskPct + 1e-12);
      assert.ok(applied.riskPerTradePct <= applied.maxTotalRiskPct + 1e-12);
    }
  }
});

// ---------------------------------------------------------------- E. Telegram 鉴权

function panelFor(config) {
  const stub = {
    getRuntimeSettings: () => materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS, revision: 1 }),
    markTelegramUpdateProcessed() {}
  };
  return new TelegramControlPanel(stub, { config });
}

test("private chat stays compatible without an explicit admin user id", () => {
  const panel = panelFor({ botToken: "t", chatId: "555", adminUserId: "" });
  assert.equal(panel.authorize({ chatId: 555, senderId: 555, chatType: "private" }).allowed, true);
  // 老测试与老部署没有 from 字段，必须继续可用。
  assert.equal(panel.authorize({ chatId: 555 }).allowed, true);
});

test("a group chat without TELEGRAM_ADMIN_USER_ID cannot control anything", () => {
  const panel = panelFor({ botToken: "t", chatId: "-100999", adminUserId: "" });
  const decision = panel.authorize({ chatId: -100999, senderId: 424242, chatType: "supergroup" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /TELEGRAM_ADMIN_USER_ID/);
});

test("with an admin user id only that sender is authorised, even inside the right chat", () => {
  const panel = panelFor({ botToken: "t", chatId: "-100999", adminUserId: "777" });
  assert.equal(panel.authorize({ chatId: -100999, senderId: 777, chatType: "supergroup" }).allowed, true);
  // 同一个群里的其他成员，即使看得到按钮也不能操作。
  const other = panel.authorize({ chatId: -100999, senderId: 888, chatType: "supergroup" });
  assert.equal(other.allowed, false);
  assert.match(other.reason, /管理员本人/);
  // 缺少发送者身份时一律拒绝。
  assert.equal(panel.authorize({ chatId: -100999, chatType: "supergroup" }).allowed, false);
});

test("a foreign chat is rejected regardless of sender", () => {
  const panel = panelFor({ botToken: "t", chatId: "555", adminUserId: "777" });
  assert.equal(panel.authorize({ chatId: 556, senderId: 777, chatType: "private" }).allowed, false);
  assert.equal(panel.authorize({ chatId: null, senderId: 777 }).allowed, false);
});

test("every mutating callback path goes through the same authorisation check", async () => {
  const answered = [];
  const applied = [];
  const stub = {
    getRuntimeSettings: () => materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS, revision: 1 }),
    getLatestSnapshot: () => null,
    getOpenPositions: () => [],
    updateRuntimeSettings: (patch) => { applied.push(patch); return { settings: {}, changed: [] }; },
    markTelegramUpdateProcessed() {}
  };
  const panel = new TelegramControlPanel(stub, {
    config: { botToken: "t", chatId: "-100999", adminUserId: "777", apiBaseUrl: "x", timeoutMs: 1 },
    answer: async (_id, text) => { answered.push(text); return { ok: true }; },
    edit: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
    logger: () => {}
  });
  const mutations = [
    "paper:set:riskProfile:AGGRESSIVE",
    "paper:set:positionMode:HEDGE",
    "paper:set:newEntriesPaused:false",
    "paper:set:maxOpenPositions:5",
    "paper:adj:leverageMax:10",
    "paper:preset:autoRanges"
  ];
  for (const [index, data] of mutations.entries()) {
    await panel.handleAdminUpdate({
      update_id: index + 1,
      callback_query: {
        id: `cb${index}`,
        data,
        from: { id: 888 },
        message: { message_id: 1, chat: { id: -100999, type: "supergroup" } }
      }
    });
  }
  assert.equal(applied.length, 0, "非管理员不得改变任何设置");
  assert.equal(answered.length, mutations.length);
  assert.ok(answered.every((item) => /管理员本人/.test(item)));

  // 同一批操作换成管理员本人则会真正执行。
  await panel.handleAdminUpdate({
    update_id: 99,
    callback_query: {
      id: "ok",
      data: "paper:set:riskProfile:AGGRESSIVE",
      from: { id: 777 },
      message: { message_id: 1, chat: { id: -100999, type: "supergroup" } }
    }
  });
  assert.equal(applied.length, 1);
});

test("/pause and /set text commands are authorised the same way", async () => {
  const applied = [];
  const stub = {
    getRuntimeSettings: () => materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS, revision: 1 }),
    getOpenPositions: () => [],
    updateRuntimeSettings: (patch) => { applied.push(patch); return { settings: {}, changed: [] }; },
    markTelegramUpdateProcessed() {}
  };
  const panel = new TelegramControlPanel(stub, {
    config: { botToken: "t", chatId: "-100999", adminUserId: "777", apiBaseUrl: "x", timeoutMs: 1 },
    answer: async () => ({ ok: true }),
    edit: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
    logger: () => {}
  });
  await panel.handleAdminUpdate({
    update_id: 1,
    message: { text: "/pause", from: { id: 888 }, chat: { id: -100999, type: "supergroup" } }
  });
  await panel.handleAdminUpdate({
    update_id: 2,
    message: { text: "/set leverageMax 100", from: { id: 888 }, chat: { id: -100999, type: "supergroup" } }
  });
  assert.equal(applied.length, 0, "群里的非管理员不得通过文字命令改设置");
});

// ---------------------------------------------------------------- F1. 剩余风险的退出成本

test("open risk uses the stop-loss fill for exit cost, not the take-profit price", () => {
  withTempDatabase((db) => {
    const now = "2026-08-24T00:00:00.000Z";
    db.openPosition({
      symbol: "BTC-USDT", side: "LONG", openedAt: now, entryBarTs: 1,
      signalEntryPrice: 100_000, entry: 100_020, stopLoss: 99_000, takeProfit: 103_000,
      quantityBtc: 0.01, netRr: 2.5, rr: 2.5, accountEquityCny: 1_000,
      leverage: 1, marginCny: 720, notionalCny: 720, expectedLossCny: 80,
      expectedProfitCny: 200, riskCny: 80, entryFeeCny: 3.6, entrySlippageCny: 1.4,
      liquidationPriceEstimate: 1, openingReasons: []
    }, db.insertSnapshot(paperReport()));
    const state = calculateAccountState(db, 100_000, PAPER_CONFIG);
    const quantity = 0.01;
    const priceRisk = (100_000 - 99_000) * quantity * PAPER_CONFIG.usdtCnyRate;
    const stopFill = 99_000 * (1 - PAPER_CONFIG.slippageRate);
    const expected = priceRisk
      + stopFill * quantity * PAPER_CONFIG.usdtCnyRate * (PAPER_CONFIG.feeRatePerSide + PAPER_CONFIG.slippageRate);
    assert.ok(Math.abs(state.totalRiskCny - expected) < 0.01,
      `totalRiskCny=${state.totalRiskCny} 应当按止损成交价而不是止盈价计算退出成本`);
    // 用止盈价会明显高估剩余风险。
    const inflated = priceRisk
      + 103_000 * quantity * PAPER_CONFIG.usdtCnyRate * (PAPER_CONFIG.feeRatePerSide + PAPER_CONFIG.slippageRate);
    assert.ok(inflated > state.totalRiskCny + 0.1, "旧算法按止盈价算退出成本，确实高估了剩余风险");
  });
});

// ---------------------------------------------------------------- F2. 移动止损后的 bar 内回看

test("a freshly moved stop cannot be triggered by the same bar's earlier low", () => {
  const position = {
    side: "LONG",
    entry_bar_ts: 1_000,
    stop_effective_bar_ts: 2_000,
    stop_loss: 100_100,
    take_profit: 105_000,
    signal_entry_price: 100_000,
    entry_price: 100_000,
    quantity_btc: 0.01,
    liquidation_price_estimate: null
  };
  // 同一根 K 线（timestamp 等于止损生效时刻）：其早于止损生效的 low 不得触发新止损。
  const sameBar = {
    generatedAt: "2026-08-24T00:00:00.000Z",
    currentPrice: 100_500,
    latest15mBar: { timestamp: 2_000, open: 100_400, high: 100_800, low: 99_900, close: 100_500 }
  };
  assert.equal(evaluatePaperExit(position, sameBar, PAPER_CONFIG), null,
    "止损刚移动，同一根 K 线之前的低点不能立即把它扫出");

  // 现价真的跌破新止损时，仍然必须成交。
  const sameBarBreached = { ...sameBar, currentPrice: 100_000 };
  const breached = evaluatePaperExit(position, sameBarBreached, PAPER_CONFIG);
  assert.equal(breached.exitReason, "SL");

  // 下一根 K 线开始之后，回溯 low 恢复生效。
  const nextBar = {
    generatedAt: "2026-08-24T00:15:00.000Z",
    currentPrice: 100_500,
    latest15mBar: { timestamp: 3_000, open: 100_400, high: 100_800, low: 99_900, close: 100_500 }
  };
  const nextExit = evaluatePaperExit(position, nextBar, PAPER_CONFIG);
  assert.equal(nextExit.exitReason, "SL");
});

test("an unmoved stop keeps the original intrabar look-back behaviour", () => {
  const position = {
    side: "LONG",
    entry_bar_ts: 1_000,
    stop_effective_bar_ts: 1_000,
    stop_loss: 99_500,
    take_profit: 105_000,
    signal_entry_price: 100_000,
    entry_price: 100_000,
    quantity_btc: 0.01,
    liquidation_price_estimate: null
  };
  const report = {
    generatedAt: "2026-08-24T00:00:00.000Z",
    currentPrice: 100_500,
    latest15mBar: { timestamp: 2_000, open: 100_400, high: 100_800, low: 99_400, close: 100_500 }
  };
  assert.equal(evaluatePaperExit(position, report, PAPER_CONFIG).exitReason, "SL");
});

test("stop_effective_bar_ts is persisted on open and advanced only when the stop moves", () => {
  withTempDatabase((db) => {
    const position = db.openPosition({
      symbol: "BTC-USDT", side: "LONG", openedAt: "2026-08-24T00:00:00.000Z", entryBarTs: 4_000,
      signalEntryPrice: 100_000, entry: 100_020, stopLoss: 99_000, takeProfit: 103_000,
      quantityBtc: 0.01, netRr: 2.5, rr: 2.5, accountEquityCny: 1_000, leverage: 1,
      marginCny: 720, notionalCny: 720, expectedLossCny: 80, expectedProfitCny: 200,
      riskCny: 80, entryFeeCny: 3.6, entrySlippageCny: 1.4, liquidationPriceEstimate: 1,
      openingReasons: []
    }, db.insertSnapshot(paperReport()));
    assert.equal(Number(position.stop_effective_bar_ts), 4_000);

    const held = db.updatePositionManagement(position.id, { lastManagementBarTs: 5_000 });
    assert.equal(Number(held.stop_effective_bar_ts), 4_000, "没有移动止损时不得推进生效时刻");

    const moved = db.updatePositionManagement(position.id, {
      stopLoss: 100_100, lastManagementBarTs: 6_000, stopEffectiveBarTs: 6_000
    });
    assert.equal(Number(moved.stop_effective_bar_ts), 6_000);
  });
});

// ---------------------------------------------------------------- F4. 可嵌套事务

test("nested transactions use savepoints and an inner rollback does not destroy the outer one", () => {
  withTempDatabase((db) => {
    const before = db.getAccount().cash_cny;
    db.transaction(() => {
      db.recordMonitorRun({ startedAt: "a", finishedAt: "b", status: "OK", message: "outer" });
      assert.throws(() => db.transaction(() => {
        db.recordMonitorRun({ startedAt: "c", finishedAt: "d", status: "OK", message: "inner" });
        throw new Error("inner failure");
      }), /inner failure/);
      // 内层回滚只撤销内层的写入，外层仍然存活并可以继续写。
      db.recordMonitorRun({ startedAt: "e", finishedAt: "f", status: "OK", message: "after-inner" });
    });
    const messages = db.db.prepare("SELECT message FROM monitor_runs ORDER BY id").all().map((row) => row.message);
    assert.deepEqual(messages, ["outer", "after-inner"]);
    assert.equal(db.getAccount().cash_cny, before);
    assert.equal(db.inTransaction, false);
  });
});

test("an outer rollback still discards nested committed savepoints", () => {
  withTempDatabase((db) => {
    assert.throws(() => db.transaction(() => {
      db.transaction(() => db.recordMonitorRun({ startedAt: "a", finishedAt: "b", status: "OK", message: "nested" }));
      throw new Error("outer failure");
    }), /outer failure/);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM monitor_runs").get().count, 0);
    assert.equal(db.inTransaction, false);
  });
});

test("real nested writers compose: openPosition inside an outer transaction", () => {
  withTempDatabase((db) => {
    const snapshotId = db.insertSnapshot(paperReport());
    const position = db.transaction(() => db.openPosition({
      symbol: "BTC-USDT", side: "LONG", openedAt: "2026-08-24T00:00:00.000Z", entryBarTs: 1,
      signalEntryPrice: 100_000, entry: 100_020, stopLoss: 99_000, takeProfit: 103_000,
      quantityBtc: 0.01, netRr: 2.5, rr: 2.5, accountEquityCny: 1_000, leverage: 1,
      marginCny: 720, notionalCny: 720, expectedLossCny: 80, expectedProfitCny: 200,
      riskCny: 80, entryFeeCny: 3.6, entrySlippageCny: 1.4, liquidationPriceEstimate: 1,
      openingReasons: []
    }, snapshotId));
    assert.equal(position.status, "OPEN");
    assert.equal(db.getOpenPositions().length, 1);
  });
});

// ---------------------------------------------------------------- F5. 核心行情重试

test("a transient core failure is retried with backoff instead of failing the whole cycle", async () => {
  const attempts = {};
  const delays = [];
  const snapshot = await collectMarketSnapshot({
    concurrency: 1,
    delay: async (ms) => { delays.push(ms); },
    runner: async (skill, subcommand, params) => {
      const key = `${skill}/${subcommand}/${params.period ?? params.type ?? ""}`;
      attempts[key] = (attempts[key] ?? 0) + 1;
      if (key === "futures-market/kline/15min" && attempts[key] === 1) throw new Error("ECONNRESET");
      return { status: "ok", key };
    }
  });
  assert.equal(attempts["futures-market/kline/15min"], 2, "核心任务必须重试一次后成功");
  assert.ok(snapshot.kline15m, "重试成功后必须拿到数据");
  assert.deepEqual(delays, [CORE_RETRY.baseDelayMs], "必须使用退避而不是立即重试");
  assert.ok(snapshot.collectionRetries.some((item) => item.startsWith("kline15m:")));
});

test("retries are bounded and a persistently broken core source still fails the cycle", async () => {
  let calls = 0;
  await assert.rejects(collectMarketSnapshot({
    concurrency: 1,
    delay: async () => {},
    runner: async (skill, subcommand) => {
      if (subcommand === "kline") { calls += 1; throw new Error("HTX down"); }
      return { status: "ok" };
    }
  }), /HTX down/);
  assert.ok(calls <= CORE_RETRY.attempts * 4, "重试必须有上限，不能无限重试");
});

test("secondary sources are not retried and degrade to a warning", async () => {
  let depthCalls = 0;
  const snapshot = await collectMarketSnapshot({
    concurrency: 1,
    delay: async () => {},
    runner: async (skill, subcommand) => {
      if (subcommand === "depth") { depthCalls += 1; throw new Error("depth unavailable"); }
      return { status: "ok" };
    }
  });
  assert.equal(depthCalls, 2, "spot/futures 两个次要 depth 各调用一次且都不重试");
  assert.equal(snapshot.spotDepth, null);
  assert.equal(snapshot.depth, null);
  assert.ok(snapshot.collectionWarnings.some((item) => item.startsWith("spotDepth:")));
  assert.ok(snapshot.collectionWarnings.some((item) => item.startsWith("depth:")));
});

// ---------------------------------------------------------------- F6. schema 感知的时间戳

test("provider timestamps are read from declared schema paths, not from any field named id", () => {
  const second = Math.floor(Date.UTC(2026, 7, 1) / 1000);
  const klineStamps = collectProviderTimestamps({
    ts: Date.UTC(2026, 7, 1, 1),
    data: [{ id: second, close: 1 }, { id: second + 900, close: 2 }]
  }, "kline15m");
  assert.equal(klineStamps.length, 3, "K 线的 id 是开盘秒，必须被识别");

  // 清算流的 id 是事件编号，不是时间；只有 created_at 才是时间。
  const liquidationStamps = collectProviderTimestamps({
    ts: Date.UTC(2026, 7, 1, 1),
    data: [{ id: 1_700_000_123_456, created_at: Date.UTC(2026, 7, 1) }]
  }, "liquidations");
  assert.equal(liquidationStamps.length, 2);
  assert.ok(!liquidationStamps.includes(1_700_000_123_456), "请求/事件编号不得被当成时间戳");

  // 未声明的来源退回到只读取顶层 ts。
  assert.deepEqual(collectProviderTimestamps({ ts: Date.UTC(2026, 7, 1), data: { id: 999_999_999_999 } }, "unknown"),
    [Date.UTC(2026, 7, 1)]);
});
