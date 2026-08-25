import test from "node:test";
import assert from "node:assert/strict";
import {
  collectCurrentMultiVenueFunding,
  MULTI_VENUE_FUNDING_SOURCES,
  pointInTimeFundingContext
} from "../src/multi-venue-catalog.mjs";
import { buildPointInTimeMarket } from "../src/replay-market.mjs";

const HOUR_MS = 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const EXTERNAL = Object.keys(MULTI_VENUE_FUNDING_SOURCES);

function candles(count, endExclusive) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.05;
    return {
      timestamp: endExclusive - (count - index) * BAR_MS,
      open: base, high: base + 0.4, low: base - 0.4, close: base + 0.1, volume: 10_000
    };
  });
}

// 三个外部场所各一条已结算 Funding，时间戳都早于观察时刻。
function externalRows(visibleAt) {
  return EXTERNAL.map((exchange, index) => ({
    exchange,
    instrument: exchange === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
    timestamp: visibleAt - (index + 1) * HOUR_MS,
    visibleAt: visibleAt - (index + 1) * HOUR_MS,
    fundingRate: 0.0001 * (index + 1),
    provenance: `${exchange.toUpperCase()}_PUBLIC_HISTORICAL`,
    pointInTime: true
  }));
}

/**
 * 实盘用假 fetch 走真实代码路径，避免任何外网请求。
 */
function fakeFetch(visibleAt) {
  const startMs = visibleAt - 24 * HOUR_MS;
  return async (url) => {
    const host = url.origin;
    const row = externalRows(visibleAt).find((item) => MULTI_VENUE_FUNDING_SOURCES[item.exchange].origin === host);
    const body = host.includes("binance")
      ? [{ fundingTime: row.timestamp, fundingRate: String(row.fundingRate), markPrice: "100" }]
      : host.includes("bybit")
        ? { retCode: 0, result: { list: [{ fundingRateTimestamp: String(row.timestamp), fundingRate: String(row.fundingRate) }] } }
        : { code: "0", data: [{ fundingTime: String(row.timestamp), realizedRate: String(row.fundingRate) }] };
    assert.ok(row.timestamp >= startMs, "测试数据必须落在请求窗口内");
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };
}

test("live and replay build the multi-venue funding context over the same venue set", async () => {
  const visibleAt = Date.UTC(2026, 0, 2, 0, 0, 0);
  const htxSettlement = { timestamp: visibleAt - 2 * HOUR_MS, fundingRate: 0.00005 };

  const live = await collectCurrentMultiVenueFunding({
    fetchImpl: fakeFetch(visibleAt),
    now: () => visibleAt,
    htxFundingHistory: { data: { data: [{ funding_time: htxSettlement.timestamp, realized_rate: String(htxSettlement.fundingRate) }] } }
  });

  const replayMarket = buildPointInTimeMarket(
    candles(400, visibleAt),
    [{ timestamp: htxSettlement.timestamp, fundingRate: htxSettlement.fundingRate }],
    399,
    { multiVenueFunding: externalRows(visibleAt) }
  );
  const replay = replayMarket.multiVenue.funding;

  const venues = (context) => context.observations.map((item) => item.exchange).sort();

  // 场所集合必须一致：回放注入了 HTX，实盘也必须注入，否则 medianFundingRate、
  // venueCount、dispersion 三个量在两边算的不是同一件事。
  assert.deepEqual(venues(live), venues(replay));
  assert.deepEqual(venues(live), ["binance", "bybit", "htx", "okx"]);
  assert.equal(live.htxIncluded, true);
  assert.equal(live.venueCount, replay.venueCount);
  assert.equal(live.medianFundingRate, replay.medianFundingRate);
  assert.equal(live.dispersionFundingRate, replay.dispersionFundingRate);
});

