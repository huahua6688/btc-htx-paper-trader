import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot } from "../src/analysis-engine.mjs";

function risingKlines(stepSeconds, start = 50_000) {
  return {
    data: Array.from({ length: 200 }, (_, index) => {
      const open = start + index * 100;
      return {
        id: 1_700_000_000 + index * stepSeconds,
        open,
        high: open + 140,
        low: open - 40,
        close: open + 100,
        amount: 100 + index
      };
    })
  };
}

test("overheated bullish setup is downgraded to WAIT", () => {
  const hourly = risingKlines(3600);
  const now = hourly.data.at(-1).id * 1000;
  const snapshot = {
    ticker: { ts: now, tick: { close: hourly.data.at(-1).close } },
    kline15m: risingKlines(900),
    kline1h: hourly,
    kline4h: risingKlines(14_400),
    kline1d: risingKlines(86_400),
    depth: { tick: { bids: [[69_900, 500], [69_800, 400]], asks: [[70_000, 100], [70_100, 100]] } },
    fundingCurrent: { data: { funding_rate: "0.001" } },
    fundingHistory: { data: { data: Array.from({ length: 30 }, () => ({ funding_rate: "0.0001" })) } },
    oiCurrent: { data: [{ value: 1_200_000_000 }] },
    oiHistory: { data: { tick: [{ ts: now - 86_400_000, value: 1_000_000_000 }, { ts: now, value: 1_200_000_000 }] } },
    eliteAccount: { data: { list: [{ ts: now, buy_ratio: 0.7, sell_ratio: 0.3 }] } },
    elitePosition: { data: { list: [{ ts: now, buy_ratio: 0.65, sell_ratio: 0.35 }] } },
    liquidations: { data: [{ created_at: now, direction: "sell", trade_turnover: 1_000_000 }] },
    markPrice: { data: [{ close: 70_000 }] },
    premium: { data: [{ close: 0.001 }] },
    basis: { data: Array.from({ length: 24 }, (_, index) => ({ basis_rate: index / 100_000 })) }
  };

  const report = analyzeSnapshot(snapshot);
  assert.equal(report.candidateDecision, "LONG");
  assert.equal(report.decision, "WAIT");
  assert.ok(report.riskGates.length >= 1);
  assert.equal(report.plan.entryZone, null);
});
