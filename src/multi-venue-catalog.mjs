import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashObject, parseIso, readJson, resolveResearchPath, round, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DATASET_ID = "btc-usdt-multi-venue-funding-v1";
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 12 * HOUR_MS;
const USER_AGENT = "btc-htx-paper-multi-venue-research/1";

export const MULTI_VENUE_FUNDING_SOURCES = Object.freeze({
  binance: Object.freeze({
    origin: "https://fapi.binance.com",
    path: "/fapi/v1/fundingRate",
    sourceVersion: "BINANCE_USDS_M_FUNDING_REST_V1",
    pageSize: 1000,
    timestampSemantics: "fundingTime is the realized funding settlement timestamp"
  }),
  bybit: Object.freeze({
    origin: "https://api.bybit.com",
    path: "/v5/market/funding/history",
    sourceVersion: "BYBIT_V5_LINEAR_FUNDING_HISTORY",
    pageSize: 200,
    timestampSemantics: "fundingRateTimestamp is the realized funding settlement timestamp"
  }),
  okx: Object.freeze({
    origin: "https://www.okx.com",
    path: "/api/v5/public/funding-rate-history",
    sourceVersion: "OKX_V5_FUNDING_RATE_HISTORY",
    pageSize: 100,
    timestampSemantics: "fundingTime is the realized funding settlement timestamp"
  })
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

function assertPublicFundingUrl(exchange, url) {
  const source = MULTI_VENUE_FUNDING_SOURCES[exchange];
  if (!source || url.protocol !== "https:" || url.origin !== source.origin || url.pathname !== source.path || url.username || url.password) {
    throw new Error(`Blocked multi-venue URL for ${exchange}`);
  }
  for (const key of ["apiKey", "api_key", "signature", "timestamp", "recvWindow", "token"]) {
    if (url.searchParams.has(key)) throw new Error(`Credentials/signatures are forbidden in multi-venue URL: ${key}`);
  }
}

async function fetchJson(exchange, url, { fetchImpl = fetch, attempts = 4, delay = sleep } = {}) {
  assertPublicFundingUrl(exchange, url);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) {
        const error = new Error(`${exchange} public funding HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
        throw error;
      }
      const payload = await response.json();
      if (exchange === "bybit" && Number(payload?.retCode) !== 0) throw new Error(`bybit retCode=${payload?.retCode}: ${payload?.retMsg ?? "unknown"}`);
      if (exchange === "okx" && String(payload?.code) !== "0") throw new Error(`okx code=${payload?.code}: ${payload?.msg ?? "unknown"}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await delay(Math.max(Number(error.retryAfterMs ?? 0), Math.min(400 * 2 ** (attempt - 1), 8_000)));
    }
  }
  throw lastError;
}

function normalize(exchange, timestamp, fundingRate, extra = {}) {
  if (!finite(timestamp) || !finite(fundingRate)) return null;
  return {
    exchange,
    instrument: exchange === "okx" ? "BTC-USDT-SWAP" : "BTCUSDT",
    timestamp: Number(timestamp),
    visibleAt: Number(timestamp),
    fundingRate: Number(fundingRate),
    ...extra,
    provenance: `${exchange.toUpperCase()}_PUBLIC_HISTORICAL`,
    pointInTime: true
  };
}

function deduplicate(rows) {
  return [...new Map(rows.filter(Boolean).map((row) => [`${row.exchange}:${row.timestamp}`, row])).values()]
    .sort((a, b) => a.timestamp - b.timestamp || a.exchange.localeCompare(b.exchange));
}

async function downloadBinance(startMs, endMs, options) {
  const source = MULTI_VENUE_FUNDING_SOURCES.binance;
  const rows = [];
  let cursor = startMs;
  let pages = 0;
  while (cursor <= endMs) {
    const url = new URL(source.path, source.origin);
    url.search = new URLSearchParams({ symbol: "BTCUSDT", startTime: String(cursor), endTime: String(endMs), limit: String(source.pageSize) });
    const payload = await fetchJson("binance", url, options);
    pages += 1;
    const pageRows = (Array.isArray(payload) ? payload : []).map((item) => normalize(
      "binance", item.fundingTime, item.fundingRate,
      { markPrice: finite(item.markPrice) ? Number(item.markPrice) : null }
    )).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
    rows.push(...pageRows);
    options.onProgress?.({ exchange: "binance", pages, rows: rows.length });
    const latest = pageRows.at(-1)?.timestamp;
    if (!pageRows.length || pageRows.length < source.pageSize || !finite(latest) || latest >= endMs) break;
    if (latest < cursor) throw new Error("Binance funding pagination did not advance");
    cursor = latest + 1;
  }
  return { rows: deduplicate(rows).filter((row) => row.timestamp >= startMs && row.timestamp <= endMs), pages };
}

async function downloadBybit(startMs, endMs, options) {
  const source = MULTI_VENUE_FUNDING_SOURCES.bybit;
  const rows = [];
  let cursorEnd = endMs;
  let pages = 0;
  while (cursorEnd >= startMs) {
    const url = new URL(source.path, source.origin);
    url.search = new URLSearchParams({
      category: "linear", symbol: "BTCUSDT", startTime: String(startMs), endTime: String(cursorEnd), limit: String(source.pageSize)
    });
    const payload = await fetchJson("bybit", url, options);
    pages += 1;
    const pageRows = (payload?.result?.list ?? []).map((item) => normalize("bybit", item.fundingRateTimestamp, item.fundingRate))
      .filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
    rows.push(...pageRows);
    options.onProgress?.({ exchange: "bybit", pages, rows: rows.length });
    const oldest = pageRows[0]?.timestamp;
    if (!pageRows.length || pageRows.length < source.pageSize || !finite(oldest) || oldest <= startMs) break;
    if (oldest > cursorEnd) throw new Error("Bybit funding pagination did not move backwards");
    cursorEnd = oldest - 1;
  }
  return { rows: deduplicate(rows).filter((row) => row.timestamp >= startMs && row.timestamp <= endMs), pages };
}

async function downloadOkx(startMs, endMs, options) {
  const source = MULTI_VENUE_FUNDING_SOURCES.okx;
  const rows = [];
  let after = null;
  let pages = 0;
  while (true) {
    const url = new URL(source.path, source.origin);
    const params = { instId: "BTC-USDT-SWAP", limit: String(source.pageSize) };
    if (after !== null) params.after = String(after);
    url.search = new URLSearchParams(params);
    const payload = await fetchJson("okx", url, options);
    pages += 1;
    const pageRows = (payload?.data ?? []).map((item) => normalize(
      "okx", item.fundingTime, item.realizedRate ?? item.fundingRate,
      { formulaType: item.formulaType ?? null }
    )).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
    rows.push(...pageRows.filter((row) => row.timestamp <= endMs));
    options.onProgress?.({ exchange: "okx", pages, rows: rows.length });
    const oldest = pageRows[0]?.timestamp;
    if (!pageRows.length || pageRows.length < source.pageSize || !finite(oldest) || oldest <= startMs) break;
    if (after !== null && oldest >= after) throw new Error("OKX funding pagination did not move backwards");
    after = oldest;
  }
  return { rows: deduplicate(rows).filter((row) => row.timestamp >= startMs && row.timestamp <= endMs), pages };
}

export async function downloadExchangeFunding(exchange, from, to, options = {}) {
  const startMs = typeof from === "number" ? from : parseIso(from, "from");
  const endMs = typeof to === "number" ? to : parseIso(to, "to");
  if (!(endMs > startMs)) throw new Error("Multi-venue funding range must have to > from");
  if (endMs > Date.now()) throw new Error("Multi-venue historical download cannot request future data");
  if (exchange === "binance") return downloadBinance(startMs, endMs, options);
  if (exchange === "bybit") return downloadBybit(startMs, endMs, options);
  if (exchange === "okx") return downloadOkx(startMs, endMs, options);
  throw new Error(`Unknown multi-venue exchange: ${exchange}`);
}

function sourceCoverage(rows) {
  return {
    observations: rows.length,
    from: rows.length ? new Date(rows[0].timestamp).toISOString() : null,
    to: rows.length ? new Date(rows.at(-1).timestamp).toISOString() : null
  };
}

export function defaultMultiVenueCatalogDirectory() {
  return resolveResearchPath("catalog", DATASET_ID);
}

export async function updateMultiVenueFundingDataset({
  from,
  to,
  directory = defaultMultiVenueCatalogDirectory(),
  exchanges = Object.keys(MULTI_VENUE_FUNDING_SOURCES),
  fetchImpl = fetch,
  attempts = 4,
  delay = sleep,
  onProgress = null
} = {}) {
  if (!from || !to) throw new Error("Multi-venue update requires explicit from/to");
  const startMs = parseIso(from, "from");
  const endMs = parseIso(to, "to");
  if (!(endMs > startMs) || endMs > Date.now()) throw new Error("Multi-venue update requires a completed historical range");
  const unknown = exchanges.filter((exchange) => !MULTI_VENUE_FUNDING_SOURCES[exchange]);
  if (unknown.length) throw new Error(`Unknown multi-venue exchanges: ${unknown.join(", ")}`);
  const prior = await readJson(join(directory, "funding.json"), []);
  const settled = await Promise.allSettled(exchanges.map(async (exchange) => [exchange, await downloadExchangeFunding(exchange, startMs, endMs, {
    fetchImpl, attempts, delay, onProgress
  })]));
  const downloaded = [];
  const errors = {};
  const pageCounts = {};
  settled.forEach((result, index) => {
    const exchange = exchanges[index];
    if (result.status === "fulfilled") {
      downloaded.push(...result.value[1].rows);
      pageCounts[exchange] = result.value[1].pages;
    } else errors[exchange] = result.reason.message;
  });
  if (!downloaded.length && !prior.length) throw new Error(`All multi-venue funding downloads failed: ${JSON.stringify(errors)}`);
  const rows = deduplicate([...prior, ...downloaded]);
  const serialized = `${JSON.stringify(rows, null, 2)}\n`;
  await writeJsonAtomic(join(directory, "funding.json"), rows);
  const sources = Object.fromEntries(Object.entries(MULTI_VENUE_FUNDING_SOURCES).map(([exchange, source]) => {
    const exchangeRows = rows.filter((row) => row.exchange === exchange);
    return [exchange, {
      source: `${source.origin}${source.path}`,
      sourceVersion: source.sourceVersion,
      authentication: "none",
      writeOperations: false,
      pointInTime: true,
      timestampSemantics: source.timestampSemantics,
      coverage: sourceCoverage(exchangeRows),
      pagesThisUpdate: pageCounts[exchange] ?? 0,
      updateError: errors[exchange] ?? null
    }];
  }));
  const manifest = {
    schemaVersion: 1,
    datasetId: DATASET_ID,
    instrument: "BTC-USDT perpetual funding",
    requestedCoverage: { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() },
    downloadedAt: new Date().toISOString(),
    updateMode: "MERGE_BY_EXCHANGE_AND_SETTLEMENT_TIMESTAMP",
    pointInTime: true,
    futureBackfillUsed: false,
    authentication: "none",
    writeOperations: false,
    records: rows.length,
    sha256: sha256(serialized),
    sources,
    errors,
    status: Object.keys(errors).length ? "PARTIAL" : "COMPLETE",
    limitations: [
      "Only timestamped realized funding settlements are persisted.",
      "Cross-venue OI is not averaged because contract units and retention windows differ by venue.",
      "A venue failure remains explicit and is never replaced with another venue's value."
    ]
  };
  manifest.manifestHash = hashObject({ ...manifest, manifestHash: undefined });
  await writeJsonAtomic(join(directory, "manifest.json"), manifest);
  return { directory, rows, manifest, fetched: downloaded.length };
}

export async function loadMultiVenueFundingDataset(directory = defaultMultiVenueCatalogDirectory()) {
  const [manifest, text] = await Promise.all([
    readJson(join(directory, "manifest.json")),
    readFile(join(directory, "funding.json"), "utf8")
  ]);
  if (!manifest) throw new Error(`Multi-venue manifest not found: ${directory}`);
  if (sha256(text) !== manifest.sha256) throw new Error("Multi-venue funding cache hash does not match manifest");
  return { directory, manifest, funding: JSON.parse(text) };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function pointInTimeFundingContext(rows = [], visibleAt, { maximumAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const latest = new Map();
  for (const row of rows) {
    if (Number(row.timestamp) > visibleAt || Number(row.visibleAt ?? row.timestamp) > visibleAt) continue;
    const prior = latest.get(row.exchange);
    if (!prior || Number(row.timestamp) > Number(prior.timestamp)) latest.set(row.exchange, row);
  }
  const observations = [...latest.values()].map((row) => ({ ...row, ageMs: visibleAt - Number(row.timestamp) }))
    .filter((row) => row.ageMs >= 0 && row.ageMs <= maximumAgeMs)
    .sort((a, b) => a.exchange.localeCompare(b.exchange));
  const rates = observations.map((row) => Number(row.fundingRate)).filter(Number.isFinite);
  const center = median(rates);
  const dispersion = rates.length && center !== null ? Math.max(...rates) - Math.min(...rates) : null;
  return {
    visibleAt,
    pointInTime: true,
    maximumAgeMs,
    venueCount: observations.length,
    observations,
    medianFundingRate: center,
    dispersionFundingRate: dispersion,
    positiveVenues: rates.filter((value) => value > 0).length,
    negativeVenues: rates.filter((value) => value < 0).length,
    neutralVenues: rates.filter((value) => value === 0).length,
    medianFundingRatePct: center === null ? null : round(center * 100, 6),
    dispersionFundingRatePct: dispersion === null ? null : round(dispersion * 100, 6)
  };
}

export async function collectCurrentMultiVenueFunding({ fetchImpl = fetch, now = Date.now } = {}) {
  const visibleAt = Number(now());
  const startMs = visibleAt - 24 * HOUR_MS;
  const settled = await Promise.allSettled(Object.keys(MULTI_VENUE_FUNDING_SOURCES).map(async (exchange) => [
    exchange,
    await downloadExchangeFunding(exchange, startMs, visibleAt, { fetchImpl, attempts: 2 })
  ]));
  const rows = [];
  const errors = {};
  settled.forEach((result, index) => {
    const exchange = Object.keys(MULTI_VENUE_FUNDING_SOURCES)[index];
    if (result.status === "fulfilled") rows.push(...result.value[1].rows);
    else errors[exchange] = result.reason.message;
  });
  return { ...pointInTimeFundingContext(rows, visibleAt), errors, source: "PUBLIC_NO_AUTH" };
}

export const MULTI_VENUE_DATASET = Object.freeze({ id: DATASET_ID, maximumFundingAgeMs: DEFAULT_MAX_AGE_MS });
