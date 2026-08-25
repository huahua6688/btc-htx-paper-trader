const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Keep the administrator's normal monitor cadence, but add a wall-clock wake
 * at every 4h close while Breakout V4 Shadow is active. This preserves the
 * fixed five-minute execution-age contract without making longer Telegram
 * cycle choices silently skip every breakout.
 *
 * The extra wake belongs to research, so it must not change how often the
 * frozen V1.2 Champion evaluates entries: `shadowOnly` marks a wake that was
 * pulled in purely by the 4h boundary, and the monitor then runs the Shadow
 * cycle alone. Turning a research Shadow on never re-times production.
 */
export function resolveNextMonitorWake({
  cycleStartedAtMs,
  cycleFinishedAtMs,
  configuredIntervalMs,
  activeShadowStrategyType = null
}) {
  const startedAt = Number(cycleStartedAtMs);
  const finishedAt = Number(cycleFinishedAtMs);
  const interval = Number(configuredIntervalMs);
  if (![startedAt, finishedAt, interval].every(Number.isFinite) || startedAt <= 0 || finishedAt < startedAt || interval <= 0) {
    throw new Error("Monitor schedule requires valid start, finish and interval timestamps");
  }
  const regularDelay = Math.max(0, startedAt + interval - finishedAt);
  if (activeShadowStrategyType !== "breakout-v4") return { delayMs: regularDelay, shadowOnly: false };
  const nextFourHourClose = (Math.floor(startedAt / FOUR_HOURS_MS) + 1) * FOUR_HOURS_MS;
  const boundaryDelay = Math.max(0, nextFourHourClose - finishedAt);
  // 只有当边界唤醒真的比常规节奏更早时，这一轮才是研究额外插入的。
  return boundaryDelay < regularDelay
    ? { delayMs: boundaryDelay, shadowOnly: true }
    : { delayMs: regularDelay, shadowOnly: false };
}

export function nextMonitorDelayMs(options) {
  return resolveNextMonitorWake(options).delayMs;
}
