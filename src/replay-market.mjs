import { BAR_MS } from "./research-utils.mjs";

const TIMEFRAMES = Object.freeze({
  "15m": BAR_MS,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

const aggregateCache = new WeakMap();

export const REPLAY_PROVENANCE = Object.freeze({
  HTX_HISTORICAL: "HTX_HISTORICAL",
  SELF_ARCHIVED: "SELF_ARCHIVED",
  LIVE_OBSERVED: "LIVE_OBSERVED",
  HISTORICAL_UNAVAILABLE: "HISTORICAL_UNAVAILABLE",
  STALE: "STALE",
  LIVE_FAILURE: "LIVE_FAILURE"
});

export const REPLAY_FIELD_TTL_MS = Object.freeze({
  depth: 2 * 60 * 1000,
  openInterest: 2 * 60 * 60 * 1000,
  eliteAccount: 2 * 60 * 60 * 1000,
  elitePosition: 2 * 60 * 60 * 1000,
  markPrice: 2 * 60 * 60 * 1000,
  premium: 2 * 60 * 60 * 1000,
  basis: 2 * 60 * 60 * 1000,
  liquidations: 24 * 60 * 60 * 1000,
  contractElements: 7 * 24 * 60 * 60 * 1000
});

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

function visibleHistoricalRecords(records = [], visibleAt, ttlMs) {
  const visible = records.filter((item) => Number(item.eventTime) <= visibleAt && Number(item.visibleAt ?? item.eventTime) <= visibleAt);
  const latest = visible.at(-1) ?? null;
  if (!latest) return { records: [], provenance: REPLAY_PROVENANCE.HISTORICAL_UNAVAILABLE, ageMs: null };
  const ageMs = visibleAt - Number(latest.eventTime);
  if (Number.isFinite(ttlMs) && ageMs > ttlMs) return { records: [], provenance: REPLAY_PROVENANCE.STALE, ageMs };
  return { records: visible, provenance: REPLAY_PROVENANCE.HTX_HISTORICAL, ageMs };
}

function historicalPayload(type, historicalSeries, visibleAt) {
  const ttlMs = REPLAY_FIELD_TTL_MS[type];
  const result = visibleHistoricalRecords(historicalSeries?.[type] ?? [], visibleAt, ttlMs);
  if (!result.records.length) return { payload: null, provenance: result.provenance, ageMs: result.ageMs };
  const rows = result.records.map((item) => item.normalized);
  let value;
  if (type === "openInterest") value = { status: "ok", data: [{ symbol: "BTC", contract_code: "BTC-USDT", tick: rows.slice(-200) }] };
  else if (type === "eliteAccount" || type === "elitePosition") value = { status: "ok", data: [{ symbol: "BTC", contract_code: "BTC-USDT", list: rows.slice(-30) }] };
  else if (["markPrice", "premium", "basis"].includes(type)) value = { status: "ok", data: rows.slice(-2000) };
  else if (type === "liquidations") value = { code: 200, msg: "success", data: rows.filter((row) => Number(row.created_at) >= visibleAt - 24 * 60 * 60 * 1000).slice(-50), ts: visibleAt };
  else value = null;
  return { payload: value, provenance: result.provenance, ageMs: result.ageMs };
}

function replayField(type, historicalSeries, archive, visibleAt) {
  if (archive?.getVisiblePayload) {
    try {
      const archiveType = type === "openInterest" ? "oiHistory" : type;
      const archived = archive.getVisiblePayload(archiveType, new Date(visibleAt).toISOString(), { ttlMs: REPLAY_FIELD_TTL_MS[type] });
      if (archived?.payload) return archived;
      if (archived?.provenance === REPLAY_PROVENANCE.STALE) {
        const historical = historicalPayload(type, historicalSeries, visibleAt);
        return historical.payload ? historical : archived;
      }
    } catch (error) {
      return { payload: null, provenance: REPLAY_PROVENANCE.LIVE_FAILURE, error: error.message };
    }
  }
  return historicalPayload(type, historicalSeries, visibleAt);
}

export function buildPointInTimeMarket(candles, funding, index, {
  maximumBars = 260,
  historicalSeries = {},
  archive = null
} = {}) {
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
  const replayFields = {
    depth: replayField("depth", historicalSeries, archive, visibleAt),
    openInterest: replayField("openInterest", historicalSeries, archive, visibleAt),
    eliteAccount: replayField("eliteAccount", historicalSeries, archive, visibleAt),
    elitePosition: replayField("elitePosition", historicalSeries, archive, visibleAt),
    liquidations: replayField("liquidations", historicalSeries, archive, visibleAt),
    markPrice: replayField("markPrice", historicalSeries, archive, visibleAt),
    premium: replayField("premium", historicalSeries, archive, visibleAt),
    basis: replayField("basis", historicalSeries, archive, visibleAt),
    contractElements: replayField("contractElements", historicalSeries, archive, visibleAt)
  };
  const oiPayload = replayFields.openInterest.payload;
  const unavailableSources = Object.entries(replayFields)
    .filter(([, item]) => !item.payload)
    .map(([key]) => key);
  return {
    ticker: { status: "ok", ts: visibleAt, tick: { close: closed.close, open: closed.open, high: closed.high, low: closed.low } },
    kline15m: payload([...byTimeframe["15m"].slice(-(maximumBars - 1)), syntheticOpen]),
    kline1h: payload(byTimeframe["1h"]),
    kline4h: payload(byTimeframe["4h"]),
    kline1d: payload(byTimeframe["1d"]),
    depth: replayFields.depth.payload,
    fundingCurrent: currentFunding ? { status: "ok", data: {
      funding_rate: String(currentFunding.fundingRate),
      funding_time: String(currentFunding.timestamp),
      source: currentFunding.timestamp === visibleAt ? "HTX_HISTORICAL_EXACT_SETTLEMENT_RATE" : "HTX_HISTORICAL_LAST_OBSERVED_RATE_ESTIMATE",
      age_ms: visibleAt - currentFunding.timestamp
    } } : null,
    fundingHistory: { status: "ok", data: { data: fundingVisible.slice(-30).map((item) => ({ funding_rate: String(item.fundingRate), funding_time: String(item.timestamp) })) } },
    oiCurrent: oiPayload?.data?.[0]?.tick?.length ? { status: "ok", data: [oiPayload.data[0].tick.at(-1)] } : null,
    oiHistory: oiPayload,
    eliteAccount: replayFields.eliteAccount.payload,
    elitePosition: replayFields.elitePosition.payload,
    liquidations: replayFields.liquidations.payload,
    markPrice: replayFields.markPrice.payload,
    premium: replayFields.premium.payload,
    basis: replayFields.basis.payload,
    contractElements: replayFields.contractElements.payload,
    dataProvenance: {
      ticker: REPLAY_PROVENANCE.HTX_HISTORICAL,
      kline15m: REPLAY_PROVENANCE.HTX_HISTORICAL,
      kline1h: REPLAY_PROVENANCE.HTX_HISTORICAL,
      kline4h: REPLAY_PROVENANCE.HTX_HISTORICAL,
      kline1d: REPLAY_PROVENANCE.HTX_HISTORICAL,
      fundingCurrent: currentFunding ? REPLAY_PROVENANCE.HTX_HISTORICAL : REPLAY_PROVENANCE.HISTORICAL_UNAVAILABLE,
      fundingHistory: fundingVisible.length ? REPLAY_PROVENANCE.HTX_HISTORICAL : REPLAY_PROVENANCE.HISTORICAL_UNAVAILABLE,
      depth: replayFields.depth.provenance,
      oiCurrent: replayFields.openInterest.provenance,
      oiHistory: replayFields.openInterest.provenance,
      eliteAccount: replayFields.eliteAccount.provenance,
      elitePosition: replayFields.elitePosition.provenance,
      liquidations: replayFields.liquidations.provenance,
      markPrice: replayFields.markPrice.provenance,
      premium: replayFields.premium.provenance,
      basis: replayFields.basis.provenance,
      contractElements: replayFields.contractElements.provenance
    },
    replay: {
      pointInTime: true,
      visibleAt,
      eventCandle: closed,
      closedCounts: Object.fromEntries(Object.entries(byTimeframe).map(([key, rows]) => [key, rows.length])),
      unavailableSources,
      fieldStatus: Object.fromEntries(Object.entries(replayFields).map(([key, value]) => [key, {
        provenance: value.provenance,
        ageMs: value.ageMs ?? null,
        available: Boolean(value.payload),
        error: value.error ?? null
      }])),
      availableSources: Object.entries(replayFields).filter(([, item]) => item.payload).map(([key]) => key),
      eventTimeNotAfterVisibleAt: Object.values(replayFields).every((item) => !item.eventTime || Number(item.eventTime) <= visibleAt)
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
