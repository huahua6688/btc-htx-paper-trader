import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HEALTH_CONFIG, PAPER_CONFIG, TELEGRAM_CONFIG } from "../src/config.mjs";
import { resolveCliPath } from "../src/htx-cli.mjs";

test("V1 risk and scheduling defaults match the paper trading specification", () => {
  assert.equal(PAPER_CONFIG.monitorIntervalMs, 5 * 60 * 1000);
  assert.equal(PAPER_CONFIG.initialCapitalCny, 1_000);
  assert.equal(PAPER_CONFIG.maxRiskPerTradePct, 0.01);
  assert.equal(PAPER_CONFIG.reducedRiskPerTradePct, 0.005);
  assert.equal(PAPER_CONFIG.maxDailyLossPct, 0.03);
  assert.equal(PAPER_CONFIG.maxConsecutiveLosses, 3);
  assert.equal(PAPER_CONFIG.minimumRiskReward, 2);
  assert.equal(PAPER_CONFIG.setupExpiryMs, 6 * 60 * 60 * 1000);
  assert.equal(PAPER_CONFIG.extremePressureMin, 76);
  assert.equal(HEALTH_CONFIG.maxAgeMs, 15 * 60 * 1000);
  assert.equal(TELEGRAM_CONFIG.apiBaseUrl, "https://api.telegram.org");
  assert.equal(TELEGRAM_CONFIG.dailySummaryHour, 23);
  assert.equal(TELEGRAM_CONFIG.dailySummaryMinute, 55);
  assert.equal(Object.isFrozen(PAPER_CONFIG), true);
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
