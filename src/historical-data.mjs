import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BAR_MS,
  ceilBar,
  floorBar,
  hashObject,
  parseIso,
  readJson,
  resolveResearchPath,
  round,
  sha256,
  writeJsonAtomic
} from "./research-utils.mjs";

const HTX_HOST = "https://api.hbdm.com";
const KLINE_PATH = "/linear-swap-ex/market/history/kline";
const FUNDING_PATH = "/linear-swap-api/v1/swap_historical_funding_rate";
const DATASET_ID = "htx-btc-usdt-linear-15m-v1";
const MAX_KLINE_ROWS = 2000;
const MAX_FUNDING_PAGES = 200;

function assertPublicUrl(url, expectedPath) {
  if (url.origin !== HTX_HOST || url.pathname !== expectedPath) throw new Error("Blocked non-HTX historical URL");
  if (url.username || url.password) throw new Error("Credentials are forbidden in historical URLs");
}

async function fetchJson(url, { fetchImpl = fetch, attempts = 4 } = {}) {
  assertPublicUrl(url, url.pathname);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "btc-htx-paper-research/1.0" },
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.status !== "ok") throw new Error(`HTX status=${payload?.status ?? "unknown"}: ${payload?.err_msg ?? "unknown"}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

function normalizeCandle(row) {
  const candle = {
    timestamp: Number(row.id) * 1000,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volumeBtc: Number(row.amount ?? 0),
    volumeContracts: Number(row.vol ?? 0),
    turnoverUsdt: Number(row.trade_turnover ?? 0),
    trades: Number(row.count ?? 0)
  };
  if (!Number.isInteger(candle.timestamp) || candle.timestamp % BAR_MS !== 0) throw new Error(`Misaligned candle: ${row.id}`);
  if (![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`Invalid OHLC at ${row.id}`);
  }
  if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.low > candle.high) {
    throw new Error(`Broken OHLC relationship at ${row.id}`);
  }
  return candle;
}

function auditCandles(candles, requestedStart, requestedEnd) {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const gaps = [];
  const duplicates = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index].timestamp - sorted[index - 1].timestamp;
    if (delta === 0) duplicates.push(sorted[index].timestamp);
    else if (delta > BAR_MS) {
      for (let missing = sorted[index - 1].timestamp + BAR_MS; missing < sorted[index].timestamp; missing += BAR_MS) gaps.push(missing);
    } else if (delta < BAR_MS) throw new Error(`Non-monotonic candle interval at ${sorted[index].timestamp}`);
  }
  const expectedCount = Math.floor((requestedEnd - requestedStart) / BAR_MS) + 1;
  const inside = sorted.filter((item) => item.timestamp >= requestedStart && item.timestamp <= requestedEnd);
  return {
    candles: sorted,
    gaps,
    duplicates,
    expectedCount,
    observedCount: inside.length,
    boundaryMissing: Math.max(0, expectedCount - inside.length - gaps.filter((ts) => ts >= requestedStart && ts <= requestedEnd).length),
    missingRate: expectedCount ? round((expectedCount - inside.length) / expectedCount, 8) : 0
  };
}

async function fetchKlineRange(startMs, endMs, options = {}) {
  const chunks = [];
  const maximumSpan = (MAX_KLINE_ROWS - 1) * BAR_MS;
  for (let cursor = startMs; cursor <= endMs; cursor += maximumSpan + BAR_MS) {
    chunks.push([cursor, Math.min(endMs, cursor + maximumSpan)]);
  }
  const output = [];
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency ?? 3)));
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < chunks.length) {
      const index = cursor++;
      const [fromMs, toMs] = chunks[index];
      const url = new URL(KLINE_PATH, HTX_HOST);
      url.search = new URLSearchParams({
        contract_code: "BTC-USDT",
        period: "15min",
        from: String(fromMs / 1000),
        to: String(toMs / 1000)
      });
      assertPublicUrl(url, KLINE_PATH);
      const payload = await fetchJson(url, options);
      const normalized = (payload.data ?? []).map(normalizeCandle);
      output.push(...normalized);
      options.onProgress?.({ type: "kline", completed: index + 1, total: chunks.length, fromMs, toMs, rows: normalized.length });
    }
  });
  await Promise.all(workers);
  return output;
}

async function fetchFundingRange(startMs, endMs, options = {}) {
  const rows = [];
  for (let page = 1; page <= MAX_FUNDING_PAGES; page += 1) {
    const url = new URL(FUNDING_PATH, HTX_HOST);
    url.search = new URLSearchParams({ contract_code: "BTC-USDT", page_index: String(page), page_size: "50" });
    assertPublicUrl(url, FUNDING_PATH);
    const payload = await fetchJson(url, options);
    const pageRows = payload.data?.data ?? [];
    for (const row of pageRows) {
      const timestamp = Number(row.funding_time);
      if (timestamp >= startMs && timestamp <= endMs) {
        const rate = Number(row.realized_rate ?? row.funding_rate);
        if (Number.isFinite(timestamp) && Number.isFinite(rate)) rows.push({
          timestamp,
          fundingRate: rate,
          averagePremiumIndex: Number.isFinite(Number(row.avg_premium_index)) ? Number(row.avg_premium_index) : null,
          rateField: row.realized_rate === null || row.realized_rate === undefined ? "funding_rate" : "realized_rate"
        });
      }
    }
    options.onProgress?.({ type: "funding", completed: page, rows: rows.length });
    const oldest = Math.min(...pageRows.map((row) => Number(row.funding_time)).filter(Number.isFinite));
    if (!pageRows.length || oldest < startMs || page >= Number(payload.data?.total_page ?? page)) break;
  }
  return [...new Map(rows.map((row) => [row.timestamp, row])).values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function defaultCatalogDirectory() { return resolveResearchPath("catalog", DATASET_ID); }

export async function updateHistoricalDataset({
  from,
  to,
  directory = defaultCatalogDirectory(),
  fetchImpl = fetch,
  concurrency = 3,
  onProgress = null
} = {}) {
  if (!from || !to) throw new Error("Historical update requires explicit --from and --to; implicit cherry-picked periods are forbidden");
  const requestedStart = ceilBar(parseIso(from, "from"));
  const requestedEnd = floorBar(parseIso(to, "to"));
  if (requestedEnd <= requestedStart) throw new Error("Historical range must include at least two 15m bars");
  if (requestedEnd >= floorBar(Date.now())) throw new Error("Historical dataset may only include completed 15m bars");
  const candlesPath = join(directory, "candles-15m.json");
  const fundingPath = join(directory, "funding.json");
  const priorCandles = await readJson(candlesPath, []);
  const priorFunding = await readJson(fundingPath, []);
  const options = { fetchImpl, concurrency, onProgress };
  const fetchedCandles = await fetchKlineRange(requestedStart, requestedEnd, options);
  const fetchedFunding = await fetchFundingRange(requestedStart, requestedEnd + 8 * 60 * 60 * 1000, options);
  const candleMap = new Map([...priorCandles, ...fetchedCandles].map((row) => [row.timestamp, row]));
  const fundingMap = new Map([...priorFunding, ...fetchedFunding].map((row) => [row.timestamp, row]));
  const allCandles = [...candleMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  const allFunding = [...fundingMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  const audit = auditCandles(allCandles, requestedStart, requestedEnd);
  const serializedCandles = `${JSON.stringify(allCandles, null, 2)}\n`;
  const serializedFunding = `${JSON.stringify(allFunding, null, 2)}\n`;
  await writeJsonAtomic(candlesPath, allCandles);
  await writeJsonAtomic(fundingPath, allFunding);
  const manifest = {
    schemaVersion: 1,
    datasetId: DATASET_ID,
    instrument: "BTC-USDT",
    market: "HTX USDT-M linear perpetual",
    provider: "HTX_PUBLIC",
    source: {
      kline: `${HTX_HOST}${KLINE_PATH}`,
      funding: `${HTX_HOST}${FUNDING_PATH}`,
      authentication: "none",
      writeOperations: false
    },
    interval: "15m",
    timestampSemantics: "timestamp is candle open time in UTC; candle becomes visible at timestamp + 15m",
    requestedCoverage: { from: new Date(requestedStart).toISOString(), to: new Date(requestedEnd).toISOString() },
    actualCoverage: {
      from: allCandles.length ? new Date(allCandles[0].timestamp).toISOString() : null,
      to: allCandles.length ? new Date(allCandles.at(-1).timestamp).toISOString() : null
    },
    downloadedAt: new Date().toISOString(),
    candles: {
      count: allCandles.length,
      expectedInRequestedRange: audit.expectedCount,
      observedInRequestedRange: audit.observedCount,
      gaps: audit.gaps.map((timestamp) => new Date(timestamp).toISOString()),
      duplicateTimestamps: audit.duplicates.map((timestamp) => new Date(timestamp).toISOString()),
      boundaryMissing: audit.boundaryMissing,
      missingRate: audit.missingRate,
      sha256: sha256(serializedCandles)
    },
    funding: {
      count: allFunding.length,
      coverageFrom: allFunding.length ? new Date(allFunding[0].timestamp).toISOString() : null,
      coverageTo: allFunding.length ? new Date(allFunding.at(-1).timestamp).toISOString() : null,
      sha256: sha256(serializedFunding),
      missingPolicy: "Funding settlement uses only the exact timestamped historical rate. Between settlements, the last observed rate may be labeled and used only as an entry-cost estimate; it is never represented as the future settlement rate."
    },
    quality: audit.gaps.length || audit.boundaryMissing ? "DEGRADED" : "VALID",
    historyLimitations: [
      "Historical order book snapshots are not supplied by this catalog and are never reconstructed from candles.",
      "Historical elite positioning, liquidation stream, OI and basis are unavailable unless separately timestamped by a reliable source.",
      "The frozen Champion therefore retains its data gate and may WAIT in replay."
    ]
  };
  manifest.manifestHash = hashObject({ ...manifest, manifestHash: undefined });
  await writeJsonAtomic(join(directory, "manifest.json"), manifest);
  return { directory, manifest, fetched: { candles: fetchedCandles.length, funding: fetchedFunding.length } };
}

export async function loadHistoricalDataset(directory = defaultCatalogDirectory()) {
  const manifestPath = join(directory, "manifest.json");
  const [manifest, candlesText, fundingText] = await Promise.all([
    readJson(manifestPath),
    readFile(join(directory, "candles-15m.json"), "utf8"),
    readFile(join(directory, "funding.json"), "utf8")
  ]);
  if (!manifest) throw new Error(`Dataset manifest not found: ${manifestPath}`);
  if (sha256(candlesText) !== manifest.candles.sha256) throw new Error("Candle cache hash does not match manifest");
  if (sha256(fundingText) !== manifest.funding.sha256) throw new Error("Funding cache hash does not match manifest");
  const candles = JSON.parse(candlesText);
  const funding = JSON.parse(fundingText);
  const audit = auditCandles(candles, candles[0].timestamp, candles.at(-1).timestamp);
  if (audit.duplicates.length) throw new Error("Dataset contains duplicate candle timestamps");
  return { directory, manifest, candles, funding };
}

export const HISTORICAL_SOURCE = Object.freeze({ HTX_HOST, KLINE_PATH, FUNDING_PATH, DATASET_ID, BAR_MS });
