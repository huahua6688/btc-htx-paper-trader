import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  HEALTH_CONFIG,
  PAPER_CONFIG,
  PAPER_EXCHANGE_CONSTRAINTS,
  RUNTIME_SETTINGS_DEFAULTS,
  TELEGRAM_CONFIG,
  resolveDatabaseLocation
} from "../src/config.mjs";
import { resolveCliPath } from "../src/htx-cli.mjs";

test("frozen V1.2 signals coexist with ranged Paper risk and the public 200x product ceiling", () => {
  assert.equal(RUNTIME_SETTINGS_DEFAULTS.positionMode, "NET");
  assert.equal(PAPER_CONFIG.version, "V1.2");
  assert.equal(PAPER_CONFIG.monitorIntervalMs, 5 * 60 * 1000);
  assert.equal(PAPER_CONFIG.initialCapitalCny, 1_000);
  assert.equal(PAPER_CONFIG.maxRiskPerTradePct, 0.01);
  assert.equal(PAPER_CONFIG.reducedRiskPerTradePct, 0.005);
  assert.equal(PAPER_CONFIG.maxDailyLossPct, 0.03);
  assert.equal(PAPER_CONFIG.maxConsecutiveLosses, 3);
  assert.equal(PAPER_CONFIG.minimumRiskReward, 2);
  assert.equal(PAPER_CONFIG.slippageRate, 0.0002);
  assert.equal(PAPER_CONFIG.extremePressureMin, 76);
  assert.equal(PAPER_CONFIG.minimumBiasScore, 60);
  assert.equal(PAPER_CONFIG.minimumImmediateEntryScore, 67);
  assert.equal(PAPER_CONFIG.minimumDirectionalGap, 7);
  assert.equal(HEALTH_CONFIG.maxAgeMs, 15 * 60 * 1000);
  assert.equal(TELEGRAM_CONFIG.apiBaseUrl, "https://api.telegram.org");
  assert.equal(TELEGRAM_CONFIG.dailySummaryHour, 23);
  assert.equal(TELEGRAM_CONFIG.dailySummaryMinute, 55);
  assert.equal(TELEGRAM_CONFIG.controlPollIntervalMs, 5_000);
  assert.equal(RUNTIME_SETTINGS_DEFAULTS.allowPyramiding, false);
  assert.equal(RUNTIME_SETTINGS_DEFAULTS.riskMode, "AUTO");
  assert.deepEqual([RUNTIME_SETTINGS_DEFAULTS.riskMinPct, RUNTIME_SETTINGS_DEFAULTS.riskMaxPct], [0.005, 0.05]);
  assert.deepEqual([RUNTIME_SETTINGS_DEFAULTS.leverageMin, RUNTIME_SETTINGS_DEFAULTS.leverageMax], [1, 200]);
  assert.equal(RUNTIME_SETTINGS_DEFAULTS.userMaxLeverage, 200);
  assert.equal(PAPER_EXCHANGE_CONSTRAINTS.maxLeverage, 200);
  assert.equal(PAPER_EXCHANGE_CONSTRAINTS.advertisedProductMaxLeverage, 200);
  assert.equal(PAPER_EXCHANGE_CONSTRAINTS.liquidationFormulaAvailable, false);
  assert.equal(Object.isFrozen(PAPER_CONFIG), true);
});

test("database path resolution is explicit and consistent for monitor, status and report", () => {
  const cli = resolveDatabaseLocation({ argv: ["node", "status", "--db=./explicit.sqlite"], environment: {}, platform: "win32", pathExists: () => false });
  assert.equal(cli.source, "--db");
  assert.match(cli.path, /explicit\.sqlite$/);
  const env = resolveDatabaseLocation({ argv: [], environment: { PAPER_DB_PATH: "./env.sqlite" }, platform: "linux", pathExists: () => true });
  assert.equal(env.source, "PAPER_DB_PATH");
  assert.match(env.path, /env\.sqlite$/);
  const vps = resolveDatabaseLocation({ argv: [], environment: {}, platform: "linux", pathExists: (path) => path === "/var/lib/btc-htx-paper/paper-trading.sqlite" });
  assert.deepEqual(vps, { path: "/var/lib/btc-htx-paper/paper-trading.sqlite", source: "VPS_PERSISTENT_DEFAULT" });
});

test("npm exposes monitor, status, report, tests, and the safety check", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.monitor, "node src/monitor.mjs");
  assert.equal(packageJson.scripts.status, "node src/status.mjs");
  assert.equal(packageJson.scripts.health, "node src/health.mjs");
  assert.equal(packageJson.scripts.report, "node src/report.mjs");
  assert.equal(packageJson.scripts["gate:report"], "node src/gate-report.mjs");
  assert.equal(packageJson.scripts["telegram:test"], "node src/telegram-test.mjs");
  assert.ok(packageJson.scripts.test);
  assert.ok(packageJson.scripts["check:safety"]);
});

test("HTX public CLI resolves only supported Windows and Linux x64 binaries", () => {
  assert.equal(basename(resolveCliPath({ platform: "win32", arch: "x64" })), "htx-cli-windows-x64.exe");
  assert.equal(basename(resolveCliPath({ platform: "linux", arch: "x64" })), "htx-cli-linux-x64");
  assert.throws(() => resolveCliPath({ platform: "linux", arch: "arm64" }), /Unsupported HTX CLI architecture/);
  assert.throws(() => resolveCliPath({ platform: "darwin", arch: "x64" }), /Unsupported HTX CLI platform/);
});
