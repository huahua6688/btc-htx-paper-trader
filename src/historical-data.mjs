import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HtxPublicResearchClient, HTX_RESEARCH_ENDPOINTS } from "./htx-public-research-client.mjs";
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

const HTX_HOST = "https://api.hbdm.vn";
const KLINE_PATH = "/linear-swap-ex/market/history/kline";
const FUNDING_PATH = "/linear-swap-api/v1/swap_historical_funding_rate";
const DATASET_ID = "htx-btc-usdt-linear-research-v2";
const MAX_KLINE_ROWS = 2000;
const MAX_FUNDING_PAGES = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const HISTORICAL_DATA_TYPES = Object.freeze([
  "kline", "funding", "openInterest", "eliteAccount", "elitePosition",
  "markPrice", "premium", "basis", "liquidations", "settlement", "depth"
]);

export const HTX_HISTORICAL_CAPABILITIES = Object.freeze({
  kline: { mode: "REQUESTED_RANGE", pagination: "from/to chunks up to 2000 rows", interval: "15m", verifiedEarliest: "2020-10-21T09:00:00.000Z" },
  funding: { mode: "PAGINATED_HISTORY", pagination: "page_index/page_size up to 50", interval: "8h settlement", verifiedEarliest: "2020-10-21T16:00:00.000Z" },
  openInterest: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 200 },
  eliteAccount: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 30 },
  elitePosition: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 30 },
  markPrice: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 2000 },
  premium: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 2000 },
  basis: { mode: "BOUNDED_LATEST_WINDOW", pagination: "none", interval: "60m", maximumRows: 2000 },
  liquidations: { mode: "LATEST_50_ONLY", pagination: "v3 endpoint has no historical page cursor", interval: "irregular", maximumRows: 50 },
  settlement: {
    mode: "PAGED_BOUNDED_RETENTION",
    pagination: "start_time/end_time plus page_index/page_size up to 50",
    interval: "8h settlement",
    retentionNote: "HTX returns only its currently retained recent window; requested start/end do not imply arbitrary historical coverage"
  },
  depth: { mode: "HISTORICAL_UNAVAILABLE", pagination: "none", interval: "snapshot only" }
});

function assertPublicUrl(url, expectedPath) {
  if (url.origin !== HTX_HOST || url.pathname !== expectedPath) throw new Error("Blocked non-HTX historical URL");
  if (url.username || url.password) throw new Error("Credentials are forbidden in historical URLs");
}