test("a venue missing live is missing in the same way it would be missing in replay", async () => {
  const visibleAt = Date.UTC(2026, 0, 2, 0, 0, 0);
  const failing = async (url) => {
    if (url.origin.includes("bybit")) throw new Error("bybit unavailable");
    return fakeFetch(visibleAt)(url);
  };
  const live = await collectCurrentMultiVenueFunding({
    fetchImpl: failing,
    now: () => visibleAt,
    htxFundingHistory: { data: { data: [{ funding_time: visibleAt - 2 * HOUR_MS, realized_rate: "0.00005" }] } }
  });
  const replay = pointInTimeFundingContext(
    externalRows(visibleAt).filter((row) => row.exchange !== "bybit"),
    visibleAt
  );

  // 失败的场所必须留下明确错误并且直接缺席，绝不能用别处的值补上。
  assert.ok(live.errors.bybit, "失败场所必须留痕");
  assert.ok(!live.observations.some((item) => item.exchange === "bybit"));
  assert.deepEqual(
    live.observations.filter((item) => item.exchange !== "htx").map((item) => item.exchange).sort(),
    replay.observations.map((item) => item.exchange).sort()
  );
});

test("HTX is normalized to the same realized-rate field live and in replay", async () => {
  const visibleAt = Date.UTC(2026, 0, 2, 0, 0, 0);
  const timestamp = visibleAt - 2 * HOUR_MS;
  // 实盘读 realized_rate ?? funding_rate；历史目录（historical-data.mjs）用同一条规则。
  const withRealized = await collectCurrentMultiVenueFunding({
    fetchImpl: fakeFetch(visibleAt),
    now: () => visibleAt,
    htxFundingHistory: { data: { data: [{ funding_time: timestamp, realized_rate: "0.00007", funding_rate: "0.00009" }] } }
  });
  const withoutRealized = await collectCurrentMultiVenueFunding({
    fetchImpl: fakeFetch(visibleAt),
    now: () => visibleAt,
    htxFundingHistory: { data: { data: [{ funding_time: timestamp, funding_rate: "0.00009" }] } }
  });
  const htxRate = (context) => context.observations.find((item) => item.exchange === "htx")?.fundingRate;
  assert.equal(htxRate(withRealized), 0.00007);
  assert.equal(htxRate(withoutRealized), 0.00009);
});

test("the context cache keys on the visible market, not just on time and price", async () => {
  const { analyzeResearchChallengerV2 } = await import("../src/research-challenger-v2.mjs");
  const lastClose = Date.UTC(2026, 0, 2, 0, 0, 0);
  const now = lastClose + 3 * 60_000;
  // 同一个观察时刻、同一个 currentPrice，历史走势完全相反。
  const market = (direction) => {
    const series = (count, interval) => Array.from({ length: count }, (_, index) => {
      const base = direction > 0 ? 80 + index * 0.2 : 140 - index * 0.2;
      return { id: (lastClose - (count - index) * interval) / 1000, open: base, high: base + 0.5, low: base - 0.5, close: base + 0.1, amount: 100, vol: 10_000 };
    });
    return {
      ticker: { ts: now, tick: { close: 111 } },
      kline15m: { data: series(200, BAR_MS) },
      kline1h: { data: series(200, HOUR_MS) },
      kline4h: { data: series(200, 4 * HOUR_MS) },
      kline1d: { data: series(200, 24 * HOUR_MS) },
      fundingCurrent: { data: { funding_rate: "0", source: "TEST_POINT_IN_TIME" } },
      fundingHistory: { data: { data: [] } }
    };
  };

  analyzeResearchChallengerV2(market(1));
  const cached = analyzeResearchChallengerV2(market(-1));
  const fresh = analyzeResearchChallengerV2(market(-1), undefined, undefined, { useCache: false });

  // 缓存命中必须意味着输入一致；否则前视审计会因为拿到同一份上下文而永远「通过」。
  assert.deepEqual(cached.scores, fresh.scores);
  assert.equal(cached.candidateDecision, fresh.candidateDecision);
});
