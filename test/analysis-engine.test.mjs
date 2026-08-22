import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot, deriveMarketContext } from "../src/analysis-engine.mjs";

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

test("4h trend remains the bias during an ordinary lower-timeframe pullback", () => {
  const bullish4h = { ema20: 70_000, ema50: 68_000, close: 71_000, ema20SlopePct: 0.5, adx14: 35 };
  assert.equal(deriveMarketContext({ "4h": bullish4h }, -3.8).bias, "LONG");
  assert.equal(deriveMarketContext({ "4h": bullish4h }, -24).bias, "WAIT");

  const bearish4h = { ema20: 68_000, ema50: 70_000, close: 67_000, ema20SlopePct: -0.5, adx14: 35 };
  assert.equal(deriveMarketContext({ "4h": bearish4h }, 3.8).bias, "SHORT");
  assert.equal(deriveMarketContext({ "4h": bearish4h }, 24).bias, "WAIT");
});

test("overheated bullish setup becomes a half-risk pending plan instead of a hard RSI veto", () => {
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
  assert.equal(report.riskGates.length, 0);
  assert.equal(report.strategy.riskPct, 0.005);
  assert.ok(report.strategy.softWarnings.some((item) => item.includes("RSI")));
  assert.ok(report.strategy.setupProposal);
  assert.ok(report.plan.entryZone);
});

test("only extreme pressure plus a confirmed same-direction squeeze remains a hard market gate", () => {
  const hourly = risingKlines(3600);
  const now = hourly.data.at(-1).id * 1000;
  const snapshot = {
    ticker: { ts: now, tick: { close: hourly.data.at(-1).close } },
    kline15m: risingKlines(900),
    kline1h: hourly,
    kline4h: risingKlines(14_400),
    kline1d: risingKlines(86_400),
    depth: { tick: { bids: [[69_900, 900]], asks: [[70_000, 100]] } },
    fundingCurrent: { data: { funding_rate: "0.001" } },
    fundingHistory: { data: { data: Array.from({ length: 30 }, () => ({ funding_rate: "0.0001" })) } },
    oiCurrent: { data: [{ value: 1_300_000_000 }] },
    oiHistory: { data: { tick: [{ ts: now - 86_400_000, value: 1_000_000_000 }, { ts: now, value: 1_300_000_000 }] } },
    eliteAccount: { data: { list: [{ ts: now, buy_ratio: 0.8, sell_ratio: 0.2 }] } },
    elitePosition: { data: { list: [{ ts: now, buy_ratio: 0.2, sell_ratio: 0.8 }] } },
    liquidations: { data: Array.from({ length: 3 }, (_, index) => ({
      created_at: now - index * 1000,
      direction: "sell",
      trade_turnover: 1_000_000
    })) },
    markPrice: { data: [{ close: 70_000 }] },
    premium: { data: [{ close: 0.001 }] },
    basis: { data: Array.from({ length: 24 }, (_, index) => ({ basis_rate: index / 10_000 })) }
  };

  const report = analyzeSnapshot(snapshot);
  assert.equal(report.candidateDecision, "LONG");
  assert.equal(report.derivatives.squeezeRisk, "long_squeeze");
  assert.ok(report.derivatives.pressureScore >= 76);
  assert.equal(report.decision, "WAIT");
  assert.match(report.riskGates.join(" "), /极端衍生品拥挤/);
  assert.equal(report.strategy.setupProposal, null);
});
