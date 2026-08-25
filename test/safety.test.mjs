import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertAllowedCommand, publicCommandRules, scrubEnvironment } from "../src/htx-cli.mjs";

test("permits a public BTC futures kline", () => {
  assert.equal(assertAllowedCommand("futures-market", "kline", {
    contract_code: "BTC-USDT",
    period: "60min",
    size: 200
  }), true);
});

test("permits only the public btcusdt spot market surface", () => {
  assert.equal(assertAllowedCommand("spot-market", "kline", { symbol: "btcusdt", period: "60min", size: 200 }), true);
  assert.equal(assertAllowedCommand("spot-market", "depth", { symbol: "btcusdt", type: "step0", depth: 20 }), true);
  assert.throws(() => assertAllowedCommand("spot-market", "kline", { symbol: "ethusdt", period: "60min", size: 200 }), /only permits btcusdt/);
  assert.throws(() => assertAllowedCommand("spot-market", "depth", { symbol: "btcusdt", type: "step0", depth: 150 }), /Blocked spot depth/);
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
    "oi-tracker",
    "spot-market"
  ]);
});

test("check-safety fails closed when a private capability is changed from INTERFACE_ONLY", () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-safety-fixture-"));
  try {
    for (const name of ["scripts", "src", "test", "deploy"]) mkdirSync(join(directory, name));
    copyFileSync(new URL("../scripts/check-safety.mjs", import.meta.url), join(directory, "scripts/check-safety.mjs"));
    copyFileSync(new URL("../src/analysis-engine.mjs", import.meta.url), join(directory, "src/analysis-engine.mjs"));
    writeFileSync(join(directory, "src/htx-skill-capabilities.mjs"), [
      "export const rows = [",
      '  { skill: "spot-account", status: "ACTUALLY_INVOKED"',
      "  },",
      '  { skill: "spot-trading", status: "INTERFACE_ONLY"',
      "  },",
      '  { skill: "futures-account", status: "INTERFACE_ONLY"',
      "  },",
      '  { skill: "futures-trading", status: "INTERFACE_ONLY"',
      "  }",
      "];",
      "export const report = { exchangeWriteEnabled: false };"
    ].join("\n"));
    for (const name of ["README.md", "ARCHITECTURE_REVIEW.md", ".env.example", "package.json"]) {
      writeFileSync(join(directory, name), name === "package.json" ? "{}\n" : "");
    }
    assert.throws(() => execFileSync(process.execPath, [join(directory, "scripts/check-safety.mjs")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    }), (error) => error.status === 1 && String(error.stderr).includes("every private skill must remain interface-only"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
