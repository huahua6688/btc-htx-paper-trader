import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_CONFIG,
  PAPER_EXCHANGE_CONSTRAINTS,
  RUNTIME_SETTINGS_DEFAULTS
} from "../src/config.mjs";
import { resolveExchangeConstraints } from "../src/exchange-constraints.mjs";
import { buildPaperCandidate, buildPaperCandidateResult } from "../src/paper-engine.mjs";
import { materializeRuntimeSettings } from "../src/runtime-settings.mjs";

const settings = materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS });
const constraints = resolveExchangeConstraints({}, PAPER_EXCHANGE_CONSTRAINTS);

function sizingReport({
  price = 100_000,
  stopPct = 0.01,
  score = 75,
  side = "LONG",
  rewardMultiple = 2.8
} = {}) {
  const stop = side === "LONG" ? price * (1 - stopPct) : price * (1 + stopPct);
  const target = side === "LONG"
    ? price * (1 + stopPct * rewardMultiple)
    : price * (1 - stopPct * rewardMultiple);
  return {
    symbol: "BTC-USDT",
    decision: side,
    generatedAt: "2026-08-24T00:00:00.000Z",
    currentPrice: price,
    plan: { stopLoss: stop, takeProfit: [target] },
    opportunities: { LONG: { score }, SHORT: { score } },
    timeframes: { "1h": { atr14: price * stopPct } },
    derivatives: { fundingRatePct: 0.01 },
    strategy: { riskPct: 0.01 },
    latest15mBar: { timestamp: 1_756_000_000_000 },
    bullishReasons: ["regression"],
    bearishReasons: ["regression"]
  };
}

function size(overrides, equityCny, runtimeSettings = settings) {
  return buildPaperCandidateResult(
    sizingReport(overrides),
    { equityCny },
    runtimeSettings,
    constraints,
    [],
    PAPER_CONFIG,
    []
  );
}

test("leverage rounds up to the smallest representable value that fits the margin budget", () => {
  // 权益 5000 / 止损 1% 时 requiredLeverage = 1.620324。
  // 修复前 round(...,2) 向下舍入成 1.62，margin 变成 4000.80 > 4000 上限，
  // 于是一个完全合法的仓位被静默丢弃。
  const { candidate, rejection } = size({ stopPct: 0.01 }, 5_000);
  assert.equal(rejection, null, "向下舍入的经典案例必须能开仓");
  assert.ok(candidate, "candidate must exist");
  const availableMargin = 5_000 * settings.maxMarginUsagePct;
  assert.ok(candidate.marginCny <= availableMargin + 1e-6,
    `margin ${candidate.marginCny} 不得超过可用保证金 ${availableMargin}`);
  assert.ok(candidate.leverage >= candidate.notionalCny / availableMargin - 1e-9,
    "杠杆必须足以把名义仓位压进可用保证金");
  // 最小可表示：再降一个 0.01 步进就会越界。
  const smaller = Number((candidate.leverage - 0.01).toFixed(2));
  if (smaller >= 1) {
    assert.ok(candidate.notionalCny / smaller > availableMargin + 1e-9,
      "杠杆必须是满足约束的最小可表示值，不能无谓地放大");
  }
});

