import { join } from "node:path";
import { hashObject, readJson, round, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const USER_AGENT = "btc-htx-paper-research/2.0";
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const ALLOWED_HOSTS = new Set([
  "api.huobi.pro", "api.hbdm.com", "community-api.coinmetrics.io", "www.deribit.com",
  "api.binance.com", "fapi.binance.com", "api.bybit.com", "www.okx.com", "fred.stlouisfed.org"
]);

const SOURCE_VERSIONS = Object.freeze({
  htxSpot: "HTX_SPOT_PUBLIC_V1", coinMetrics: "COIN_METRICS_COMMUNITY_V4",
  deribit: "DERIBIT_PUBLIC_API_V2", binance: "BINANCE_PUBLIC_REST_V3_FAPI_V1",
  bybit: "BYBIT_PUBLIC_V5", okx: "OKX_PUBLIC_V5", fred: "FREDGRAPH_CSV_CURRENT_RELEASE_V1"
});

function assertPublicUrl(url) {
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error(`Blocked external data URL: ${url.origin}`);
  }
  for (const key of ["api_key", "apikey", "signature", "token"]) {
    if (url.searchParams.has(key)) throw new Error(`Credentials are forbidden in external URL: ${key}`);
  }
}

async function fetchPayload(url, { fetchImpl = fetch, type = "json", timeoutMs = 25_000 } = {}) {
  assertPublicUrl(url);
  const response = await fetchImpl(url, {
    method: "GET", headers: { accept: type === "json" ? "application/json" : "text/csv", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${url.hostname}${url.pathname} HTTP ${response.status}`);
  return type === "json" ? response.json() : response.text();
}

function coverage(rows, expectedIntervalMs = null) {
  const sorted = rows.filter((item) => Number.isFinite(Number(item.timestamp))).sort((a, b) => a.timestamp - b.timestamp);
  let missing = 0;
  let duplicate = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index].timestamp - sorted[index - 1].timestamp;
    if (delta === 0) duplicate += 1;
    else if (expectedIntervalMs && delta > expectedIntervalMs * 1.5) missing += Math.max(0, Math.round(delta / expectedIntervalMs) - 1);
  }
  const expected = sorted.length + missing;
  return {
    start: sorted.length ? new Date(sorted[0].timestamp).toISOString() : null,
    end: sorted.length ? new Date(sorted.at(-1).timestamp).toISOString() : null,
    observations: sorted.length, missing, duplicates: duplicate, missingRate: expected ? round(missing / expected, 8) : 1
  };
}

async function persistDataset(directory, id, rows, metadata) {
  const prior = await readJson(join(directory, `${id}.json`), []);
  const merged = [...new Map([...prior, ...rows].map((item) => [Number(item.timestamp), item])).values()]
    .filter((item) => Number.isFinite(Number(item.timestamp))).sort((a, b) => a.timestamp - b.timestamp);
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  await writeJsonAtomic(join(directory, `${id}.json`), merged);
  const stats = coverage(merged, metadata.expectedIntervalMs);
  const manifest = {
    schemaVersion: 1, datasetId: id, source: metadata.source, sourceVersion: metadata.sourceVersion,
    authentication: "none", writeOperations: false, downloadedAt: new Date().toISOString(), updateMode: "MERGE_BY_TIMESTAMP_INCREMENTAL",
    timestampSemantics: metadata.timestampSemantics, historicalCoverage: { from: stats.start, to: stats.end },
    observations: stats.observations, expectedIntervalMs: metadata.expectedIntervalMs ?? null, missingRate: stats.missingRate,
    gaps: stats.missing, duplicateTimestamps: stats.duplicates, pointInTime: metadata.pointInTime,
    releaseLag: metadata.releaseLag ?? null, revisionPolicy: metadata.revisionPolicy ?? "SOURCE_NOT_EXPECTED_TO_REVISE",
    free: metadata.free !== false, credentialRequired: false, reproducible: metadata.reproducible !== false,
    sha256: sha256(serialized), limitations: metadata.limitations ?? []
  };
  manifest.manifestHash = hashObject(manifest);
  await writeJsonAtomic(join(directory, `${id}.manifest.json`), manifest);
  return { rows: merged, manifest };
}

function weekStartUtcMonday(timestamp) {
  const date = new Date(timestamp);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
}

function calculate200Week(candles, now = Date.now()) {
  const weeks = new Map();
  for (const candle of candles) {
    const start = weekStartUtcMonday(candle.timestamp);
    if (start + WEEK_MS > now) continue;
    const existing = weeks.get(start);
    if (!existing || candle.timestamp > existing.timestamp) weeks.set(start, candle);
  }
  const rows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, candle]) => ({ timestamp, close: candle.close }));
  if (rows.length < 200) return { status: "insufficient evidence", completedWeeks: rows.length, requiredWeeks: 200 };
  const window = rows.slice(-200);
  const value = window.reduce((sum, row) => sum + row.close, 0) / 200;
  const current = candles.at(-1).close;
  return {
    status: "research-only", formulaVersion: "HTX_SPOT_WEEKLY_CLOSE_UTC_MONDAY_SMA200_V1",
    definition: "Latest 200 fully completed UTC-Monday weeks; arithmetic mean of each week's final HTX BTC/USDT spot daily close.",
    completedWeeks: rows.length, windowStart: new Date(window[0].timestamp).toISOString(),
    windowEnd: new Date(window.at(-1).timestamp + WEEK_MS).toISOString(), valueUsdt: round(value, 2),
    currentSpotCloseUsdt: round(current, 2), distancePct: round((current / value - 1) * 100, 4),
    productionWeight: 0, allowedEffectIfValidated: "LONG_TERM risk multiplier only", intradayTriggerAllowed: false
  };
}

async function fetchHtxSpotDaily(fetchImpl) {
  const url = new URL("https://api.huobi.pro/market/history/kline");
  url.search = new URLSearchParams({ symbol: "btcusdt", period: "1day", size: "2000" });
  const payload = await fetchPayload(url, { fetchImpl });
  if (payload?.status !== "ok") throw new Error(`HTX spot status=${payload?.status ?? "unknown"}`);
  return (payload.data ?? []).map((row) => ({
    timestamp: Number(row.id) * 1000, open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volumeBtc: Number(row.amount ?? 0), turnoverUsdt: Number(row.vol ?? 0)
  })).filter((row) => [row.timestamp, row.open, row.high, row.low, row.close].every(Number.isFinite));
}

async function fetchCoinMetrics(fetchImpl, metrics, start = "2010-07-18") {
  const url = new URL("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics");
  url.search = new URLSearchParams({ assets: "btc", metrics: metrics.join(","), frequency: "1d", start_time: start, page_size: "10000" });
  const payload = await fetchPayload(url, { fetchImpl });
  if (!Array.isArray(payload?.data)) throw new Error("Coin Metrics payload has no data array");
  return payload.data.map((row) => ({ timestamp: new Date(row.time).getTime(), ...Object.fromEntries(metrics.map((key) => [key, Number(row[key])])) }))
    .filter((row) => Number.isFinite(row.timestamp));
}

async function fetchDeribitDvol(fetchImpl, startMs = Date.UTC(2021, 3, 1), endMs = Date.now()) {
  const rows = [];
  const chunkMs = 360 * DAY_MS;
  for (let from = startMs; from <= endMs; from += chunkMs) {
    const to = Math.min(endMs, from + chunkMs - DAY_MS);
    const url = new URL("https://www.deribit.com/api/v2/public/get_volatility_index_data");
    url.search = new URLSearchParams({ currency: "BTC", start_timestamp: String(from), end_timestamp: String(to), resolution: "1D" });
    const payload = await fetchPayload(url, { fetchImpl });
    for (const item of payload?.result?.data ?? []) rows.push({ timestamp: Number(item[0]), open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]) });
  }
  return rows;
}

function parseOptionName(name) {
  const match = /^BTC-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-([CP])$/.exec(name);
  if (!match) return null;
  const day = Number(match[1].slice(0, -5));
  const monthName = match[1].slice(-5, -2);
  const year = 2000 + Number(match[1].slice(-2));
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(monthName);
  return month < 0 ? null : { expiry: Date.UTC(year, month, day, 8), strike: Number(match[2]), type: match[3] };
}

async function fetchDeribitOptionsCurrent(fetchImpl) {
  const url = new URL("https://www.deribit.com/api/v2/public/get_book_summary_by_currency");
  url.search = new URLSearchParams({ currency: "BTC", kind: "option" });
  const payload = await fetchPayload(url, { fetchImpl });
  const now = Date.now();
  const instruments = (payload?.result ?? []).map((item) => ({ ...(parseOptionName(item.instrument_name) ?? {}), ...item }))
    .filter((item) => item.expiry > now && finite(item.mark_iv) && Number(item.open_interest) > 0);
  const expiries = [...new Set(instruments.map((item) => item.expiry))].sort((a, b) => a - b).slice(0, 4);
  const surface = expiries.map((expiry) => {
    const group = instruments.filter((item) => item.expiry === expiry);
    const underlying = Number(group.find((item) => finite(item.underlying_price))?.underlying_price);
    const nearestStrike = group.map((item) => item.strike).sort((a, b) => Math.abs(a - underlying) - Math.abs(b - underlying))[0];
    const call = group.find((item) => item.strike === nearestStrike && item.type === "C");
    const put = group.find((item) => item.strike === nearestStrike && item.type === "P");
    return {
      expiry, daysToExpiry: round((expiry - now) / DAY_MS, 3), underlying: round(underlying, 2), strike: nearestStrike,
      callIv: finite(call?.mark_iv) ? Number(call.mark_iv) : null, putIv: finite(put?.mark_iv) ? Number(put.mark_iv) : null,
      atmIv: finite(call?.mark_iv) && finite(put?.mark_iv) ? round((Number(call.mark_iv) + Number(put.mark_iv)) / 2, 4) : null,
      atmPutMinusCallSkew: finite(call?.mark_iv) && finite(put?.mark_iv) ? round(Number(put.mark_iv) - Number(call.mark_iv), 4) : null,
      openInterest: round(group.reduce((sum, item) => sum + Number(item.open_interest ?? 0), 0), 4)
    };
  });
  return { timestamp: now, instruments: instruments.length, surface };
}

async function fetchCrossExchange(fetchImpl) {
  const definitions = [
    ["binance", "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT", (p) => ({ timestamp: Number(p.time), markPrice: Number(p.markPrice), indexPrice: Number(p.indexPrice), fundingRate: Number(p.lastFundingRate), oiUsd: null })],
    ["binance_oi", "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT", (p) => ({ timestamp: Date.now(), oiContracts: Number(p.openInterest) })],
    ["bybit", "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT", (p) => { const x = p.result?.list?.[0] ?? {}; return { timestamp: Number(p.time), markPrice: Number(x.markPrice), indexPrice: Number(x.indexPrice), fundingRate: Number(x.fundingRate), oiUsd: Number(x.openInterestValue) }; }],
    ["okx", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP", (p) => { const x = p.data?.[0] ?? {}; return { timestamp: Number(x.ts), lastPrice: Number(x.last), volume24hContracts: Number(x.vol24h), volume24hCcy: Number(x.volCcy24h) }; }],
    ["okx_oi", "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP", (p) => { const x = p.data?.[0] ?? {}; return { timestamp: Number(x.ts), oiContracts: Number(x.oi), oiBtc: Number(x.oiCcy), oiUsd: Number(x.oiUsd) }; }],
    ["htx", "https://api.hbdm.com/linear-swap-ex/market/detail/merged?contract_code=BTC-USDT", (p) => { const x = p.tick ?? {}; return { timestamp: Number(p.ts), lastPrice: Number(x.close), volume24hBtc: Number(x.amount), volume24hContracts: Number(x.vol) }; }],
    ["htx_funding", "https://api.hbdm.com/linear-swap-api/v1/swap_funding_rate?contract_code=BTC-USDT", (p) => ({ timestamp: Number(p.ts), fundingRate: Number(p.data?.funding_rate) })]
  ];
  const settled = await Promise.allSettled(definitions.map(async ([key, address, adapter]) => [key, adapter(await fetchPayload(new URL(address), { fetchImpl }))]));
  const current = {};
  const errors = {};
  settled.forEach((item, index) => item.status === "fulfilled" ? current[item.value[0]] = item.value[1] : errors[definitions[index][0]] = item.reason.message);
  const historyDefinitions = [
    ["binance-funding", "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000", (p) => p.map((x) => ({ timestamp: Number(x.fundingTime), fundingRate: Number(x.fundingRate), markPrice: Number(x.markPrice) }))],
    ["binance-oi-1h", "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500", (p) => p.map((x) => ({ timestamp: Number(x.timestamp), oiContracts: Number(x.sumOpenInterest), oiUsd: Number(x.sumOpenInterestValue) }))],
    ["bybit-funding", "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200", (p) => (p.result?.list ?? []).map((x) => ({ timestamp: Number(x.fundingRateTimestamp), fundingRate: Number(x.fundingRate) }))],
    ["bybit-oi-1h", "https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1h&limit=200", (p) => (p.result?.list ?? []).map((x) => ({ timestamp: Number(x.timestamp), oiContracts: Number(x.openInterest) }))],
    ["okx-funding", "https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=400", (p) => (p.data ?? []).map((x) => ({ timestamp: Number(x.fundingTime), fundingRate: Number(x.realizedRate ?? x.fundingRate) }))]
  ];
  const histories = {};
  const historyErrors = {};
  const historySettled = await Promise.allSettled(historyDefinitions.map(async ([key, address, adapter]) => [key, adapter(await fetchPayload(new URL(address), { fetchImpl }))]));
  historySettled.forEach((item, index) => item.status === "fulfilled" ? histories[item.value[0]] = item.value[1] : historyErrors[historyDefinitions[index][0]] = item.reason.message);
  return { timestamp: Date.now(), current, histories, errors: { ...errors, ...historyErrors } };
}

async function fetchSpotFuturesContext(fetchImpl) {
  const sources = [
    ["binanceSpot", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT", (p) => ({ price: Number(p.lastPrice), volumeBtc: Number(p.volume), turnoverUsdt: Number(p.quoteVolume), bid: Number(p.bidPrice), ask: Number(p.askPrice) })],
    ["binanceFutures", "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT", (p) => ({ price: Number(p.lastPrice), volumeBtc: Number(p.volume), turnoverUsdt: Number(p.quoteVolume) })],
    ["bybitSpot", "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT", (p) => { const x = p.result?.list?.[0] ?? {}; return { price: Number(x.lastPrice), volumeBtc: Number(x.volume24h), turnoverUsdt: Number(x.turnover24h), bid: Number(x.bid1Price), ask: Number(x.ask1Price) }; }],
    ["bybitFutures", "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT", (p) => { const x = p.result?.list?.[0] ?? {}; return { price: Number(x.lastPrice), volumeBtc: Number(x.volume24h), turnoverUsdt: Number(x.turnover24h) }; }],
    ["okxSpot", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", (p) => { const x = p.data?.[0] ?? {}; return { price: Number(x.last), volumeBtc: Number(x.vol24h), turnoverUsdt: Number(x.volCcy24h), bid: Number(x.bidPx), ask: Number(x.askPx) }; }],
    ["okxFutures", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP", (p) => { const x = p.data?.[0] ?? {}; return { price: Number(x.last), volumeContracts: Number(x.vol24h), turnoverBtc: Number(x.volCcy24h) }; }]
  ];
  const output = {};
  const errors = {};
  const settled = await Promise.allSettled(sources.map(async ([key, address, adapter]) => [key, adapter(await fetchPayload(new URL(address), { fetchImpl }))]));
  settled.forEach((item, index) => item.status === "fulfilled" ? output[item.value[0]] = item.value[1] : errors[sources[index][0]] = item.reason.message);
  const comparisons = ["binance", "bybit", "okx"].map((exchange) => {
    const spot = output[`${exchange}Spot`];
    const future = output[`${exchange}Futures`];
    return {
      exchange, spotPrice: spot?.price ?? null, futuresPrice: future?.price ?? null,
      basisPct: spot?.price && future?.price ? round((future.price / spot.price - 1) * 100, 6) : null,
      spotVolumeBtc: spot?.volumeBtc ?? null, futuresVolumeBtc: future?.volumeBtc ?? null,
      futuresToSpotVolume: spot?.volumeBtc && future?.volumeBtc ? round(future.volumeBtc / spot.volumeBtc, 4) : null,
      spotSpreadPct: spot?.bid && spot?.ask ? round((spot.ask - spot.bid) / ((spot.ask + spot.bid) / 2) * 100, 6) : null
    };
  });
  return { timestamp: Date.now(), sources: output, comparisons, errors };
}

function parseFredCsv(csv, series) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = { timestamp: new Date(`${values[0]}T00:00:00Z`).getTime() + DAY_MS, observationDate: values[0] };
    series.forEach((key) => { const value = Number(values[header.indexOf(key)]); row[key] = Number.isFinite(value) ? value : null; });
    return row;
  }).filter((row) => Number.isFinite(row.timestamp));
}

async function fetchMacro(fetchImpl) {
  const series = ["DFF", "DGS10", "DTWEXBGS", "SP500"];
  const results = await Promise.all(series.map(async (key) => {
    const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
    url.search = new URLSearchParams({ id: key, cosd: "2015-01-01" });
    return parseFredCsv(await fetchPayload(url, { fetchImpl, type: "text" }), [key]);
  }));
  const merged = new Map();
  results.forEach((rows, index) => rows.forEach((row) => {
    const current = merged.get(row.timestamp) ?? { timestamp: row.timestamp, observationDate: row.observationDate };
    current[series[index]] = row[series[index]];
    merged.set(row.timestamp, current);
  }));
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function feature({ key, layer, status, source, manifest = null, value = null, reason, quality = null, pointInTime = null }) {
  return {
    key, layer, status, source, updatedAt: new Date().toISOString(),
    historicalCoverageStart: manifest?.historicalCoverage?.from ?? null, historicalCoverageEnd: manifest?.historicalCoverage?.to ?? null,
    observations: manifest?.observations ?? (value ? 1 : 0), missingRate: manifest?.missingRate ?? (value ? 0 : 1),
    dataQuality: quality ?? (manifest?.observations ? "REAL_DATA_RESEARCH_ONLY" : "UNAVAILABLE"),
    pointInTime: pointInTime ?? manifest?.pointInTime ?? false, dataVersion: manifest?.manifestHash ?? null,
    free: manifest?.free ?? true, credentialRequired: manifest ? manifest.credentialRequired : false,
    reproducible: manifest?.reproducible ?? false, value, productionWeight: 0,
    oosIncrementalContribution: null, walkForwardStability: "NOT_PROVEN", reason
  };
}

async function safely(task) {
  try { return { value: await task(), error: null }; } catch (error) { return { value: null, error: error.message }; }
}

export async function auditExternalMarketFeatureCatalog({ directory, fetchImpl = fetch } = {}) {
  if (!directory) throw new Error("External feature audit requires an output directory");
  const [spotResult, mvrvResult, chainResult, dvolResult, optionsResult, crossResult, liquidityResult, macroResult] = await Promise.all([
    safely(() => fetchHtxSpotDaily(fetchImpl)), safely(() => fetchCoinMetrics(fetchImpl, ["PriceUSD", "CapMVRVCur"])),
    safely(() => fetchCoinMetrics(fetchImpl, ["AdrActCnt", "TxCnt"])), safely(() => fetchDeribitDvol(fetchImpl)),
    safely(() => fetchDeribitOptionsCurrent(fetchImpl)), safely(() => fetchCrossExchange(fetchImpl)),
    safely(() => fetchSpotFuturesContext(fetchImpl)), safely(() => fetchMacro(fetchImpl))
  ]);
  const manifests = {};
  if (spotResult.value?.length) manifests.spot = (await persistDataset(directory, "htx-btcusdt-spot-1d", spotResult.value, {
    source: "https://api.huobi.pro/market/history/kline", sourceVersion: SOURCE_VERSIONS.htxSpot, expectedIntervalMs: DAY_MS,
    timestampSemantics: "HTX daily candle open UTC; usable after daily close", pointInTime: true
  })).manifest;
  if (mvrvResult.value?.length) {
    const derived = mvrvResult.value.map((row) => ({ ...row, RealizedPriceUSDDerived: row.CapMVRVCur > 0 ? row.PriceUSD / row.CapMVRVCur : null }));
    manifests.mvrv = (await persistDataset(directory, "coinmetrics-btc-mvrv-realized-price-1d", derived, {
      source: "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics", sourceVersion: SOURCE_VERSIONS.coinMetrics,
      expectedIntervalMs: DAY_MS, timestampSemantics: "UTC daily observation; usable after day close", pointInTime: true,
      revisionPolicy: "Provider may revise network data; manifest hash pins the downloaded version",
      limitations: ["CapRealUSD is not credential-free; RealizedPriceUSDDerived = PriceUSD / CapMVRVCur and is explicitly derived."]
    })).manifest;
  }
  if (chainResult.value?.length) manifests.chain = (await persistDataset(directory, "coinmetrics-btc-onchain-activity-1d", chainResult.value, {
    source: "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics", sourceVersion: SOURCE_VERSIONS.coinMetrics,
    expectedIntervalMs: DAY_MS, timestampSemantics: "UTC daily network metric; usable after day close", pointInTime: true,
    revisionPolicy: "Provider may revise; manifest hash pins each research dataset version"
  })).manifest;
  if (dvolResult.value?.length) manifests.dvol = (await persistDataset(directory, "deribit-btc-dvol-1d", dvolResult.value, {
    source: "https://www.deribit.com/api/v2/public/get_volatility_index_data", sourceVersion: SOURCE_VERSIONS.deribit,
    expectedIntervalMs: DAY_MS, timestampSemantics: "Deribit DVOL daily candle open; usable after close", pointInTime: true,
    limitations: ["DVOL history is not a complete historical option skew/term surface."]
  })).manifest;
  if (crossResult.value) {
    for (const [id, sourceRows] of Object.entries(crossResult.value.histories)) if (sourceRows.length) {
      const funding = id.includes("funding");
      manifests[id] = (await persistDataset(directory, id, sourceRows, {
        source: id.startsWith("binance") ? "Binance public REST" : id.startsWith("bybit") ? "Bybit public V5" : "OKX public V5",
        sourceVersion: id.startsWith("binance") ? SOURCE_VERSIONS.binance : id.startsWith("bybit") ? SOURCE_VERSIONS.bybit : SOURCE_VERSIONS.okx,
        expectedIntervalMs: funding ? 8 * 60 * 60_000 : 60 * 60_000,
        timestampSemantics: funding ? "public funding settlement timestamp" : "public OI observation timestamp", pointInTime: true,
        limitations: ["Public endpoint retention is bounded; manifest contains only rows actually returned."]
      })).manifest;
    }
    await writeJsonAtomic(join(directory, "cross-exchange-current.json"), crossResult.value);
  }
  if (optionsResult.value) await writeJsonAtomic(join(directory, "deribit-options-current.json"), optionsResult.value);
  if (liquidityResult.value) await writeJsonAtomic(join(directory, "spot-vs-futures-current.json"), liquidityResult.value);
  if (macroResult.value?.length) manifests.macro = (await persistDataset(directory, "fred-macro-daily-current-release", macroResult.value, {
    source: "https://fred.stlouisfed.org/graph/fredgraph.csv", sourceVersion: SOURCE_VERSIONS.fred, expectedIntervalMs: DAY_MS,
    timestampSemantics: "Observation date plus conservative one-day availability lag", pointInTime: false,
    revisionPolicy: "CURRENT_RELEASE_ONLY_NO_VINTAGE",
    limitations: ["FRED graph CSV is current revised history, not ALFRED vintages; forbidden from point-in-time production replay."]
  })).manifest;
  const maValue = spotResult.value?.length ? calculate200Week([...spotResult.value].sort((a, b) => a.timestamp - b.timestamp)) : null;
  const latestMvrvRaw = mvrvResult.value?.at(-1);
  const latestMvrv = latestMvrvRaw ? {
    ...latestMvrvRaw,
    RealizedPriceUSDDerived: latestMvrvRaw.CapMVRVCur > 0 ? latestMvrvRaw.PriceUSD / latestMvrvRaw.CapMVRVCur : null
  } : null;
  const latestChain = chainResult.value?.at(-1);
  const latestDvol = dvolResult.value?.at(-1);
  const crossManifests = Object.entries(manifests).filter(([key]) => /binance|bybit|okx/.test(key)).map(([, value]) => value);
  const features = [
    feature({ key: "btc_200_week_ma", layer: "LONG_TERM", status: maValue?.status === "research-only" ? "research-only" : "blocked",
      source: "HTX public BTC/USDT spot daily", manifest: manifests.spot, value: maValue,
      reason: maValue ? "Real history and fixed formula are runnable; weight remains 0 until incremental OOS improvement is proven." : spotResult.error }),
    feature({ key: "btc_rainbow_valuation", layer: "LONG_TERM", status: "blocked", source: "NO_DEFENSIBLE_FIXED_MODEL_SELECTED",
      reason: "No webpage value is scraped. An authoritative fixed Rainbow formula/version plus point-in-time fitting policy was not established.", quality: "BLOCKED_MODEL_PROVENANCE" }),
    feature({ key: "btc_realized_price_mvrv", layer: "LONG_TERM", status: manifests.mvrv ? "research-only" : "blocked",
      source: "Coin Metrics Community API v4", manifest: manifests.mvrv,
      value: latestMvrv ? { timestamp: new Date(latestMvrv.timestamp).toISOString(), mvrv: latestMvrv.CapMVRVCur, realizedPriceUsdDerived: latestMvrv.RealizedPriceUSDDerived, formula: "PriceUSD / CapMVRVCur" } : null,
      reason: manifests.mvrv ? "Real free MVRV history is cataloged; derived realized price is labeled, but no incremental OOS promotion has passed." : mvrvResult.error }),
    feature({ key: "btc_onchain_context", layer: "MEDIUM_TERM", status: manifests.chain ? "research-only" : "blocked",
      source: "Coin Metrics Community API v4", manifest: manifests.chain,
      value: latestChain ? { timestamp: new Date(latestChain.timestamp).toISOString(), activeAddresses: latestChain.AdrActCnt, transactions: latestChain.TxCnt } : null,
      reason: manifests.chain ? "Actual timestamped active-address and transaction-count history exists; weight is 0 pending OOS contribution." : chainResult.error }),
    feature({ key: "btc_options_context", layer: "MEDIUM_TERM", status: manifests.dvol && optionsResult.value ? "research-only" : "blocked",
      source: "Deribit public API v2", manifest: manifests.dvol,
      value: { latestDvol: latestDvol ? { timestamp: new Date(latestDvol.timestamp).toISOString(), close: latestDvol.close } : null, currentSurface: optionsResult.value },
      reason: manifests.dvol ? "Real DVOL history and current ATM IV/skew/term are stored; historical skew/term remains unavailable and is never backfilled." : dvolResult.error,
      quality: manifests.dvol ? "PARTIAL_REAL_DVOL_HISTORY_CURRENT_SURFACE_ONLY" : "BLOCKED" }),
    feature({ key: "cross_exchange_derivatives", layer: "SHORT_TERM", status: crossManifests.length >= 3 ? "research-only" : "blocked",
      source: "Binance/Bybit/OKX/HTX public REST", manifest: crossManifests.sort((a, b) => b.observations - a.observations)[0],
      value: crossResult.value ? { current: crossResult.value.current, manifestCount: crossManifests.length, sourceErrors: crossResult.value.errors } : null,
      reason: crossManifests.length >= 3 ? "Exchange-specific Funding/OI and current snapshots are stored without averaging incompatible units; OOS contribution is unproven." : crossResult.error,
      quality: crossManifests.length >= 3 ? "PARTIAL_REAL_CROSS_EXCHANGE_HISTORY_RETENTION_BOUNDED" : "BLOCKED" }),
    feature({ key: "cross_market_liquidity", layer: "MEDIUM_TERM", status: liquidityResult.value ? "research-only" : "blocked",
      source: "Binance/Bybit/OKX public spot and futures tickers", value: liquidityResult.value,
      reason: liquidityResult.value ? "Real current spot/futures basis, volume relationship and spot spread are captured; full historical liquidity/book data is unavailable." : liquidityResult.error,
      quality: liquidityResult.value ? "CURRENT_REAL_DATA_HISTORY_INSUFFICIENT" : "BLOCKED", pointInTime: true }),
    feature({ key: "macro_market_context", layer: "LONG_TERM", status: manifests.macro ? "research-only" : "blocked",
      source: "FRED graph CSV: DFF/DGS10/DTWEXBGS/SP500", manifest: manifests.macro, value: macroResult.value?.at(-1) ?? null,
      reason: manifests.macro ? "Real current-release history is cached with one-day lag, but no vintage history exists; forbidden in point-in-time replay." : macroResult.error,
      quality: manifests.macro ? "REAL_CURRENT_RELEASE_NOT_POINT_IN_TIME_VINTAGE" : "BLOCKED", pointInTime: false })
  ];
  const result = {
    schemaVersion: 2, runType: "EXTERNAL_FEATURE_REAL_DATA_CATALOG_AUDIT", generatedAt: new Date().toISOString(),
    sourceVersions: SOURCE_VERSIONS, manifests, features,
    errors: { spot: spotResult.error, mvrv: mvrvResult.error, onchain: chainResult.error, dvol: dvolResult.error,
      optionsCurrent: optionsResult.error, crossExchange: crossResult.error, liquidity: liquidityResult.error, macro: macroResult.error },
    safety: { authenticationUsed: false, apiKeysUsed: false, privateEndpointsUsed: false, writeOperations: false },
    honesty: "research-only means real data exists but production contribution is unproven; blocked means no reliable runnable data/model. Current-only observations are never backfilled."
  };
  result.auditHash = hashObject(result);
  await writeJsonAtomic(join(directory, "external-feature-audit.json"), result);
  return result;
}
