import test from "node:test";
import assert from "node:assert/strict";
import { nextMonitorDelayMs, resolveNextMonitorWake } from "../src/monitor-schedule.mjs";

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

test("the extra 4h wake runs the Shadow alone and never re-times the frozen Champion", () => {
  // 边界唤醒比常规节奏更早 —— 这一轮是研究额外插入的，主 V1.2 不参与。
  const pulledIn = resolveNextMonitorWake({
    cycleStartedAtMs: BOUNDARY - 3 * MINUTE_MS,
    cycleFinishedAtMs: BOUNDARY - 3 * MINUTE_MS + 37_000,
    configuredIntervalMs: 60 * MINUTE_MS,
    activeShadowStrategyType: "breakout-v4"
  });
  assert.equal(pulledIn.shadowOnly, true);
  assert.ok(pulledIn.delayMs < 60 * MINUTE_MS);

  // 常规节奏本来就先到时，这一轮是完整周期，Champion 照常运行。
  const regular = resolveNextMonitorWake({
    cycleStartedAtMs: BOUNDARY + 10 * MINUTE_MS,
    cycleFinishedAtMs: BOUNDARY + 10 * MINUTE_MS + 1_000,
    configuredIntervalMs: 5 * MINUTE_MS,
    activeShadowStrategyType: "breakout-v4"
  });
  assert.equal(regular.shadowOnly, false);

  // 没有启用 V4 Shadow 时，永远不存在额外唤醒。
  for (const strategyType of [null, "multi-venue-v3", "research-v2"]) {
    assert.equal(resolveNextMonitorWake({
      cycleStartedAtMs: BOUNDARY - 3 * MINUTE_MS,
      cycleFinishedAtMs: BOUNDARY - 3 * MINUTE_MS + 1_000,
      configuredIntervalMs: 60 * MINUTE_MS,
      activeShadowStrategyType: strategyType
    }).shadowOnly, false, `${strategyType} 不该触发额外唤醒`);
  }
});

test("Shadow 日志标签必须反映真正在跑的策略", () => {
  // monitor.mjs:33 的取值链路。有 active 配置时不得回退到 SHADOW_CONFIG 的常量，
  // 否则日志会声称在跑 challenger-technical-v1，而实际跑的是配置指定的策略。
  const SHADOW_DEFAULT = "challenger-technical-v1";
  const label = (activeShadow) => (activeShadow
    ? (activeShadow.version ?? activeShadow.strategyType)
    : SHADOW_DEFAULT);

  // 只写 strategyType（最常见的手写配置）也必须显示成 breakout-v4。
  assert.equal(label({ strategyType: "breakout-v4", paperOnly: true }), "breakout-v4");
  assert.equal(label({ strategyType: "multi-venue-v3", paperOnly: true }), "multi-venue-v3");
  // 显式写了 version 就用 version。
  assert.equal(label({ strategyType: "breakout-v4", version: "breakout-challenger-v4.0.0" }), "breakout-challenger-v4.0.0");
  // 没有 active 配置时才用默认常量。
  assert.equal(label(null), SHADOW_DEFAULT);

  // 打印时以策略自报的 version 为准：配置里的名字只是标签。
  const printed = (report, fallback) => report.version ?? fallback;
  assert.equal(printed({ version: "breakout-challenger-v4.0.0" }, "breakout-v4"), "breakout-challenger-v4.0.0");
  assert.equal(printed({}, "breakout-v4"), "breakout-v4");
});
