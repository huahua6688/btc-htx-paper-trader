import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSnapshot, deriveMarketRegime } from "../src/analysis-engine.mjs";
import { normalizePublicCommandPayload } from "../src/htx-cli.mjs";

const NOW_SECONDS = 1_780_000_000;

function trendKlines(stepSeconds, direction = 1, move = 20) {
  const count = 200;
  return {
    data: Array.from({ length: count }, (_, index) => {
      const distance = count - 1 - index;
      const close = 70_000 - direction * distance * move;
      const open = close - direction * move * 0.7;
      return {
        id: NOW_SECONDS - distance * stepSeconds,
        open,
        high: Math.max(open, close) + move * 0.35,
        low: Math.min(open, close) - move * 0.35,
        close,
        amount: 100 + index * 0.5
      };
    })
  };
}

function marketSnapshot({ direction = 1, extremeCrowding = false } = {}) {
  const now = NOW_SECONDS * 1000;
  const fundingRate = extremeCrowding ? "0.001" : direction > 0 ? "0.00008" : "-0.00008";
  const buyRatio = extremeCrowding ? 0.8 : direction > 0 ? 0.58 : 0.42;
  const sellRatio = 1 - buyRatio;
  return {
    ticker: { ts: now, tick: { close: 70_000 } },
    kline15m: trendKlines(900, direction, 12),
    kline1h: trendKlines(3_600, direction, 24),
    kline4h: trendKlines(14_400, direction, 55),
    kline1d: trendKlines(86_400, direction, 80),
    depth: { tick: direction > 0
      ? { bids: [[69_990, 650], [69_980, 400]], asks: [[70_010, 250], [70_020, 200]] }
      : { bids: [[69_990, 250], [69_980, 200]], asks: [[70_010, 650], [70_020, 400]] } },
    fundingCurrent: { data: { funding_rate: fundingRate } },
    fundingHistory: { data: { data: Array.from({ length: 30 }, (_, index) => ({ funding_rate: String(-0.0002 + index * 0.000014) })) } },
    oiCurrent: { data: [{ value: 1_100_000_000 }] },
    oiHistory: { data: { tick: [{ ts: now - 86_400_000, value: 1_000_000_000 }, { ts: now, value: 1_100_000_000 }] } },
    eliteAccount: { data: { list: [{ ts: now, buy_ratio: buyRatio, sell_ratio: sellRatio }] } },
    elitePosition: { data: { list: [{ ts: now, buy_ratio: buyRatio - 0.03, sell_ratio: sellRatio + 0.03 }] } },
    liquidations: { data: Array.from({ length: extremeCrowding ? 3 : 1 }, (_, index) => ({
      created_at: now - index * 1_000,
      direction: direction > 0 ? "sell" : "buy",
      trade_turnover: 1_000_000
    })) },
    markPrice: { data: [{ close: 70_000 }] },
    premium: { data: [{ close: direction * 0.0001 }] },
    basis: { data: Array.from({ length: 24 }, (_, index) => ({ basis_rate: direction * index / 100_000 })) }
  };
}

test("market regime is derived from current trend strength, not a saved setup", () => {
  assert.equal(deriveMarketRegime({ "4h": { adx14: 30, score: 40 } }), "TRENDING");
  assert.equal(deriveMarketRegime({ "4h": { adx14: 14, score: 5 } }), "RANGE");
  assert.equal(deriveMarketRegime({ "4h": { adx14: 20, score: 5 } }), "TRANSITION");
});

test("every analysis scores LONG and SHORT independently and can enter immediately", () => {
  const report = analyzeSnapshot(marketSnapshot({ direction: 1 }));
  assert.equal(report.version, "V1.2");
  assert.equal(report.candidateDecision, "LONG");
  assert.ok(report.opportunities.LONG.score > report.opportunities.SHORT.score);
  assert.equal(report.entryAssessment.enterNow, true);
  assert.equal(report.decision, "LONG");
  assert.ok(["DIRECT_NOW", "BREAKOUT_NOW", "RECOVERY_NOW"].includes(report.entryAssessment.method));
  assert.equal(report.plan.entryPrice, report.currentPrice);
  assert.equal("waitTriggers" in report.plan, false);
  assert.ok(report.plan.stopLoss < report.currentPrice);
});

