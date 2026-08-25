import test from "node:test";
import assert from "node:assert/strict";
import { nextMonitorDelayMs } from "../src/monitor-schedule.mjs";

const MINUTE_MS = 60 * 1000;
const BOUNDARY = Date.UTC(2026, 7, 25, 12, 0, 0);

test("every legal monitor interval wakes Breakout V4 at the next 4h close", () => {
  for (const minutes of [5, 15, 60, 240]) {
    const startedAt = BOUNDARY - 3 * MINUTE_MS;
    const finishedAt = startedAt + 37_000;
    const delay = nextMonitorDelayMs({
      cycleStartedAtMs: startedAt,
      cycleFinishedAtMs: finishedAt,
      configuredIntervalMs: minutes * MINUTE_MS,
      activeShadowStrategyType: "breakout-v4"
    });
    assert.equal(finishedAt + delay, BOUNDARY, `${minutes}m setting must not skip the 4h close`);
  }
});

test("a cycle crossing the 4h close reruns immediately while other strategies keep the configured cadence", () => {
  const startedAt = BOUNDARY - 30_000;
  const finishedAt = BOUNDARY + 37_000;
  assert.equal(nextMonitorDelayMs({
    cycleStartedAtMs: startedAt,
    cycleFinishedAtMs: finishedAt,
    configuredIntervalMs: 60 * MINUTE_MS,
    activeShadowStrategyType: "breakout-v4"
  }), 0);
  assert.equal(nextMonitorDelayMs({
    cycleStartedAtMs: startedAt,
    cycleFinishedAtMs: finishedAt,
    configuredIntervalMs: 60 * MINUTE_MS,
    activeShadowStrategyType: "multi-venue-v3"
  }), 60 * MINUTE_MS - 67_000);
});