async function fetchJson(url, { fetchImpl = fetch, attempts = 5, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  assertPublicUrl(url, url.pathname);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "btc-htx-paper-research/1.0" },
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        const retryAfter = response.headers?.get?.("retry-after");
        error.retryAfterMs = response.status === 429 && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 0;
        throw error;
      }
      const payload = await response.json();
      if (payload?.status !== "ok") throw new Error(`HTX status=${payload?.status ?? "unknown"}: ${payload?.err_msg ?? "unknown"}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(Math.max(Number(error.retryAfterMs ?? 0), Math.min(500 * 2 ** (attempt - 1), 15_000)));
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
      options.rawPayloadHashes?.kline?.push(hashObject(payload));
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
    options.rawPayloadHashes?.funding?.push(hashObject(payload));
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

async function fetchSettlementRange(startMs, endMs, options = {}) {
  const client = options.researchClient ?? new HtxPublicResearchClient({
    fetchImpl: options.fetchImpl,
    delay: options.delay,
    attempts: options.attempts
  });
  const records = [];
  const payloadHashes = [];
  let fetchedAt = null;
  let sourceUrl = null;
  let totalPages = 1;
  for (let page = 1; page <= Math.min(20_000, totalPages); page += 1) {
    const result = await client.get(HTX_RESEARCH_ENDPOINTS.settlement, {
      contract_code: "BTC-USDT",
      start_time: startMs,
      end_time: endMs,
      page_index: page,
      page_size: 50
    });
    fetchedAt = result.fetchedAt;
    sourceUrl = result.url;
    payloadHashes.push(hashObject(result.payload));
    totalPages = Math.max(1, Number(result.payload?.data?.total_page ?? 1));
    const rows = result.payload?.data?.settlement_record ?? [];
    for (const row of rows) {
      const eventTime = Number(row.settlement_time);
      if (eventTime < startMs || eventTime > endMs || !Number.isFinite(eventTime)) continue;
      records.push({
        eventTime,
        visibleAt: eventTime,
        observedAt: result.fetchedAt,
        fetchedAt: result.fetchedAt,
        source: "HTX_PUBLIC",
        provenance: "HTX_HISTORICAL",
        schemaVersion: 2,
        rawPayloadHash: payloadHashes.at(-1),
        normalized: row
      });
    }
    options.onProgress?.({ type: "settlement", completed: page, total: totalPages, rows: records.length });
    if (!rows.length || page >= totalPages) break;
  }
  const sorted = mergeTimedRecords([], records);
  return {
    records: sorted,
    rawPayloadHash: hashObject(payloadHashes),
    sourceUrl,
    fetchedAt,
    endpointCoverage: {
      earliest: sorted.length ? new Date(sorted[0].eventTime).toISOString() : null,
      latest: sorted.length ? new Date(sorted.at(-1).eventTime).toISOString() : null,
      records: sorted.length
    },
    intervalMs: 8 * HOUR_MS
  };
}

const BOUNDED_REQUESTS = Object.freeze({
  openInterest: { path: HTX_RESEARCH_ENDPOINTS.openInterest, params: { contract_code: "BTC-USDT", period: "60min", amount_type: 2, size: 200 }, intervalMs: HOUR_MS },
  eliteAccount: { path: HTX_RESEARCH_ENDPOINTS.eliteAccount, params: { contract_code: "BTC-USDT", period: "60min" }, intervalMs: HOUR_MS },
  elitePosition: { path: HTX_RESEARCH_ENDPOINTS.elitePosition, params: { contract_code: "BTC-USDT", period: "60min" }, intervalMs: HOUR_MS },
  markPrice: { path: HTX_RESEARCH_ENDPOINTS.markPrice, params: { contract_code: "BTC-USDT", period: "60min", size: 2000 }, intervalMs: HOUR_MS },
  premium: { path: HTX_RESEARCH_ENDPOINTS.premium, params: { contract_code: "BTC-USDT", period: "60min", size: 2000 }, intervalMs: HOUR_MS },
  basis: { path: HTX_RESEARCH_ENDPOINTS.basis, params: { contract_code: "BTC-USDT", period: "60min", basis_price_type: "close", size: 2000 }, intervalMs: HOUR_MS },
  liquidations: { path: HTX_RESEARCH_ENDPOINTS.liquidations, params: { contract: "BTC-USDT", trade_type: 0 }, intervalMs: null }
});

function rowsFromBoundedPayload(type, payload) {
  const data = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
  if (type === "openInterest") return data.flatMap((item) => item.tick ?? []);
  if (["eliteAccount", "elitePosition"].includes(type)) return data.flatMap((item) => item.list ?? []);
  return Array.isArray(payload.data) ? payload.data : [];
}

function eventTimeFor(type, row) {
  const raw = type === "liquidations" ? row.created_at : ["markPrice", "premium", "basis"].includes(type) ? Number(row.id) * 1000 : row.ts;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function mergeTimedRecords(prior, fetched) {
  const records = new Map(prior.map((item) => [item.eventTime, item]));
  for (const item of fetched) {
    const existing = records.get(item.eventTime);
    if (!existing) {
      records.set(item.eventTime, item);
      continue;
    }
    const knownHashes = new Set([
      existing.rawPayloadHash,
      ...(existing.revisions ?? []).map((revision) => revision.rawPayloadHash)
    ].filter(Boolean));
    if (!knownHashes.has(item.rawPayloadHash)) {
      records.set(item.eventTime, {
        ...existing,
        revisions: [
          ...(existing.revisions ?? []),
          { observedAt: item.observedAt, rawPayloadHash: item.rawPayloadHash, normalized: item.normalized }
        ]
      });
    }
  }
  return [...records.values()].sort((a, b) => a.eventTime - b.eventTime);
}

function auditTimedRecords(records, intervalMs = null) {
  const duplicates = [];
  const gaps = [];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.eventTime)) duplicates.push(record.eventTime);
    seen.add(record.eventTime);
  }
  if (intervalMs) {
    for (let index = 1; index < records.length; index += 1) {
      const delta = records[index].eventTime - records[index - 1].eventTime;
      if (delta > intervalMs) gaps.push({ after: records[index - 1].eventTime, before: records[index].eventTime, missingIntervals: Math.floor(delta / intervalMs) - 1 });
    }
  }
  return { duplicates, gaps };
}

async function fetchBoundedResearchSeries(type, startMs, endMs, options = {}) {
  const request = BOUNDED_REQUESTS[type];
  if (!request) throw new Error(`Unknown bounded HTX research series: ${type}`);
  const client = options.researchClient ?? new HtxPublicResearchClient({
    fetchImpl: options.fetchImpl,
    delay: options.delay,
    attempts: options.attempts
  });
  const result = await client.get(request.path, request.params);
  const rawPayloadHash = hashObject(result.payload);
  const allRows = rowsFromBoundedPayload(type, result.payload)
    .map((row) => ({ row, eventTime: eventTimeFor(type, row) }))
    .filter((item) => item.eventTime !== null)
    .sort((a, b) => a.eventTime - b.eventTime);
  const records = allRows
    .filter((item) => item.eventTime >= startMs && item.eventTime <= endMs)
    .map(({ row, eventTime }) => ({
      eventTime,
      visibleAt: request.intervalMs ? eventTime + request.intervalMs : eventTime,
      observedAt: result.fetchedAt,
      fetchedAt: result.fetchedAt,
      source: "HTX_PUBLIC",
      provenance: "HTX_HISTORICAL",
      schemaVersion: 2,
      rawPayloadHash,
      normalized: row
    }));
  return {
    records,
    rawPayloadHash,
    sourceUrl: result.url,
    fetchedAt: result.fetchedAt,
    endpointCoverage: {
      earliest: allRows.length ? new Date(allRows[0].eventTime).toISOString() : null,
      latest: allRows.length ? new Date(allRows.at(-1).eventTime).toISOString() : null,
      records: allRows.length
    },
    intervalMs: request.intervalMs
  };
}

function sourceManifest(type, records, {
  file = null,
  fileSha256 = null,
  payloadHashes = [],
  endpointCoverage = null,
  fetchedAt = null,
  fetchError = null
} = {}) {
  const capability = HTX_HISTORICAL_CAPABILITIES[type];
  const audit = auditTimedRecords(records, BOUNDED_REQUESTS[type]?.intervalMs ?? null);
  const historicalUnavailable = capability.mode === "HISTORICAL_UNAVAILABLE";
  return {
    type,
    availability: fetchError ? "LIVE_FAILURE" : historicalUnavailable ? "HISTORICAL_UNAVAILABLE" : records.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE_FOR_REQUESTED_RANGE",
    capability,
    source: type === "depth" ? `${HTX_HOST}${HTX_RESEARCH_ENDPOINTS.depth}`
      : type === "settlement" ? `${HTX_HOST}${HTX_RESEARCH_ENDPOINTS.settlement}`
        : BOUNDED_REQUESTS[type] ? `${HTX_HOST}${BOUNDED_REQUESTS[type].path}` : null,
    provenance: records.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE",
    schemaVersion: 2,
    records: records.length,
    earliest: records.length ? new Date(records[0].eventTime).toISOString() : null,
    latest: records.length ? new Date(records.at(-1).eventTime).toISOString() : null,
    fetchedAt,
    observedAt: fetchedAt,
    endpointCoverage,
    rawPayloadHashes: [...new Set(payloadHashes)],
    file,
    sha256: fileSha256,
    gaps: audit.gaps,
    duplicateEventTimes: audit.duplicates,
    error: fetchError,
    futureBackfillUsed: false
  };
}

export function defaultCatalogDirectory() { return resolveResearchPath("catalog", DATASET_ID); }

export async function updateHistoricalDataset({
  from,
  to,
  directory = defaultCatalogDirectory(),
  fetchImpl = fetch,
  concurrency = 3,
  onProgress = null,
  dataTypes = HISTORICAL_DATA_TYPES,
  researchClient = null,
  delay = undefined,
  attempts = undefined
} = {}) {
  if (!from || !to) throw new Error("Historical update requires explicit --from and --to; implicit cherry-picked periods are forbidden");
  const requestedStart = ceilBar(parseIso(from, "from"));
  const requestedEnd = floorBar(parseIso(to, "to"));
  if (requestedEnd <= requestedStart) throw new Error("Historical range must include at least two 15m bars");
  if (requestedEnd >= floorBar(Date.now())) throw new Error("Historical dataset may only include completed 15m bars");
  const selected = new Set(dataTypes);
  for (const type of selected) if (!HISTORICAL_DATA_TYPES.includes(type)) throw new Error(`Unknown historical data type: ${type}`);
  if (!selected.has("kline")) throw new Error("Catalog V2 requires kline as its historical clock");
  const candlesPath = join(directory, "candles-15m.json");
  const fundingPath = join(directory, "funding.json");
  const checkpointPath = join(directory, "checkpoint.json");
  const priorManifest = await readJson(join(directory, "manifest.json"), {});
  const priorCandles = await readJson(candlesPath, []);
  const priorFunding = await readJson(fundingPath, []);
  const rangeKey = `${requestedStart}:${requestedEnd}`;
  const loadedCheckpoint = await readJson(checkpointPath, null);
  const checkpoint = loadedCheckpoint?.rangeKey === rangeKey
    ? loadedCheckpoint
    : { schemaVersion: 2, datasetId: DATASET_ID, rangeKey, requestedStart, requestedEnd, completed: {}, attempts: {} };
  const saveCheckpoint = async (status = "IN_PROGRESS") => {
    checkpoint.status = status;
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
  };
  const rawPayloadHashes = {
    kline: [...(priorManifest.sources?.kline?.rawPayloadHashes ?? [])],
    funding: [...(priorManifest.sources?.funding?.rawPayloadHashes ?? [])]
  };
  const options = { fetchImpl, concurrency, onProgress, rawPayloadHashes, delay, attempts, researchClient };
  const fetched = Object.fromEntries(HISTORICAL_DATA_TYPES.map((type) => [type, 0]));

  let allCandles = priorCandles;
  if (!checkpoint.completed.kline || !priorCandles.length) {
    checkpoint.attempts.kline = Number(checkpoint.attempts.kline ?? 0) + 1;
    const fetchedCandles = await fetchKlineRange(requestedStart, requestedEnd, options);
    fetched.kline = fetchedCandles.length;
    allCandles = [...new Map([...priorCandles, ...fetchedCandles].map((row) => [row.timestamp, row])).values()].sort((a, b) => a.timestamp - b.timestamp);
    await writeJsonAtomic(candlesPath, allCandles);
    checkpoint.completed.kline = { at: new Date().toISOString(), records: allCandles.length };
    await saveCheckpoint();
  }

  let allFunding = priorFunding;
  if (selected.has("funding") && (!checkpoint.completed.funding || !priorFunding.length)) {
    checkpoint.attempts.funding = Number(checkpoint.attempts.funding ?? 0) + 1;
    const fetchedFunding = await fetchFundingRange(requestedStart, requestedEnd, options);
    fetched.funding = fetchedFunding.length;
    allFunding = [...new Map([...priorFunding, ...fetchedFunding].map((row) => [row.timestamp, row])).values()].sort((a, b) => a.timestamp - b.timestamp);
    await writeJsonAtomic(fundingPath, allFunding);
    checkpoint.completed.funding = { at: new Date().toISOString(), records: allFunding.length };
    await saveCheckpoint();
  } else if (!selected.has("funding") && !(await readJson(fundingPath, null))) {
    await writeJsonAtomic(fundingPath, []);
  }

  const audit = auditCandles(allCandles, requestedStart, requestedEnd);
  const serializedCandles = `${JSON.stringify(allCandles, null, 2)}\n`;
  const serializedFunding = `${JSON.stringify(allFunding, null, 2)}\n`;
  const sources = {};
  const series = {};
  const fetchErrors = [];

  const candleRecords = allCandles.filter((row) => row.timestamp >= requestedStart && row.timestamp <= requestedEnd);
  sources.kline = {
    type: "kline",
    availability: candleRecords.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE_FOR_REQUESTED_RANGE",
    capability: HTX_HISTORICAL_CAPABILITIES.kline,
    source: `${HTX_HOST}${KLINE_PATH}`,
    provenance: candleRecords.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE",
    schemaVersion: 2,
    timestampSemantics: "eventTime is candle open; visibleAt is eventTime + 15m",
    records: candleRecords.length,
    earliest: candleRecords.length ? new Date(candleRecords[0].timestamp).toISOString() : null,
    latest: candleRecords.length ? new Date(candleRecords.at(-1).timestamp).toISOString() : null,
    fetchedAt: checkpoint.completed.kline?.at ?? null,
    rawPayloadHashes: [...new Set(rawPayloadHashes.kline)],
    file: "candles-15m.json",
    sha256: sha256(serializedCandles),
    gaps: audit.gaps.map((timestamp) => ({ eventTime: timestamp })),
    duplicateEventTimes: audit.duplicates,
    futureBackfillUsed: false
  };
  const fundingInRange = allFunding.filter((row) => row.timestamp >= requestedStart && row.timestamp <= requestedEnd);
  const fundingAudit = auditTimedRecords(fundingInRange.map((row) => ({ eventTime: row.timestamp })), 8 * HOUR_MS);
  sources.funding = {
    type: "funding",
    availability: selected.has("funding") ? fundingInRange.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE_FOR_REQUESTED_RANGE" : "NOT_REQUESTED",
    capability: HTX_HISTORICAL_CAPABILITIES.funding,
    source: `${HTX_HOST}${FUNDING_PATH}`,
    provenance: fundingInRange.length ? "HTX_HISTORICAL" : "HISTORICAL_UNAVAILABLE",
    schemaVersion: 2,
    timestampSemantics: "exact funding settlement time; last observed rate may only be labeled as an estimate between settlements",
    records: fundingInRange.length,
    earliest: fundingInRange.length ? new Date(fundingInRange[0].timestamp).toISOString() : null,
    latest: fundingInRange.length ? new Date(fundingInRange.at(-1).timestamp).toISOString() : null,
    fetchedAt: checkpoint.completed.funding?.at ?? null,
    rawPayloadHashes: [...new Set(rawPayloadHashes.funding)],
    file: "funding.json",
    sha256: sha256(serializedFunding),
    gaps: fundingAudit.gaps,
    duplicateEventTimes: fundingAudit.duplicates,
    futureBackfillUsed: false
  };

  for (const type of HISTORICAL_DATA_TYPES.filter((item) => !["kline", "funding"].includes(item))) {
    const relativeFile = `series/${type}.json`;
    const path = join(directory, relativeFile);
    let records = await readJson(path, []);
    if (!selected.has(type)) {
      sources[type] = { ...sourceManifest(type, records), availability: "NOT_REQUESTED" };
      series[type] = records;
      continue;
    }
    if (type === "depth") {
      if (!checkpoint.completed.depth) {
        await writeJsonAtomic(path, []);
        checkpoint.completed.depth = { at: new Date().toISOString(), records: 0, reason: "HISTORICAL_UNAVAILABLE" };
        await saveCheckpoint();
      }
      records = [];
      sources.depth = sourceManifest("depth", records, { file: relativeFile, fileSha256: sha256(`${JSON.stringify(records, null, 2)}\n`) });
      series.depth = records;
      continue;
    }
    let result = null;
    let fetchError = null;
    if (!checkpoint.completed[type]) {
      checkpoint.attempts[type] = Number(checkpoint.attempts[type] ?? 0) + 1;
      try {
        result = type === "settlement"
          ? await fetchSettlementRange(requestedStart, requestedEnd, options)
          : await fetchBoundedResearchSeries(type, requestedStart, requestedEnd, options);
        fetched[type] = result.records.length;
        records = mergeTimedRecords(records, result.records);
        await writeJsonAtomic(path, records);
        checkpoint.completed[type] = {
          at: result.fetchedAt,
          records: records.length,
          endpointCoverage: result.endpointCoverage,
          rawPayloadHash: result.rawPayloadHash
        };
        await saveCheckpoint();
      } catch (error) {
        fetchError = error.message;
        fetchErrors.push({ type, error: error.message });
      }
    }
    const serialized = `${JSON.stringify(records, null, 2)}\n`;
    const completed = checkpoint.completed[type];
    sources[type] = sourceManifest(type, records, {
      file: relativeFile,
      fileSha256: await readJson(path, null) ? sha256(serialized) : null,
      payloadHashes: completed?.rawPayloadHash ? [completed.rawPayloadHash] : [],
      endpointCoverage: result?.endpointCoverage ?? completed?.endpointCoverage ?? null,
      fetchedAt: result?.fetchedAt ?? completed?.at ?? null,
      fetchError
    });
    series[type] = records;
  }

  const manifest = {
    schemaVersion: 2,
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
      count: fundingInRange.length,
      coverageFrom: fundingInRange.length ? new Date(fundingInRange[0].timestamp).toISOString() : null,
      coverageTo: fundingInRange.length ? new Date(fundingInRange.at(-1).timestamp).toISOString() : null,
      sha256: sha256(serializedFunding),
      missingPolicy: "Funding settlement uses only the exact timestamped historical rate. Between settlements, the last observed rate may be labeled and used only as an entry-cost estimate; it is never represented as the future settlement rate."
    },
    sources,
    checkpoint: {
      path: "checkpoint.json",
      status: fetchErrors.length ? "PARTIAL" : "COMPLETE",
      completed: checkpoint.completed,
      resumable: true,
      idempotent: true
    },
    quality: fetchErrors.length || audit.gaps.length || audit.boundaryMissing ? "DEGRADED" : "VALID",
    fetchErrors,
    historyLimitations: [
      "Depth has no HTX historical endpoint and is never reconstructed from candles.",
      "OI, elite ratios, mark, premium and basis are bounded latest-window endpoints without arbitrary historical pagination.",
      "Settlement history is an HTX-retention-bounded recent window, is retained for venue-risk diagnostics, and is not treated as an independent directional alpha factor.",
      "The legacy 90-day liquidation endpoint is offline; v3 exposes only the latest 50 observations, so deeper history must accumulate in the self archive.",
      "A missing historical field remains null with explicit provenance; current values are never copied backwards."
    ]
  };
  manifest.manifestHash = hashObject({ ...manifest, manifestHash: undefined });
  await writeJsonAtomic(join(directory, "manifest.json"), manifest);
  await saveCheckpoint(fetchErrors.length ? "PARTIAL" : "COMPLETE");
  return { directory, manifest, fetched, series };
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
  const series = {};
  for (const type of HISTORICAL_DATA_TYPES.filter((item) => !["kline", "funding"].includes(item))) {
    const source = manifest.sources?.[type];
    if (!source?.file) {
      series[type] = [];
      continue;
    }
    const text = await readFile(join(directory, source.file), "utf8");
    if (source.sha256 && sha256(text) !== source.sha256) throw new Error(`${type} cache hash does not match manifest`);
    series[type] = JSON.parse(text);
  }
  return { directory, manifest, candles, funding, series };
}

export const HISTORICAL_SOURCE = Object.freeze({ HTX_HOST, KLINE_PATH, FUNDING_PATH, DATASET_ID, BAR_MS, capabilities: HTX_HISTORICAL_CAPABILITIES });
