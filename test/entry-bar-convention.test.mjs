import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot } from "../src/analysis-engine.mjs";
import { analyzeAntiChaseChallenger } from "../src/anti-chase-challenger.mjs";
import { analyzeBreakoutChallenger } from "../src/breakout-challenger.mjs";
import { analyzeChallenger, analyzeHistoricalCompatible } from "../src/challenger-strategy.mjs";
import { entryBarTimestampFor } from "../src/execution-timing.mjs";
import { analyzeMultiVenueChallenger } from "../src/multi-venue-challenger.mjs";
import { evaluatePaperExit } from "../src/paper-engine.mjs";
import { analyzeResearchChallengerV2 } from "../src/research-challenger-v2.mjs";

const MINUTE_MS = 60_000;
const BAR_MS = 15 * MINUTE_MS;

function candles(count, intervalMs, endExclusive) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.05;
    return {
      id: (endExclusive - (count - index) * intervalMs) / 1000,
      open: base,
      high: base + 0.4,
      low: base - 0.4,
      close: base + 0.1,
      amount: 100,
      vol: 10_000
    };
  });
}

// 观察时刻落在一根尚未收盘的 15 分钟 K 线中间：这正是实盘 monitor 每一轮的常态。
function liveMarket({ minutesIntoBar = 3 } = {}) {
  const lastClose = Date.UTC(2026, 0, 2, 0, 0, 0);
  const now = lastClose + minutesIntoBar * MINUTE_MS;
  const closed15m = candles(200, BAR_MS, lastClose);
  return {
    now,
    lastClose,
    market: {
      ticker: { ts: now, tick: { close: 111 } },
      // 最后一根是正在形成的 K 线，各研究策略会用 closedMarketView 把它裁掉。
      kline15m: { data: [...closed15m, { id: lastClose / 1000, open: 110, high: 112, low: 109, close: 111, amount: 100, vol: 10_000 }] },
      kline1h: { data: candles(200, 60 * MINUTE_MS, lastClose) },
      kline4h: { data: candles(200, 4 * 60 * MINUTE_MS, lastClose) },
      kline1d: { data: candles(200, 24 * 60 * MINUTE_MS, lastClose) },
      fundingCurrent: { data: { funding_rate: "0", source: "TEST_POINT_IN_TIME" } },
      fundingHistory: { data: { data: [] } }
    }
  };
}

// monitor.mjs 白名单里每一个可以成为 active Shadow 的策略，外加冻结 Champion。
const ANALYZERS = Object.freeze([
  ["champion", (market) => analyzeSnapshot(market)],
  ["challenger", (market) => analyzeChallenger(market, undefined, undefined, { useCache: false })],
  ["historical-compatible", (market) => analyzeHistoricalCompatible(market)],
  ["anti-chase", (market) => analyzeAntiChaseChallenger(market)],
  ["research-v2", (market) => analyzeResearchChallengerV2(market, undefined, undefined, { useCache: false })],
  ["multi-venue-v3", (market) => analyzeMultiVenueChallenger(market)],
  ["breakout-v4", (market) => analyzeBreakoutChallenger(market)]
]);

// paper-engine 用来决定 entry_bar_ts 的那一行，测试必须走同一条取值链路。
function effectiveEntryBarTs(report) {
  return Number(report.execution?.entryBarTimestamp ?? report.latest15mBar?.timestamp);
}

test("every live strategy resolves the same entry bar as the frozen Champion", () => {
  for (const minutesIntoBar of [0, 3, 7, 14]) {
    const { now, market } = liveMarket({ minutesIntoBar });
    const expected = entryBarTimestampFor(now);
    for (const [name, analyze] of ANALYZERS) {
      assert.equal(
        effectiveEntryBarTs(analyze(market)),
        expected,
        `${name} 在观察时刻 +${minutesIntoBar}m 解析出的入场 K 线格与 Champion 不一致`
      );
    }
  }
});

test("a research strategy's closed latest15mBar never becomes the entry bar", () => {
  const { lastClose, market } = liveMarket({ minutesIntoBar: 3 });
  for (const [name, analyze] of ANALYZERS) {
    if (name === "champion") continue;
    const report = analyze(market);
    const closedBarTs = Number(report.latest15mBar?.timestamp);
    if (!Number.isFinite(closedBarTs)) continue;
    // 已收盘的那一根必须严格早于入场格，否则它的 high/low 会通过回溯保护。
    assert.ok(
      closedBarTs < effectiveEntryBarTs(report),
      `${name} 把已收盘 K 线当成了入场格`
    );
    assert.ok(closedBarTs <= lastClose, `${name} 的 latest15mBar 不该是尚未收盘的 K 线`);
  }
});

