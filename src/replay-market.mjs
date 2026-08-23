import { BAR_MS } from "./research-utils.mjs";

const TIMEFRAMES = Object.freeze({
  "15m": BAR_MS,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

const aggregateCache = new WeakMap();

function aggregateClosed(baseCandles, intervalMs, visibleAt) {
  if (intervalMs === BAR_MS) return baseCandles.filter((row) => row.timestamp + BAR_MS <= visibleAt);
  const groups = new Map();
  for (const row of baseCandles) {
    if (row.timestamp + BAR_MS > visibleAt) break;
    const groupStart = Math.floor(row.timestamp / intervalMs) * intervalMs;
    if (groupStart + intervalMs > visibleAt) continue;
    const existing = groups.get(groupStart);
    if (!existing) {
      groups.set(groupStart, { ...row, timestamp: groupStart, volumeBtc: Number(row.volumeBtc), volumeContracts: Number(row.volumeContracts), turnoverUsdt: Number(row.turnoverUsdt), trades: Number(row.trades) });
    } else {
      existing.high = Math.max(existing.high, row.high);
      existing.low = Math.min(existing.low, row.low);
      existing.close = row.close;
      existing.volumeBtc += Number(row.volumeBtc);
      existing.volumeContracts += Number(row.volumeContracts);
      existing.turnoverUsdt += Number(row.turnoverUsdt);
      existing.trades += Number(row.trades);
    }
  }
  return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function allAggregates(candles) {
  const cached = aggregateCache.get(candles);
  if (cached) return cached;
  const output = {};
  for (const [name, interval] of Object.entries(TIMEFRAMES)) {
    if (interval === BAR_MS) output[name] = candles;
    else output[name] = aggregateClosed(candles, interval, Number.POSITIVE_INFINITY);
  }
  aggregateCache.set(candles, output);
  return output;
}

function visibleSlice(rows, interval, visibleAt, maximumBars) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestamp + interval <= visibleAt) low = middle + 1;
    else high = middle;
  }
  return rows.slice(Math.max(0, low - maximumBars), low);
}

function htxRows(rows) {
  return rows.map((row) => ({
    id: row.timestamp / 1000,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    amount: row.volumeBtc,
    vol: row.volumeContracts,
    trade_turnover: row.turnoverUsdt,
    count: row.trades
  }));
}

function payload(rows) { return { status: "ok", data: htxRows(rows) }; }

export function buildPointInTimeMarket(candles, funding, index, { maximumBars = 260 } = {}) {
  const closed = candles[index];
  if (!closed) throw new Error(`Replay candle index out of bounds: ${index}`);
  const visibleAt = closed.timestamp + BAR_MS;
  const aggregates = allAggregates(candles);
  const byTimeframe = Object.fromEntries(Object.entries(TIMEFRAMES).map(([name, interval]) => [
    name,
    name === "15m"
      ? candles.slice(Math.max(0, index - maximumBars + 1), index + 1)
      : visibleSlice(aggregates[name], interval, visibleAt, maximumBars)
  ]));
  const syntheticOpen = {
    timestamp: visibleAt,
    open: closed.close,
    high: closed.close,
    low: closed.close,
    close: closed.close,
    volumeBtc: 0,
    volumeContracts: 0,
    turnoverUsdt: 0,
    trades: 0
  };
  const fundingVisible = funding.filter((item) => item.timestamp <= visibleAt);
  const currentFunding = fundingVisible.at(-1) ?? null;
  return {
    ticker: { status: "ok", ts: visibleAt, tick: { close: closed.close, open: closed.open, high: closed.high, low: closed.low } },
    kline15m: payload([...byTimeframe["15m"].slice(-(maximumBars - 1)), syntheticOpen]),
    kline1h: payload(byTimeframe["1h"]),
    kline4h: payload(byTimeframe["4h"]),
    kline1d: payload(byTimeframe["1d"]),
    depth: null,
    fundingCurrent: currentFunding ? { status: "ok", data: {
      funding_rate: String(currentFunding.fundingRate),
      funding_time: String(currentFunding.timestamp),
      source: currentFunding.timestamp === visibleAt ? "HTX_HISTORICAL_EXACT_SETTLEMENT_RATE" : "HTX_HISTORICAL_LAST_OBSERVED_RATE_ESTIMATE",
      age_ms: visibleAt - currentFunding.timestamp
    } } : null,
    fundingHistory: { status: "ok", data: { data: fundingVisible.slice(-30).map((item) => ({ funding_rate: String(item.fundingRate), funding_time: String(item.timestamp) })) } },
    oiCurrent: null,
    oiHistory: null,
    eliteAccount: null,
    elitePosition: null,
    liquidations: null,
    markPrice: null,
    premium: null,
    basis: null,
    contractElements: null,
    replay: {
      visibleAt,
      eventCandle: closed,
      closedCounts: Object.fromEntries(Object.entries(byTimeframe).map(([key, rows]) => [key, rows.length])),
      unavailableSources: ["historical_order_book", "historical_oi", "historical_elite_positioning", "historical_liquidations", "historical_mark_basis"]
    }
  };
}

export function firstReplayableIndex(candles, minimumDailyBars = 60) {
  const daily = allAggregates(candles)["1d"];
  if (daily.length < minimumDailyBars) return -1;
  const visibleAt = daily[minimumDailyBars - 1].timestamp + TIMEFRAMES["1d"];
  return candles.findIndex((row) => row.timestamp + BAR_MS >= visibleAt);
}

export { TIMEFRAMES };
