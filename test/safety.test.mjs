import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { assertAllowedCommand, publicCommandRules, scrubEnvironment } from "../src/htx-cli.mjs";

test("permits a public BTC futures kline", () => {
  assert.equal(assertAllowedCommand("futures-market", "kline", {
    contract_code: "BTC-USDT",
    period: "60min",
    size: 200
  }), true);
});

test("blocks every trading skill", () => {
  assert.throws(() => assertAllowedCommand("futures-trading", "order", {}), /Blocked non-public/);
  assert.throws(() => assertAllowedCommand("spot-trading", "order", {}), /Blocked non-public/);
});

test("blocks credentials and non-BTC symbols", () => {
  assert.throws(() => assertAllowedCommand("futures-market", "kline", {
    contract_code: "ETH-USDT",
    period: "60min",
    size: 200
  }), /only permits BTC-USDT/);
  assert.throws(() => assertAllowedCommand("futures-market", "kline", {
    contract_code: "BTC-USDT",
    period: "60min",
    size: 200,
    api_key: "never"
  }), /Blocked HTX parameter/);
});

test("removes exchange credentials from the child environment", () => {
  const clean = scrubEnvironment({
    PATH: "safe",
    HTX_API_KEY: "secret",
    HTX_SECRET_KEY: "secret",
    HUOBI_API_KEY: "secret",
    HUOBI_SECRET_KEY: "secret",
    TELEGRAM_BOT_TOKEN: "never-forward-to-htx",
    TELEGRAM_CHAT_ID: "123"
  });
  assert.deepEqual(clean, { PATH: "safe" });
});

test("V1.2 runtime has no fixed setup engine and exposes only public HTX skill families", () => {
  assert.equal(existsSync(new URL("../src/setup-engine.mjs", import.meta.url)), false);
  const analysis = readFileSync(new URL("../src/analysis-engine.mjs", import.meta.url), "utf8");
  const monitor = readFileSync(new URL("../src/monitor-cycle.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(analysis, /setupProposal|triggerPrice|expiresAt/);
  assert.doesNotMatch(monitor, /createSetup|armSetup|setup-engine/);
  assert.deepEqual(Object.keys(publicCommandRules).sort(), [
    "elite-positioning",
    "funding-rate",
    "futures-market",
    "liquidation-stream",
    "mark-price",
    "oi-tracker"
  ]);
});
