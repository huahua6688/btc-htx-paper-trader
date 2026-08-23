import test from "node:test";
import assert from "node:assert/strict";
import { collectMarketSnapshot } from "../src/market-data.mjs";
import { coreMarketDataFreshForTrading } from "../src/market-context.mjs";
import { paperReport } from "./helpers.mjs";

test("secondary public endpoint failure degrades safely while core data still completes", async () => {
  const output = await collectMarketSnapshot({
    concurrency: 4,
    runner: async (_skill, subcommand) => {
      if (subcommand === "history") throw new Error("temporary status=error");
      return { status: "ok", tick: { close: 100 }, data: [] };
    }
  });
  assert.equal(output.fundingHistory, null);
  assert.equal(output.oiHistory, null);
  assert.ok(output.collectionWarnings.length >= 2);
  assert.ok(output.ticker);
});

test("core price/K-line failure aborts the cycle instead of producing a trade", async () => {
  await assert.rejects(() => collectMarketSnapshot({
    concurrency: 1,
    runner: async (_skill, subcommand, params) => {
      if (subcommand === "kline" && params.period === "15min") throw new Error("core kline unavailable");
      return { status: "ok", tick: { close: 100 }, data: [] };
    }
  }), /core kline unavailable/);
});

test("stale core data is rejected for every price-triggered action", () => {
  const report = paperReport({
    generatedAt: "2026-08-21T02:00:00.000Z",
    latest15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), close: 90 }
  });
  assert.equal(coreMarketDataFreshForTrading(report, report), false);
  const fresh = paperReport({
    generatedAt: "2026-08-21T02:00:00.000Z",
    latest15mBar: { timestamp: new Date("2026-08-21T01:45:00.000Z").getTime(), close: 100 }
  });
  assert.equal(coreMarketDataFreshForTrading(fresh, fresh), true);
});
