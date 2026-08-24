import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDisabledLiveExchangeInterface, LIVE_EXCHANGE_OPERATIONS } from "../src/exchange-live-interface.mjs";
import { HISTORICAL_DATA_TYPES, loadHistoricalDataset, updateHistoricalDataset } from "../src/historical-data.mjs";
import { HTX_SKILL_CAPABILITIES, HTX_SKILL_NAMES, htxSkillCapabilityReport } from "../src/htx-skill-capabilities.mjs";
import {
  loadMultiVenueFundingDataset,
  pointInTimeFundingContext,
  updateMultiVenueFundingDataset
} from "../src/multi-venue-catalog.mjs";
import { analyzeMultiVenueChallenger } from "../src/multi-venue-challenger.mjs";
import { manageOpenPosition } from "../src/position-manager.mjs";
import { paperReport } from "./helpers.mjs";

const HOUR_MS = 60 * 60 * 1000;

function response(payload) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
}

test("all official HTX skill families are accounted for without enabling private trading", () => {
  const expected = [
    "spot-market", "spot-account", "spot-trading", "futures-market", "funding-rate", "oi-tracker",
    "elite-positioning", "liquidation-stream", "mark-price", "settlement", "futures-account",
    "futures-trading", "technical-analysis", "derivatives-analyst", "sentiment-analyst",
    "market-overview", "ta-master"
  ];
  assert.deepEqual([...HTX_SKILL_NAMES].sort(), expected.sort());
  const privateCapabilities = HTX_SKILL_CAPABILITIES.filter((item) => item.access.startsWith("PRIVATE"));
  assert.ok(privateCapabilities.length >= 4);
  assert.ok(privateCapabilities.every((item) => item.status === "INTERFACE_ONLY"));
  const report = htxSkillCapabilityReport();
  assert.equal(report.exchangeWriteEnabled, false);
  assert.equal(report.auditedSkillCount, 17);
  assert.ok(report.actuallyInvokedCount < report.auditedSkillCount);
  assert.equal(report.claim, "17_SKILLS_AUDITED_NOT_17_ACTUALLY_INVOKED");
  assert.equal(HTX_SKILL_CAPABILITIES.find((item) => item.skill === "spot-market").status, "ACTUALLY_INVOKED");
  assert.equal(HTX_SKILL_CAPABILITIES.find((item) => item.skill === "technical-analysis").status, "LOCAL_EQUIVALENT");
  assert.ok(HISTORICAL_DATA_TYPES.includes("settlement"));
});

test("the future live exchange port is complete but every method is disabled in Paper mode", async () => {
  const port = createDisabledLiveExchangeInterface();
  assert.equal(port.exchangeWriteEnabled, false);
  assert.equal(port.authenticationLoaded, false);
  for (const operation of LIVE_EXCHANGE_OPERATIONS) {
    assert.equal(typeof port[operation], "function");
    await assert.rejects(port[operation](), (error) => error.code === "LIVE_EXCHANGE_WRITE_DISABLED");
  }
});