test("the position is the largest size the constraints allow, never silently undersized", () => {
  // 向下取整杠杆的第二个后果：即使有重新量化的兜底循环不让仓位违规，
  // 它也会把仓位一步步缩小。权益 5000 / 止损 1% 时，向下取整只能拿到 0.005 BTC，
  // 正确的最小可表示杠杆能拿到 0.009 BTC —— 少了 44%。
  const { candidate } = size({ stopPct: 0.01 }, 5_000);
  assert.ok(candidate);
  const s = candidate.sizing;
  const ideal = Math.floor(Math.min(s.quantityByRisk, s.quantityByNotional) / s.contractSizeBtc + 1e-12) * s.contractSizeBtc;
  assert.ok(Math.abs(candidate.quantityBtc - ideal) < 1e-9,
    `仓位被无谓缩小了：实际 ${candidate.quantityBtc}，约束允许 ${ideal}`);

  // 通用性质：再加一个合约步进就必须违反某一条约束。
  for (let equity = 2_000; equity <= 40_000; equity += 1_000) {
    for (const stopPct of [0.01, 0.015, 0.02]) {
      const result = size({ stopPct }, equity);
      if (!result.candidate) continue;
      const c = result.candidate;
      const next = c.quantityBtc + c.sizing.contractSizeBtc;
      const nextLoss = next * c.sizing.expectedLossPerBtcCny;
      const nextNotional = next * c.sizing.unitNotionalCny;
      const violates = nextLoss > c.riskBudgetCny + 0.01
        || nextNotional > c.sizing.availableNotionalCny + 0.01
        || nextNotional / c.sizing.usableLeverageCap > c.sizing.availableMarginCny + 0.01;
      assert.ok(violates,
        `equity=${equity} stop=${stopPct}: 还能再加一个合约步进却没有加，仓位被低估了`);
    }
  }
});

test("a case that rounds up naturally is unchanged", () => {
  const { candidate, rejection } = size({ stopPct: 0.01 }, 20_000);
  assert.equal(rejection, null);
  const availableMargin = 20_000 * settings.maxMarginUsagePct;
  assert.ok(candidate.marginCny <= availableMargin + 1e-6);
  assert.equal(candidate.leverage, Number(candidate.leverage.toFixed(2)));
});

test("margin never exceeds the budget across a wide equity sweep", () => {
  for (let equity = 1_000; equity <= 60_000; equity += 250) {
    for (const stopPct of [0.01, 0.012, 0.015, 0.02, 0.025]) {
      const { candidate } = size({ stopPct }, equity);
      if (!candidate) continue;
      const availableMargin = equity * settings.maxMarginUsagePct;
      assert.ok(candidate.marginCny <= availableMargin + 0.01,
        `equity=${equity} stop=${stopPct} margin=${candidate.marginCny} > ${availableMargin}`);
      assert.ok(candidate.leverage <= settings.userMaxLeverage + 1e-9, "杠杆不得越过用户上限");
      assert.ok(candidate.leverage >= 1, "杠杆不得低于 1");
      assert.ok(candidate.quantityBtc >= constraints.contractSizeBtc, "数量必须至少一个合约步进");
      assert.ok(candidate.netRr >= PAPER_CONFIG.minimumRiskReward - 1e-9, "净 RR 必须达标");
      assert.ok(candidate.expectedLossCny <= candidate.riskBudgetCny + 0.01, "预计亏损不得超预算");
    }
  }
});

test("sizing is monotonic in equity: no 1000-yes / 5000-no / 20000-yes holes", () => {
  const stopPct = 0.01;
  const equities = [];
  for (let equity = 1_000; equity <= 40_000; equity += 500) equities.push(equity);
  const outcomes = equities.map((equity) => Boolean(size({ stopPct }, equity).candidate));
  // 一旦某个权益能开仓，更高的权益也必须能开仓。
  const firstOpenIndex = outcomes.indexOf(true);
  assert.notEqual(firstOpenIndex, -1, "至少要有能开仓的权益档");
  const holes = equities.filter((equity, index) => index > firstOpenIndex && !outcomes[index]);
  assert.deepEqual(holes, [], `出现了非单调的拒绝空洞：${holes.join(", ")}`);
});

test("leverage cap binding shrinks quantity instead of emitting an illegal position", () => {
  const capped = materializeRuntimeSettings({
    ...RUNTIME_SETTINGS_DEFAULTS,
    leverageMode: "MANUAL",
    leverageMin: 1,
    leverageMax: 2,
    leverageManual: 2
  });
  for (let equity = 2_000; equity <= 30_000; equity += 500) {
    const { candidate } = size({ stopPct: 0.015 }, equity, capped);
    if (!candidate) continue;
    assert.ok(candidate.leverage <= 2 + 1e-9, `杠杆 ${candidate.leverage} 越过了 2x 上限`);
    assert.ok(candidate.marginCny <= equity * capped.maxMarginUsagePct + 0.01);
  }
});

