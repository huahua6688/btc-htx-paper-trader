import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PAPER_CONFIG,
  PAPER_EXCHANGE_CONSTRAINTS,
  RUNTIME_SETTINGS_DEFAULTS
} from "../src/config.mjs";
import { PaperDatabase } from "../src/db.mjs";
import { resolveExchangeConstraints } from "../src/exchange-constraints.mjs";
import { buildPaperCandidate, buildPaperCandidateResult, evaluatePaperEntry } from "../src/paper-engine.mjs";
import { applyDynamicLimits, materializeRuntimeSettings } from "../src/runtime-settings.mjs";
import { classifyDataQuality, DATA_POLICIES, DATA_STATUS } from "../src/data-quality.mjs";
import { applyTieredDataPolicy, DATA_TIERED_PARAMETERS } from "../src/data-tiered-strategy.mjs";
import { paperReport } from "./helpers.mjs";

const constraints = resolveExchangeConstraints({}, PAPER_EXCHANGE_CONSTRAINTS);
const staticSettings = materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS });

function withTempDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-dynamic-"));
  const db = new PaperDatabase(join(directory, "paper.sqlite"));
  try {
    return work(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function sizingReport(overrides = {}) {
  return {
    symbol: "BTC-USDT",
    decision: "LONG",
    generatedAt: "2026-08-24T00:00:00.000Z",
    currentPrice: 100_000,
    plan: { stopLoss: 99_000, takeProfit: [102_800] },
    opportunities: { LONG: { score: 88 }, SHORT: { score: 50 } },
    timeframes: { "1h": { atr14: 1_000 } },
    derivatives: { fundingRatePct: 0.01 },
    strategy: { riskPct: 0.01 },
    latest15mBar: { timestamp: 1_756_000_000_000 },
    bullishReasons: ["integration"],
    ...overrides
  };
}

function size(settings, equityCny, reportOverrides = {}) {
  return buildPaperCandidateResult(
    sizingReport(reportOverrides),
    { equityCny },
    settings,
    constraints,
    [],
    PAPER_CONFIG,
    []
  );
}

// ------------------------------------------------- 1. 动态限额必须真正进入执行层

test("a dynamic single-trade risk ceiling well below the static one binds the risk budget", () => {
  const equity = 20_000;
  const loose = size(staticSettings, equity).candidate;
  const tight = size({ ...staticSettings, riskPerTradePct: 0.002 }, equity).candidate;
  assert.ok(loose && tight);
  // 0.2% × 20,000 = 40 CNY，必须是真正的硬上限。
  assert.ok(tight.riskBudgetCny <= equity * 0.002 + 1e-6,
    `riskBudget ${tight.riskBudgetCny} 超过动态上限 ${equity * 0.002}`);
  assert.ok(tight.riskBudgetCny < loose.riskBudgetCny, "动态上限必须真的收紧，而不是只在 UI 显示");
  assert.ok(tight.quantityBtc < loose.quantityBtc);
});

test("the dynamic risk ceiling wins over the riskMin floor", () => {
  // 动态上限低于用户区间下限时，上限必须赢：否则下限会把它顶回去，等于没生效。
  const equity = 20_000;
  const ceiling = 0.002;
  assert.ok(ceiling < staticSettings.riskMinPct, "本用例要求上限确实低于 riskMin");
  const candidate = size({ ...staticSettings, riskPerTradePct: ceiling }, equity).candidate;
  assert.ok(candidate);
  assert.ok(candidate.riskBudgetCny <= equity * ceiling + 1e-6,
    `riskMin ${staticSettings.riskMinPct} 把动态上限 ${ceiling} 顶回去了`);
});

test("AUTO leverage uses the dynamic userMaxLeverage, not the static leverageMax", () => {
  const equity = 20_000;
  const loose = size(staticSettings, equity).candidate;
  const tight = size({ ...staticSettings, userMaxLeverage: 1.5 }, equity).candidate;
  assert.ok(loose && tight);
  assert.equal(tight.sizing.leverageCap, 1.5, "杠杆上限必须来自动态 userMaxLeverage");
  assert.ok(tight.leverage <= 1.5 + 1e-9, `杠杆 ${tight.leverage} 越过了动态上限 1.5`);
  assert.ok(loose.sizing.leverageCap > 1.5, "静态设置下上限本应高得多，说明用例确实在收紧");
});

test("MANUAL leverage still uses the manual value", () => {
  const manual = materializeRuntimeSettings({
    ...RUNTIME_SETTINGS_DEFAULTS,
    leverageMode: "MANUAL", leverageMin: 1, leverageMax: 200, leverageManual: 3
  });
  const candidate = size(manual, 20_000).candidate;
  assert.ok(candidate);
  assert.ok(candidate.leverage <= 3 + 1e-9);
  assert.ok(candidate.sizing.leverageCap <= 3 + 1e-9);
});

test("dynamic margin, notional and totalRisk ceilings each bind the candidate", () => {
  const equity = 20_000;
  const cases = [
    ["maxMarginUsagePct", 0.05, (c) => c.marginCny <= equity * 0.05 + 0.01],
    ["maxTotalNotionalMultiple", 0.5, (c) => c.notionalCny <= equity * 0.5 + 0.01],
    ["maxTotalRiskPct", 0.003, (c) => c.expectedLossCny <= equity * 0.003 + 0.01]
  ];
  for (const [key, value, holds] of cases) {
    const { candidate } = size({ ...staticSettings, [key]: value }, equity);
    assert.ok(candidate, `${key}=${value} 应当仍能构造仓位`);
    assert.ok(holds(candidate), `${key}=${value} 没有真正约束仓位`);
  }
});

test("end to end: what evaluatePaperEntry reports as the dynamic limits is exactly what sized the position", () => {
  withTempDatabase((db) => {
    const gate = evaluatePaperEntry(db, paperReport());
    assert.equal(gate.allowed, true, `gate 应当放行，实际拒绝原因：${gate.reasonCodes.join(",")}`);
    const limits = gate.dynamicLimits;
    const candidate = gate.candidate;
    const equity = candidate.accountEquityCny;

    // 用例前提：动态值确实明显低于静态区间上限，否则这个测试没有意义。
    assert.ok(limits.margin.value < limits.margin.maximum);
    assert.ok(limits.leverage.value < limits.leverage.maximum);
    assert.ok(limits.notional.value < limits.notional.maximum);
    assert.ok(limits.risk.value < limits.risk.maximum);

    // Telegram 展示的「本轮实际值」必须就是建仓真正用的值。
    assert.ok(candidate.riskBudgetCny <= equity * limits.risk.value + 0.01,
      `riskBudget ${candidate.riskBudgetCny} > 展示的单笔风险上限 ${equity * limits.risk.value}`);
    assert.ok(candidate.marginCny <= equity * limits.margin.value + 0.01,
      `margin ${candidate.marginCny} > 展示的保证金上限 ${equity * limits.margin.value}`);
    assert.ok(candidate.notionalCny <= equity * limits.notional.value + 0.01,
      `notional ${candidate.notionalCny} > 展示的名义仓位上限 ${equity * limits.notional.value}`);
    assert.ok(candidate.leverage <= limits.leverage.value + 1e-9,
      `leverage ${candidate.leverage} > 展示的杠杆上限 ${limits.leverage.value}`);
    assert.ok(candidate.expectedLossCny <= equity * limits.totalRisk.value + 0.01,
      `expectedLoss ${candidate.expectedLossCny} > 展示的总风险上限 ${equity * limits.totalRisk.value}`);

    // 而且必须严格低于静态上限，证明走的是动态值而不是区间最大值。
    assert.ok(candidate.marginCny < equity * limits.margin.maximum,
      "仓位仍然按静态 margin 上限计算，动态限额没有进入执行层");
  });
});

test("applyDynamicLimits keeps the reported limit and the applied setting identical", () => {
  const contexts = [
    { equityCny: 1_000, opportunityScore: 95, volatilityPct: 0.004, stopDistancePct: 0.004 },
    { equityCny: 50_000, opportunityScore: 61, volatilityPct: 0.05, stopDistancePct: 0.04, drawdownPct: 0.15, lossStreak: 3 },
    { equityCny: 10_000, opportunityScore: 75, volatilityPct: 0.02, stopDistancePct: 0.02, positionCount: 1 }
  ];
  for (const context of contexts) {
    const { settings, limits } = applyDynamicLimits(staticSettings, context);
    for (const item of Object.values(limits)) {
      assert.equal(settings[item.key], item.value,
        `${item.key}: 展示值 ${item.value} 与实际生效值 ${settings[item.key]} 不一致`);
    }
    assert.ok(settings.riskPerTradePct <= settings.maxTotalRiskPct + 1e-12);
  }
});

// ------------------------------------------------- 2. DATA_DEGRADED 必须真正收缩仓位

test("the data degradation risk multiplier actually shrinks the risk budget", () => {
  const equity = 20_000;
  const ok = size(staticSettings, equity).candidate;
  const degraded = size(staticSettings, equity, { dataPolicy: { riskMultiplier: 0.6 } }).candidate;
  assert.ok(ok && degraded);
  assert.ok(Math.abs(degraded.riskBudgetCny / ok.riskBudgetCny - 0.6) < 1e-6,
    `riskMultiplier=0.6 应当把风险预算缩到 60%，实际比例 ${degraded.riskBudgetCny / ok.riskBudgetCny}`);
  assert.ok(degraded.quantityBtc < ok.quantityBtc, "降级后仓位必须更小");
  assert.ok(degraded.expectedLossCny < ok.expectedLossCny, "降级后允许亏损必须更小");
});

test("end to end: classifyDataQuality -> applyTieredDataPolicy -> evaluatePaperEntry really lowers risk", () => {
  withTempDatabase((db) => {
    // 两轮行情除了「盘口缺失」以外完全相同，方向、评分、计划、Funding 都不变，
    // 因此风险预算的任何差异只可能来自数据降级系数。
    const completeDerivatives = {
      fundingRatePct: 0.01,
      oiUsd: 1_000_000,
      pressureScore: 20,
      orderBook: { bestBid: 99.9, bestAsk: 100.1 },
      eliteAccountRatio: 1.1,
      elitePositionRatio: 1.2,
      markPrice: 100.05,
      basisPct: 0.02,
      pressureComponentsAvailable: 5
    };
    // paperReport 本身不带多周期结构；补齐后核心层才完整（否则会命中 CRITICAL 硬阻断）。
    const completeTimeframes = {
      "15m": { close: 100, atr14: 1.2 },
      "1h": { close: 100, atr14: 2 },
      "4h": { close: 100, atr14: 4 },
      "1d": { close: 100, atr14: 8 }
    };
    const healthy = paperReport({ derivatives: completeDerivatives, timeframes: completeTimeframes });
    const healthyQuality = classifyDataQuality(healthy, {}, { policy: DATA_POLICIES.TIERED_DEGRADED });
    assert.equal(healthyQuality.status, DATA_STATUS.OK);
    assert.equal(healthyQuality.riskMultiplier, 1);
    const okGate = evaluatePaperEntry(db, healthy);
    assert.equal(okGate.allowed, true);

    const degradedBase = paperReport({
      derivatives: { ...completeDerivatives, orderBook: null },
      timeframes: completeTimeframes
    });
    const quality = classifyDataQuality(degradedBase, { collectionWarnings: ["depth: timeout"] }, {
      policy: DATA_POLICIES.TIERED_DEGRADED
    });
    assert.equal(quality.status, DATA_STATUS.DEGRADED, "本用例需要一个 DEGRADED 而不是 BLOCKED 的场景");
    assert.ok(quality.riskMultiplier < 1);

    const policed = applyTieredDataPolicy(degradedBase, {}, quality, DATA_TIERED_PARAMETERS, PAPER_CONFIG);
    assert.equal(policed.dataPolicy.riskMultiplier, quality.riskMultiplier);
    assert.equal(policed.decision, "LONG", "降级不应改变已经成立的方向判断");

    const degradedGate = evaluatePaperEntry(db, policed);
    assert.equal(degradedGate.allowed, true, `降级后仍应可入场：${degradedGate.reasonCodes.join(",")}`);

    // 关键断言：真正建仓的风险确实下降，而不是只在 report 里记了一个数字。
    assert.ok(degradedGate.candidate.riskBudgetCny < okGate.candidate.riskBudgetCny,
      `降级后的风险预算 ${degradedGate.candidate.riskBudgetCny} 没有低于 DATA_OK 的 ${okGate.candidate.riskBudgetCny}`);
    const ratio = degradedGate.candidate.riskBudgetCny / okGate.candidate.riskBudgetCny;
    // 预算按 4 位小数落库，这里用相对容差比较。
    assert.ok(Math.abs(ratio - quality.riskMultiplier) < 1e-4,
      `风险缩减比例 ${ratio} 与 riskMultiplier ${quality.riskMultiplier} 不一致`);
  });
});

test("a zero risk multiplier cannot open a position", () => {
  const { candidate, rejection } = size(staticSettings, 20_000, { dataPolicy: { riskMultiplier: 0 } });
  assert.equal(candidate, null);
  assert.equal(rejection.code, "RISK_BUDGET_ZERO");
  assert.equal(rejection.metrics.dataRiskMultiplier, 0);
});

test("an absent dataPolicy leaves sizing untouched", () => {
  const equity = 20_000;
  const plain = size(staticSettings, equity).candidate;
  const explicitOne = size(staticSettings, equity, { dataPolicy: { riskMultiplier: 1 } }).candidate;
  assert.equal(plain.riskBudgetCny, explicitOne.riskBudgetCny);
  assert.equal(plain.quantityBtc, explicitOne.quantityBtc);
});

test("buildPaperCandidate keeps returning a bare candidate for callers that expect it", () => {
  assert.ok(buildPaperCandidate(sizingReport(), { equityCny: 20_000 }, staticSettings, constraints, [], PAPER_CONFIG, []));
});