test("multi-venue update persists real timestamped rows and an auditable no-auth manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multi-venue-"));
  const fromMs = Date.UTC(2025, 0, 1);
  const toMs = fromMs + 8 * HOUR_MS;
  const fetchImpl = async (url) => {
    if (url.hostname === "fapi.binance.com") return response([
      { fundingTime: fromMs, fundingRate: "0.0001", markPrice: "100000" },
      { fundingTime: toMs, fundingRate: "0.0002", markPrice: "101000" }
    ]);
    if (url.hostname === "api.bybit.com") return response({ retCode: 0, result: { list: [
      { fundingRateTimestamp: String(toMs), fundingRate: "-0.0001" },
      { fundingRateTimestamp: String(fromMs), fundingRate: "0" }
    ] } });
    if (url.hostname === "www.okx.com") return response({ code: "0", data: [
      { fundingTime: String(toMs), realizedRate: "0.00005", formulaType: "withRate" },
      { fundingTime: String(fromMs), realizedRate: "-0.00005", formulaType: "withRate" }
    ] });
    throw new Error(`unexpected host ${url.hostname}`);
  };
  try {
    const result = await updateMultiVenueFundingDataset({
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), directory, fetchImpl
    });
    assert.equal(result.manifest.status, "COMPLETE");
    assert.equal(result.manifest.authentication, "none");
    assert.equal(result.manifest.writeOperations, false);
    assert.equal(result.rows.length, 6);
    assert.ok(Object.values(result.manifest.sources).every((source) => source.pointInTime));
    const loaded = await loadMultiVenueFundingDataset(directory);
    assert.equal(loaded.funding.length, 6);
    assert.equal(loaded.manifest.sha256, result.manifest.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("point-in-time multi-venue context never sees a future settlement and expires stale venues", () => {
  const now = Date.UTC(2025, 0, 2);
  const rows = [
    { exchange: "binance", timestamp: now - HOUR_MS, visibleAt: now - HOUR_MS, fundingRate: 0.0001 },
    { exchange: "binance", timestamp: now + HOUR_MS, visibleAt: now + HOUR_MS, fundingRate: 0.5 },
    { exchange: "bybit", timestamp: now - 2 * HOUR_MS, visibleAt: now - 2 * HOUR_MS, fundingRate: -0.0001 },
    { exchange: "okx", timestamp: now - 20 * HOUR_MS, visibleAt: now - 20 * HOUR_MS, fundingRate: 0.3 }
  ];
  const context = pointInTimeFundingContext(rows, now);
  assert.equal(context.venueCount, 2);
  assert.equal(context.observations.find((item) => item.exchange === "binance").fundingRate, 0.0001);
  assert.equal(context.medianFundingRate, 0);
  assert.ok(context.observations.every((item) => item.timestamp <= now));
});

test("HTX settlement history is downloaded into the main catalog without becoming directional alpha", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-settlement-"));
  const fromMs = Date.UTC(2025, 0, 1);
  const toMs = fromMs + 15 * 60_000;
  const fetchImpl = async (url) => {
    assert.match(url.pathname, /history\/kline/);
    return response({ status: "ok", data: [
      { id: fromMs / 1000, open: 100, high: 102, low: 99, close: 101, amount: 1, vol: 100, trade_turnover: 101, count: 10 },
      { id: toMs / 1000, open: 101, high: 103, low: 100, close: 102, amount: 1, vol: 100, trade_turnover: 102, count: 10 }
    ] });
  };
  const researchClient = {
    get: async (_path, params) => ({
      payload: { status: "ok", data: { total_page: 1, settlement_record: [
        { settlement_time: fromMs, settlement_price: 100.5, settlement_type: "settlement", contract_code: "BTC-USDT" }
      ] } },
      fetchedAt: "2025-01-02T00:00:00.000Z",
      url: `https://api.hbdm.vn/mock?page=${params.page_index}`
    })
  };
  try {
    const result = await updateHistoricalDataset({
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), directory,
      fetchImpl, researchClient, dataTypes: ["kline", "settlement"]
    });
    assert.equal(result.manifest.sources.settlement.records, 1);
    assert.match(result.manifest.sources.settlement.source, /swap_settlement_records/);
    const loaded = await loadHistoricalDataset(directory);
    assert.equal(loaded.series.settlement.length, 1);
    assert.equal(loaded.series.settlement[0].eventTime, fromMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function candles({ count = 220, intervalMs, visibleAt, random, mirror = false, trend = 0 }) {
  const increments = Array.from({ length: count }, () => ((random() - 0.5) * 1.6 + trend) * (mirror ? -1 : 1));
  let price = 100;
  return increments.map((increment, index) => {
    const open = price;
    const close = Math.max(20, open + increment);
    price = close;
    return {
      id: (visibleAt - (count - index) * intervalMs) / 1000,
      open, close,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      amount: 100 + Math.abs(increment) * 30,
      vol: 10_000,
      trade_turnover: close * 100,
      count: 100
    };
  });
}

function market(seed, { mirror = false, trend = 0 } = {}) {
  const visibleAt = Date.UTC(2026, 0, 1);
  const random = seeded(seed);
  const payload = (intervalMs) => ({ data: candles({ intervalMs, visibleAt, random, mirror, trend }) });
  const result = {
    ticker: { ts: visibleAt, tick: { close: 100 } },
    kline15m: payload(15 * 60_000),
    kline1h: payload(HOUR_MS),
    kline4h: payload(4 * HOUR_MS),
    kline1d: payload(24 * HOUR_MS),
    fundingCurrent: { data: { funding_rate: "0", source: "TEST_POINT_IN_TIME" } },
    multiVenue: { funding: { venueCount: 3, medianFundingRate: 0, dispersionFundingRate: 0, observations: [] } }
  };
  result.ticker.tick.close = result.kline15m.data.at(-1).close;
  return result;
}

test("V3 LONG and SHORT are separate scores and antithetic zero-drift paths are direction-balanced", () => {
  let longWins = 0;
  let shortWins = 0;
  const sums = new Set();
  for (let seed = 1; seed <= 24; seed += 1) {
    for (const mirror of [false, true]) {
      const report = analyzeMultiVenueChallenger(market(seed, { mirror }));
      const long = report.scores.longOpportunity;
      const short = report.scores.shortOpportunity;
      sums.add(Math.round((long + short) * 10) / 10);
      if (long > short) longWins += 1;
      if (short > long) shortWins += 1;
      assert.equal(report.scores.independent, true);
      assert.equal(report.scores.constantSumInvariant, false);
    }
  }
  assert.ok(sums.size > 4, "score sums must vary instead of staying near a constant complement");
  assert.ok(Math.abs(longWins - shortWins) <= 4, `antithetic null audit is imbalanced: ${longWins}/${shortWins}`);
});

test("SWING_RUNNER_V1 does not recreate the old 1R break-even / 1.5R trail conflict", () => {
  const generatedAt = "2026-08-21T04:00:00.000Z";
  const completedBarTs = new Date(generatedAt).getTime() - 15 * 60_000;
  const position = {
    side: "LONG", entry_price: 100, initial_stop_loss: 95, stop_loss: 95, take_profit: 114,
    rr: 2.8, net_rr: 2.8, entry_bar_ts: completedBarTs - 12 * 15 * 60_000,
    last_management_bar_ts: completedBarTs - 15 * 60_000, opposite_signal_count: 0,
    management: { events: [] }
  };
  const runnerStrategy = {
    positionManagementProfile: "SWING_RUNNER_V1",
    managementContract: {
      breakEvenTriggerR: 1.68, trailingTriggerR: 2.184,
      minimumHoldBarsBeforeSignalExit: 8, oppositeSignalBarsForExit: 3
    }
  };
  const atOneR = paperReport({
    generatedAt, currentPrice: 105.2,
    latest15mBar: { timestamp: completedBarTs, open: 104, high: 106, low: 104, close: 105.2 },
    completed15mBar: { timestamp: completedBarTs, open: 104, high: 106, low: 104, close: 105.2 },
    strategy: runnerStrategy
  });
  const held = manageOpenPosition(position, atOneR);
  assert.equal(held.stopLoss ?? position.stop_loss, 95);
  assert.equal(held.takeProfit ?? position.take_profit, 114);
  const aboveContract = {
    ...atOneR,
    currentPrice: 108.6,
    latest15mBar: { ...atOneR.latest15mBar, high: 109, low: 107, close: 108.6 },
    completed15mBar: { ...atOneR.completed15mBar, high: 109, low: 107, close: 108.6 }
  };
  const adjusted = manageOpenPosition(position, aboveContract);
  assert.equal(adjusted.action, "UPDATE");
  assert.ok(adjusted.stopLoss > 100);
  assert.equal(adjusted.takeProfit, 114);
});
