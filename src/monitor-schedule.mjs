const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Keep the administrator's normal monitor cadence, but add a wall-clock wake
 * at every 4h close while Breakout V4 Shadow is active. This preserves the
 * fixed five-minute execution-age contract without making longer Telegram
 * cycle choices silently skip every breakout.
 */
export function nextMonitorDelayMs({
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
  if (activeShadowStrategyType !== "breakout-v4") return regularDelay;
  const nextFourHourClose = (Math.floor(startedAt / FOUR_HOURS_MS) + 1) * FOUR_HOURS_MS;
  const boundaryDelay = Math.max(0, nextFourHourClose - finishedAt);
  return Math.min(regularDelay, boundaryDelay);
}