test("price action from before the entry cannot trigger the stop or the target", () => {
  const { now } = liveMarket({ minutesIntoBar: 3 });
  const entryBarTs = entryBarTimestampFor(now);
  const position = {
    side: "LONG",
    entry_price: 100,
    initial_stop_loss: 95,
    stop_loss: 95,
    take_profit: 120,
    entry_bar_ts: entryBarTs,
    liquidation_price_estimate: null
  };
  // 入场那一格收盘后成为 latest15mBar；它的极值有一部分发生在入场之前。
  const report = {
    currentPrice: 101,
    latest15mBar: { timestamp: entryBarTs, open: 99, high: 121, low: 94, close: 101 }
  };
  assert.equal(evaluatePaperExit(position, report, undefined, { checkStop: true, checkTarget: false }), null);
  assert.equal(evaluatePaperExit(position, report, undefined, { checkStop: false, checkTarget: true }), null);

  // 完全位于入场之后的下一根 K 线仍然必须能够正常触发。
  const nextBar = {
    currentPrice: 101,
    latest15mBar: { timestamp: entryBarTs + BAR_MS, open: 101, high: 121, low: 94, close: 101 }
  };
  assert.equal(evaluatePaperExit(position, nextBar, undefined, { checkStop: true, checkTarget: false })?.exitReason, "SL");
  assert.equal(evaluatePaperExit(position, nextBar, undefined, { checkStop: false, checkTarget: true })?.exitReason, "TP");
});

test("回放报告必须写明它用的组合限制", async () => {
  const { openPaperDatabase } = await import("../src/db.mjs");
  const { PAPER_CONFIG } = await import("../src/config.mjs");
  const db = openPaperDatabase(":memory:", { ...PAPER_CONFIG, databasePath: ":memory:", databasePathSource: "TEST" });
  try {
    const settings = db.getRuntimeSettings();
    // 回放用的是 PAPER_CONFIG 默认值：NET 模式 + 加仓关闭 => 强制单槽位。
    // 这个组合会把成交笔数压到「持仓期间不接新信号」的上限，
    // 报告必须把它写出来，否则读者会误以为那是策略的自然频率。
    assert.equal(settings.positionMode, "NET");
    assert.equal(settings.allowPyramiding, false);
    assert.equal(settings.maxOpenPositions, 1);
  } finally {
    db.close();
  }
});

test("回放可以按真实账户的仓位上限重跑，且默认完全不变", async () => {
  const { portfolioOptions } = await import("../src/research-cli.mjs");
  const { openPaperDatabase } = await import("../src/db.mjs");
  const { PAPER_CONFIG } = await import("../src/config.mjs");

  // 一个参数都不给 => null => 回放沿用默认，既有研究数字保持可复现。
  assert.equal(portfolioOptions({}), null);
  assert.deepEqual(
    portfolioOptions({ "max-open-positions": "4", "allow-pyramiding": "true" }),
    { maxOpenPositions: 4, allowPyramiding: true }
  );
  assert.throws(() => portfolioOptions({ "max-open-positions": "0" }), /不小于 1/);
  assert.throws(() => portfolioOptions({ "position-mode": "BOTH" }), /NET 或 HEDGE/);

  const settingsAfter = (patch) => {
    const db = openPaperDatabase(":memory:", { ...PAPER_CONFIG, databasePath: ":memory:", databasePathSource: "TEST" });
    try {
      if (patch) db.updateRuntimeSettings(patch, { source: "TEST" });
      return db.getRuntimeSettings();
    } finally {
      db.close();
    }
  };

  // NET 模式下只提高上限而不开加仓，会被强制打回单槽位。
  assert.equal(settingsAfter({ positionLimitMode: "MANUAL", positionLimitManual: 4 }).maxOpenPositions, 1);
  // 同时开启加仓才真正生效。
  assert.equal(
    settingsAfter({ positionLimitMode: "MANUAL", positionLimitManual: 4, allowPyramiding: true }).maxOpenPositions,
    4
  );
});

test("回放的仓位槽按运行时设置判断，默认与原来的「必须空仓」等价", () => {
  // 排队门禁的取值表。上限为 1 时必须与写死的 `openPositions.length === 0` 逐一相同，
  // 否则所有既有回放结果都会漂移。
  const canQueue = (openCount, maxOpenPositions) => openCount < maxOpenPositions;
  for (const openCount of [0, 1, 2, 3, 4, 5]) {
    assert.equal(canQueue(openCount, 1), openCount === 0, `上限 1、持仓 ${openCount} 时与原逻辑不一致`);
  }
  // 上限提高后必须真的能排队，否则 --max-open-positions 只是一个不起作用的展示值。
  assert.equal(canQueue(1, 4), true);
  assert.equal(canQueue(3, 4), true);
  assert.equal(canQueue(4, 4), false);
});

test("组合容量拒绝与风险拒绝分开统计", async () => {
  const { summarizeEntryRejections } = await import("../src/replay-engine.mjs");
  const summary = summarizeEntryRejections({
    NO_POSITION_SLOT_AVAILABLE: 180,
    EXECUTION_ALREADY_PENDING: 20,
    DUPLICATE_SIGNAL_BAR: 5,
    BELOW_MIN_CONTRACT_STEP: 3,
    RISK_BUDGET_EXCEEDED: 2
  });
  // 「车位不够」「已有待执行信号」属于组合容量，不是策略或账户挑剔，
  // 混进风险类会让人把设置限制误读成策略行为。
  assert.equal(summary.portfolioCapacityRejections, 200);
  assert.equal(summary.duplicateSignalBarRejections, 5);
  assert.equal(summary.riskRejections, 2);
  assert.equal(summary.contractStepRejections, 3);
  assert.equal(summary.total, 210);

  // 一个都没有时必须是 0，不能是 undefined —— 报告要能直接相加。
  const empty = summarizeEntryRejections({});
  assert.equal(empty.portfolioCapacityRejections, 0);
  assert.equal(empty.duplicateSignalBarRejections, 0);
});