test("reversing current market data reverses the independently recomputed preference", () => {
  const bullish = analyzeSnapshot(marketSnapshot({ direction: 1 }));
  const bearish = analyzeSnapshot(marketSnapshot({ direction: -1 }));
  assert.equal(bullish.candidateDecision, "LONG");
  assert.equal(bearish.candidateDecision, "SHORT");
  assert.ok(bearish.opportunities.SHORT.score > bearish.opportunities.LONG.score);
  assert.equal(bearish.decision, "SHORT");
  assert.ok(bearish.plan.stopLoss > bearish.currentPrice);
});

test("RSI, Funding and crowding modify score or risk but never become a one-indicator hard veto", () => {
  const report = analyzeSnapshot(marketSnapshot({ direction: 1, extremeCrowding: true }));
  assert.equal(report.dataQuality.validForEntry, true);
  assert.deepEqual(report.riskGates, []);
  assert.ok(report.opportunities.LONG);
  assert.ok(report.opportunities.SHORT);
  assert.equal(report.strategy.riskTier, "REDUCED");
  assert.equal(report.strategy.riskPct <= 0.005 || report.decision === "WAIT", true);
  assert.equal("setupProposal" in report.strategy, false);
});

test("missing public market data is the hard gate and prevents paper entry", () => {
  const snapshot = marketSnapshot({ direction: 1 });
  snapshot.depth = { tick: { bids: [], asks: [] } };
  const report = analyzeSnapshot(snapshot);
  assert.equal(report.decision, "WAIT");
  assert.equal(report.entryAssessment.enterNow, false);
  assert.equal(report.dataQuality.validForEntry, false);
  assert.match(report.riskGates.join(" "), /Order Book/);
});

test("HTX CLI v2 object payloads retain the exact shapes consumed by frozen V1.2", () => {
  const now = NOW_SECONDS * 1000;
  const upstream = {
    oiCurrent: { status: "ok", data: { symbol: "BTC", contract_code: "BTC-USDT", ts: now, value: "1100000000" } },
    oiHistory: { status: "ok", data: { symbol: "BTC", contract_code: "BTC-USDT", tick: [
      { ts: now - 86_400_000, value: "1000000000" }, { ts: now, value: "1100000000" }
    ] } },
    eliteAccount: { status: "ok", data: { symbol: "BTC", contract_code: "BTC-USDT", list: [
      { ts: now, buy_ratio: "0.58", sell_ratio: "0.42" }
    ] } },
    elitePosition: { status: "ok", data: { symbol: "BTC", contract_code: "BTC-USDT", list: [
      { ts: now, buy_ratio: "0.55", sell_ratio: "0.45" }
    ] } }
  };
  const adapted = {
    oiCurrent: normalizePublicCommandPayload("oi-tracker", "current", upstream.oiCurrent),
    oiHistory: normalizePublicCommandPayload("oi-tracker", "history", upstream.oiHistory),
    eliteAccount: normalizePublicCommandPayload("elite-positioning", "account-ratio", upstream.eliteAccount),
    elitePosition: normalizePublicCommandPayload("elite-positioning", "position-ratio", upstream.elitePosition)
  };
  assert.equal(Array.isArray(upstream.oiCurrent.data), false);
  assert.equal(Array.isArray(adapted.oiCurrent.data), true);
  assert.equal(Array.isArray(adapted.oiHistory.data), false);
  assert.equal(Array.isArray(adapted.oiHistory.data.tick), true);
  assert.equal(Array.isArray(adapted.eliteAccount.data), false);
  assert.equal(Array.isArray(adapted.eliteAccount.data.list), true);
  assert.equal(Array.isArray(adapted.elitePosition.data.list), true);

  const report = analyzeSnapshot({ ...marketSnapshot({ direction: 1 }), ...adapted });
  assert.equal(report.derivatives.oiUsd, 1_100_000_000);
  assert.equal(report.derivatives.oiDelta24Pct, 10);
  assert.equal(report.derivatives.eliteAccountRatio, 1.381);
  assert.equal(report.derivatives.elitePositionRatio, 1.222);
  assert.equal(report.dataQuality.validForEntry, true);
  assert.equal(report.decision, "LONG", "adapter shape must not force frozen V1.2 into permanent WAIT");
});
