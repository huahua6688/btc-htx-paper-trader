import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("systemd monitor service provides restart, boot, graceful stop, persistence and hardening", () => {
  const unit = read("deploy/systemd/btc-htx-paper.service");
  assert.match(unit, /After=network-online\.target/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /KillSignal=SIGTERM/);
  assert.match(unit, /TimeoutStopSec=150s/);
  assert.match(unit, /StateDirectory=btc-htx-paper/);
  assert.match(unit, /LogsDirectory=btc-htx-paper/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/btc-htx-paper\/src\/monitor\.mjs/);
  assert.doesNotMatch(unit, /API_KEY|SECRET_KEY|futures-trading|spot-trading/i);
});

test("health timer and logrotate are bounded and enabled", () => {
  const timer = read("deploy/systemd/btc-htx-paper-health.timer");
  const health = read("deploy/systemd/btc-htx-paper-health.service");
  const logrotate = read("deploy/logrotate/btc-htx-paper");
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /WantedBy=timers\.target/);
  assert.match(health, /src\/health\.mjs/);
  assert.match(logrotate, /daily/);
  assert.match(logrotate, /maxsize 10M/);
  assert.match(logrotate, /rotate 14/);
  assert.match(logrotate, /compress/);
  assert.match(logrotate, /copytruncate/);
});

test("production environment points SQLite at persistent systemd state", () => {
  const environment = read("deploy/systemd/btc-htx-paper.env.example");
  assert.match(environment, /PAPER_DB_PATH=\/var\/lib\/btc-htx-paper\/paper-trading\.sqlite/);
  assert.match(environment, /PAPER_HEALTH_MAX_AGE_MS=900000/);
  assert.doesNotMatch(environment, /HTX_API_KEY|HTX_SECRET_KEY|HUOBI_API_KEY|HUOBI_SECRET_KEY/);
});

test("monitor source handles both termination signals", () => {
  const monitor = read("src/monitor.mjs");
  assert.match(monitor, /process\.on\("SIGINT", stop\)/);
  assert.match(monitor, /process\.on\("SIGTERM", stop\)/);
  assert.match(monitor, /db\.close\(\)/);
});