test("margin cap binding is respected when the margin budget is tiny", () => {
  const tight = materializeRuntimeSettings({
    ...RUNTIME_SETTINGS_DEFAULTS,
    marginMode: "MANUAL",
    marginMinUsagePct: 0.01,
    marginMaxUsagePct: 0.05,
    marginManualUsagePct: 0.05
  });
  for (let equity = 1_000; equity <= 40_000; equity += 1_000) {
    const { candidate, rejection } = size({ stopPct: 0.015 }, equity, tight);
    if (!candidate) {
      assert.ok(rejection.code, "拒绝必须带原因码");
      continue;
    }
    assert.ok(candidate.marginCny <= equity * 0.05 + 0.01,
      `margin ${candidate.marginCny} 超过 5% 保证金预算`);
  }
});

test("contract step rejection is reported separately from risk and margin rejections", () => {
  // 权益很小 + 很宽的止损 → 一个最小合约的风险就超过风险预算。
  const { candidate, rejection } = size({ stopPct: 0.03 }, 1_000);
  assert.equal(candidate, null);
  assert.equal(rejection.code, "BELOW_MIN_CONTRACT_STEP");
  assert.equal(rejection.metrics.bindingConstraint, "RISK_BUDGET");
  assert.equal(rejection.metrics.contractSizeBtc, constraints.contractSizeBtc);
  assert.ok(rejection.metrics.minimumContractNotionalCny > 0);
  assert.ok(rejection.metrics.quantityByRisk < constraints.contractSizeBtc);
});

test("net RR rejection carries the attempted targets and is not conflated with sizing", () => {
  // 0.5% 止损时，往返成本吃掉太多，成本后净 RR 达不到 2。
  const { candidate, rejection } = size({ stopPct: 0.005 }, 20_000);
  assert.equal(candidate, null);
  assert.equal(rejection.code, "NO_TARGET_MEETS_NET_RR");
  assert.equal(rejection.metrics.minimumRiskReward, PAPER_CONFIG.minimumRiskReward);
  assert.ok(rejection.metrics.bestNetRr < PAPER_CONFIG.minimumRiskReward);
});

test("every rejection path returns a distinct machine-readable code", () => {
  const cases = [
    [{ decision: "WAIT" }, "DECISION_NOT_DIRECTIONAL"],
    [{ plan: null }, "PLAN_INCOMPLETE"],
    [{ plan: { stopLoss: 101_000, takeProfit: [110_000] } }, "STOP_ON_WRONG_SIDE"]
  ];
  for (const [patch, expected] of cases) {
    const report = { ...sizingReport(), ...patch };
    const { rejection } = buildPaperCandidateResult(report, { equityCny: 20_000 }, settings, constraints, [], PAPER_CONFIG, []);
    assert.equal(rejection.code, expected);
    assert.ok(rejection.message.length > 0, "原因码必须带可读中文说明");
  }
  const zeroEquity = buildPaperCandidateResult(sizingReport(), { equityCny: 0 }, settings, constraints, [], PAPER_CONFIG, []);
  assert.equal(zeroEquity.rejection.code, "EQUITY_NOT_POSITIVE");
});

test("buildPaperCandidate keeps its original null-or-candidate contract", () => {
  assert.equal(buildPaperCandidate({ ...sizingReport(), decision: "WAIT" }, { equityCny: 20_000 }), null);
  const candidate = buildPaperCandidate(sizingReport(), { equityCny: 20_000 }, settings, constraints, [], PAPER_CONFIG, []);
  assert.ok(candidate && candidate.quantityBtc > 0);
});

test("SHORT sizing obeys the same margin and leverage invariants", () => {
  for (let equity = 2_000; equity <= 40_000; equity += 1_000) {
    const { candidate } = size({ side: "SHORT", stopPct: 0.015 }, equity);
    if (!candidate) continue;
    assert.equal(candidate.side, "SHORT");
    assert.ok(candidate.marginCny <= equity * settings.maxMarginUsagePct + 0.01);
    assert.ok(candidate.stopLoss > candidate.entry, "空单止损必须在入场价之上");
  }
});
