// 观察时点 → 入场 K 线格。
//
// `paper-engine` 的回溯保护写作 `bar.timestamp > position.entry_bar_ts`：
// 只有开始时间严格晚于入场那一格的 K 线，其 high/low 才可以用来触发 SL/TP。
// 这条判断成立的前提是 `entry_bar_ts` 必须标识「入场实际发生在哪一格 15 分钟 K 线里」。
//
// 冻结的 V1.2 Champion 天然满足这个前提：它的 `latest15mBar` 就是正在形成的那一根，
// 时间戳恰好等于入场时刻所在的格。但研究策略统一使用 `closedMarketView`，
// 它们的 `latest15mBar` 是最后一根**已收盘**的 K 线，比入场那一格早一格甚至两格。
// 直接拿它当 `entry_bar_ts`，就会让包含入场之前走势的那根 K 线通过回溯保护，
// 用入场前的极值触发止损止盈，从而污染 Shadow 样本。
//
// 因此所有研究策略都显式声明自己的执行时点，由本模块统一换算入场格，
// 而不是让执行层去猜 `latest15mBar` 属于哪种语义。

export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export const OBSERVATION_ENTRY_TIMING_CONTRACT = Object.freeze({
  version: "OBSERVATION_BUCKET_ENTRY_BAR_V1",
  executionClock: "STRATEGY_OBSERVATION_TIMESTAMP",
  fillReference: "PRICE_VISIBLE_AT_EXECUTION_OBSERVATION",
  entryBar: "FIFTEEN_MINUTE_BUCKET_CONTAINING_THE_EXECUTION_OBSERVATION"
});

/**
 * 观察时刻所在的 15 分钟 K 线格的开盘时间。
 */
export function entryBarTimestampFor(observationTimestamp) {
  const timestamp = Number(observationTimestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error("Entry bar resolution requires a positive observation timestamp");
  }
  return Math.floor(timestamp / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
}

/**
 * 研究策略共用的执行时点声明。Breakout V4 在此基础上另加最大信号年龄契约。
 */
export function resolveObservationExecution({
  observationTimestamp,
  fillReferencePrice,
  observationSource
}) {
  const executionTimestamp = Number(observationTimestamp);
  const price = Number(fillReferencePrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Execution timing requires a positive fill-reference price");
  }
  return {
    contractVersion: OBSERVATION_ENTRY_TIMING_CONTRACT.version,
    executionTimestamp,
    entryBarTimestamp: entryBarTimestampFor(executionTimestamp),
    fillReferencePrice: price,
    fillReferenceSource: observationSource
  };
}

/**
 * Shadow 与 Replay 使用同一个观察来源标签，便于事后区分成交参考价的出处。
 */
export function observationSourceFor(market) {
  return market?.replay?.pointInTime ? "REPLAY_OBSERVATION_PRICE" : "SHADOW_TICKER_PRICE";
}
