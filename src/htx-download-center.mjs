import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { hashObject, readJson, resolveResearchPath, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DOWNLOAD_ORIGIN = "https://futures.htx.com";
const DOWNLOAD_PREFIX = "/data/historical_data/";
const DOWNLOAD_BASE = `${DOWNLOAD_ORIGIN}${DOWNLOAD_PREFIX}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const KLINE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_NORMALIZED_ARCHIVE_BYTES = 20 * 1024 * 1024;

export const HTX_DOWNLOAD_CENTER_AUDIT = Object.freeze({
  auditedAt: "2026-08-24T00:00:00.000Z",
  officialLandingPage: "https://www.htx.com/futures/data/landing_page",
  officialInstitutionPage: "https://www.htx.com/en-us/institutions",
  serviceAdvertisedStart: "2026-02-01",
  verifiedLatestCompletedDate: "2026-08-23",
  settlementRestIsDownloadCenter: false,
  method: "Official landing-page route audit plus direct public archive and .CHECKSUM verification; no authenticated/private endpoint"
});

export const HTX_DOWNLOAD_CENTER_SOURCES = Object.freeze({
  futuresKline: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "KLINE", interval: "15m",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m candle open; visibleAt is eventTime + 15m"
  },
  futuresTrades: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "TRADES",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `futures/daily/trades/BTC-USDT-PERP/BTC-USDT-PERP-trades-${date}.zip`,
    pitSemantics: "each trade carries exchange ts; archive is not transformed unless explicitly requested"
  },
  futuresDepth: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "ORDER_BOOK_L2_150",
    firstVerifiedDate: "2026-05-28", lastVerifiedDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `futures/daily/orderbook/lv150/BTC-USDT-PERP/BTC-USDT-PERP-l2orderbook-150lv-${date}.tar.gz`,
    pitSemantics: "each snapshot/update carries exchange ts; archive is not transformed unless explicitly requested"
  },
  futuresMarkPrice: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "MARK_PRICE_KLINE", interval: "15m",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/mark-klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-mark-price-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m mark-price candle open; visibleAt is eventTime + 15m"
  },
  futuresIndexPrice: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "INDEX_PRICE_KLINE", interval: "15m",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/index-klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-index-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m index-price candle open; visibleAt is eventTime + 15m"
  },
  futuresFunding: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "FUNDING_RATE",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/funding-rates/BTC-USDT-PERP/BTC-USDT-PERP-fundingRates-${date}.zip`,
    pitSemantics: "eventTime and visibleAt are the official fundingTime"
  },
  spotKline: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "KLINE", interval: "15m",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `spot/daily/klines/BTC-USDT/15m/BTC-USDT-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m candle open; visibleAt is eventTime + 15m"
  },
  spotTrades: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "TRADES",
    firstVerifiedDate: "2026-02-01", lastVerifiedDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `spot/daily/trades/BTC-USDT/BTC-USDT-trades-${date}.zip`,
    pitSemantics: "each trade carries exchange ts; archive is not transformed unless explicitly requested"
  },
  spotDepth: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "ORDER_BOOK_L2_400",
    firstVerifiedDate: "2026-05-28", lastVerifiedDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `spot/daily/orderbook/lv400/BTC-USDT/BTC-USDT-l2orderbook-400lv-${date}.tar.gz`,
    pitSemantics: "each snapshot/update carries exchange ts; archive is not transformed unless explicitly requested"
  }
});

export const HTX_DOWNLOAD_CENTER_TYPES = Object.freeze(Object.keys(HTX_DOWNLOAD_CENTER_SOURCES));

export function defaultHtxDownloadCenterDirectory() {
  return resolveResearchPath("catalog", "htx-btc-usdt-linear-research-v2", "download-center");
}

function assertDownloadUrl(url) {
  if (url.origin !== DOWNLOAD_ORIGIN || !url.pathname.startsWith(DOWNLOAD_PREFIX)) {
    throw new Error("Blocked non-HTX Download Center URL");
  }
  if (url.username || url.password || url.search) throw new Error("Credentials and query strings are forbidden in Download Center URLs");
}

export function htxDownloadCenterUrl(type, date, { checksum = false } = {}) {
  const source = HTX_DOWNLOAD_CENTER_SOURCES[type];
  if (!source) throw new Error(`Unknown HTX Download Center type: ${type}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid UTC archive date: ${date}`);
  const url = new URL(`${source.path({ date })}${checksum ? ".CHECKSUM" : ""}`, DOWNLOAD_BASE);
  assertDownloadUrl(url);
  return url;
}

async function request(url, { fetchImpl = fetch, method = "GET", attempts = 3 } = {}) {
  assertDownloadUrl(url);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { accept: "application/octet-stream,text/plain", "user-agent": "btc-htx-paper-research/1.0" },
        signal: AbortSignal.timeout(30_000)
      });
      if (response.status === 404) return response;
      if (!response.ok) throw new Error(`HTX Download Center HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

export function extractSingleCsvZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`Expected one CSV in archive, found ${entries}`);
  const central = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt32LE(central) !== 0x02014b50) throw new Error("Invalid ZIP central-directory record");
  const method = buffer.readUInt16LE(central + 10);
  const compressedSize = buffer.readUInt32LE(central + 20);
  const uncompressedSize = buffer.readUInt32LE(central + 24);
  if (compressedSize > MAX_NORMALIZED_ARCHIVE_BYTES || uncompressedSize > MAX_NORMALIZED_ARCHIVE_BYTES) {
    throw new Error("PIT-normalized archive exceeds the fixed safe size limit");
  }
  const fileNameLength = buffer.readUInt16LE(central + 28);
  const localOffset = buffer.readUInt32LE(central + 42);
  const fileName = buffer.subarray(central + 46, central + 46 + fileNameLength).toString("utf8");
  if (!fileName.endsWith(".csv") || fileName.includes("/") || fileName.includes("\\")) throw new Error("Archive member must be one flat CSV file");
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local-file record");
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
  if (!content) throw new Error(`Unsupported ZIP compression method: ${method}`);
  return { fileName, csv: content.toString("utf8") };
}

export function parseDownloadCenterCsv(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const values = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { values.push(value); value = ""; }
      else value += char;
    }
    values.push(value);
    return values;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseLine(line)[index] ?? ""])));
}

function numericObject(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (["instId", "action", "side", "tradeId"].includes(key) || value === "") return [key, value];
    const numeric = Number(value);
    return [key, Number.isFinite(numeric) ? numeric : value];
  }));
}

function normalizeRows(type, rows, archive) {
  const isFunding = type === "futuresFunding";
  return rows.map((row) => {
    const normalized = numericObject(row);
    const rawTime = Number(isFunding ? row.fundingTime : row.ts);
    const eventTime = isFunding ? rawTime : rawTime < 1e12 ? rawTime * 1000 : rawTime;
    if (!Number.isFinite(eventTime) || eventTime <= 0) throw new Error(`${type} row has invalid event time`);
    const visibleAt = isFunding ? eventTime : eventTime + KLINE_INTERVAL_MS;
    return {
      eventTime,
      visibleAt,
      observedAt: archive.downloadedAt,
      source: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026",
      provenance: "HTX_HISTORICAL_DOWNLOAD",
      schemaVersion: 1,
      archiveDate: archive.date,
      archivePath: archive.path,
      archiveSha256: archive.sha256,
      officialChecksum: archive.officialChecksum,
      normalized
    };
  });
}

function dateOnly(value, label) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value : new Date(value).toISOString().slice(0, 10);
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}: ${value}`);
  return { date, ms };
}

function enumerateDates(from, to, nowMs) {
  const start = dateOnly(from, "from");
  const end = dateOnly(to, "to");
  if (end.ms < start.ms) throw new Error("Download Center range is reversed");
  if (end.ms + DAY_MS > nowMs) throw new Error("Download Center only accepts completed UTC dates");
  const dates = [];
  for (let value = start.ms; value <= end.ms; value += DAY_MS) {
    if (dates.length >= 370) throw new Error("Download Center update is capped at 370 UTC dates per run");
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

function parseOfficialChecksum(text, expectedFile) {
  const match = text.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
  if (!match || match[2] !== expectedFile) throw new Error("Invalid HTX .CHECKSUM response");
  return match[1].toLowerCase();
}

function mergeRecords(prior, fetched) {
  const key = (row) => `${row.eventTime}:${row.normalized?.instId ?? ""}`;
  return [...new Map([...prior, ...fetched].map((row) => [key(row), row])).values()].sort((a, b) => a.eventTime - b.eventTime);
}

export async function updateHtxDownloadCenterCatalog({
  from,
  to,
  directory = defaultHtxDownloadCenterDirectory(),
  dataTypes = HTX_DOWNLOAD_CENTER_TYPES,
  fetchImpl = fetch,
  nowMs = Date.now(),
  onProgress = null
} = {}) {
  if (!from || !to) throw new Error("Download Center update requires explicit completed UTC --from and --to dates");
  const dates = enumerateDates(from, to, nowMs);
  const selected = [...new Set(dataTypes)];
  for (const type of selected) if (!HTX_DOWNLOAD_CENTER_TYPES.includes(type)) throw new Error(`Unknown HTX Download Center type: ${type}`);
  const prior = await readJson(join(directory, "manifest.json"), {});
  const archiveMap = new Map((prior.archives ?? []).map((item) => [`${item.type}:${item.date}`, item]));
  const series = {};
  const errors = [];

  for (const type of selected) {
    const source = HTX_DOWNLOAD_CENTER_SOURCES[type];
    const relativeSeriesFile = `series/${type}.json`;
    let records = source.ingestion === "PIT_NORMALIZED" ? await readJson(join(directory, relativeSeriesFile), []) : [];
    for (const date of dates) {
      const archiveUrl = htxDownloadCenterUrl(type, date);
      const archivePath = archiveUrl.pathname.slice("/data/".length);
      try {
        const checksumResponse = await request(htxDownloadCenterUrl(type, date, { checksum: true }), { fetchImpl });
        if (checksumResponse.status === 404) {
          archiveMap.set(`${type}:${date}`, {
            type, date, path: archivePath, url: archiveUrl.toString(), availability: "HISTORICAL_UNAVAILABLE",
            provenance: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026", checkedAt: new Date(nowMs).toISOString(),
            reason: date < source.firstVerifiedDate ? `before first verified ${source.firstVerifiedDate}` : "official archive returned 404"
          });
          continue;
        }
        const officialChecksum = parseOfficialChecksum(await checksumResponse.text(), basename(archiveUrl.pathname));
        if (source.ingestion === "CATALOGED_ON_DEMAND") {
          const head = await request(archiveUrl, { fetchImpl, method: "HEAD" });
          if (head.status === 404) throw new Error("Archive checksum exists but archive returned 404");
          archiveMap.set(`${type}:${date}`, {
            type, date, path: archivePath, url: archiveUrl.toString(), availability: "CATALOGED_ON_DEMAND",
            provenance: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026", officialChecksum,
            contentLength: Number(head.headers?.get?.("content-length")) || null,
            etag: head.headers?.get?.("etag") ?? null,
            checkedAt: new Date(nowMs).toISOString(), pointInTime: true, pitSemantics: source.pitSemantics,
            downloaded: false, localSha256: null
          });
          continue;
        }
        const response = await request(archiveUrl, { fetchImpl });
        const advertisedSize = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(advertisedSize) && advertisedSize > MAX_NORMALIZED_ARCHIVE_BYTES) {
          throw new Error("PIT-normalized archive exceeds the fixed safe size limit");
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_NORMALIZED_ARCHIVE_BYTES) throw new Error("PIT-normalized archive exceeds the fixed safe size limit");
        const archiveSha256 = createHash("sha256").update(buffer).digest("hex");
        if (archiveSha256 !== officialChecksum) throw new Error(`Official checksum mismatch for ${basename(archiveUrl.pathname)}`);
        const extracted = extractSingleCsvZip(buffer);
        const downloadedAt = new Date(nowMs).toISOString();
        const archive = {
          type, date, path: archivePath, url: archiveUrl.toString(), availability: "INGESTED_PIT",
          provenance: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026", officialChecksum, sha256: archiveSha256,
          csvFile: extracted.fileName, contentLength: buffer.length, etag: response.headers?.get?.("etag") ?? null,
          downloadedAt, pointInTime: true, pitSemantics: source.pitSemantics
        };
        const normalized = normalizeRows(type, parseDownloadCenterCsv(extracted.csv), archive);
        records = mergeRecords(records, normalized);
        archive.records = normalized.length;
        archiveMap.set(`${type}:${date}`, archive);
      } catch (error) {
        errors.push({ type, date, error: error.message });
      }
      onProgress?.({ type, date, completed: archiveMap.has(`${type}:${date}`), errors: errors.length });
    }
    if (source.ingestion === "PIT_NORMALIZED") {
      await writeJsonAtomic(join(directory, relativeSeriesFile), records);
      const serialized = `${JSON.stringify(records, null, 2)}\n`;
      series[type] = {
        file: relativeSeriesFile,
        sha256: sha256(serialized),
        records: records.length,
        earliestEventTime: records.length ? new Date(records[0].eventTime).toISOString() : null,
        latestEventTime: records.length ? new Date(records.at(-1).eventTime).toISOString() : null,
        latestVisibleAt: records.length ? new Date(Math.max(...records.map((item) => item.visibleAt))).toISOString() : null,
        futureBackfillUsed: false
      };
    }
  }

  const archives = [...archiveMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  const sources = Object.fromEntries(Object.entries(HTX_DOWNLOAD_CENTER_SOURCES).map(([type, source]) => [type, {
    ...source,
    path: source.path({ date: "YYYY-MM-DD" }),
    sourceUrl: DOWNLOAD_BASE,
    verifiedCoverage: { from: source.firstVerifiedDate, through: source.lastVerifiedDate, verifiedAt: HTX_DOWNLOAD_CENTER_AUDIT.auditedAt },
    actualArchiveDatesCataloged: archives.filter((item) => item.type === type && item.availability !== "HISTORICAL_UNAVAILABLE").map((item) => item.date),
    status: selected.includes(type)
      ? archives.some((item) => item.type === type && item.availability !== "HISTORICAL_UNAVAILABLE") ? source.ingestion : "HISTORICAL_UNAVAILABLE_FOR_REQUESTED_RANGE"
      : "NOT_REQUESTED"
  }]));
  const manifest = {
    schemaVersion: 1,
    catalogId: "htx-official-download-center-btc-usdt-2026",
    provider: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026",
    authentication: "none",
    writeOperations: false,
    settlementRestUsedAsDownloadCenter: false,
    audit: HTX_DOWNLOAD_CENTER_AUDIT,
    requestedCoverage: { from: dates[0], to: dates.at(-1) },
    generatedAt: new Date(nowMs).toISOString(),
    sources,
    archives,
    series,
    errors,
    status: errors.length ? "PARTIAL" : "COMPLETE"
  };
  manifest.manifestHash = hashObject({ ...manifest, manifestHash: undefined });
  await writeJsonAtomic(join(directory, "manifest.json"), manifest);
  return { directory, manifest };
}

export async function loadHtxDownloadCenterCatalog(directory = defaultHtxDownloadCenterDirectory()) {
  const manifest = await readJson(join(directory, "manifest.json"));
  if (!manifest) throw new Error(`HTX Download Center manifest not found: ${directory}`);
  const expectedManifestHash = hashObject({ ...manifest, manifestHash: undefined });
  if (manifest.manifestHash !== expectedManifestHash) throw new Error("HTX Download Center manifest hash mismatch");
  const series = {};
  for (const [type, descriptor] of Object.entries(manifest.series ?? {})) {
    const text = await readFile(join(directory, descriptor.file), "utf8");
    if (sha256(text) !== descriptor.sha256) throw new Error(`${type} Download Center series hash mismatch`);
    series[type] = JSON.parse(text);
  }
  return { directory, manifest, series };
}

export function pointInTimeDownloadRecords(records, visibleAt) {
  const cutoff = Number(visibleAt);
  if (!Number.isFinite(cutoff)) throw new Error("PIT cutoff must be a finite timestamp");
  return records.filter((item) => Number(item.visibleAt) <= cutoff).sort((a, b) => a.eventTime - b.eventTime);
}

export const HTX_DOWNLOAD_CENTER_SOURCE = Object.freeze({
  origin: DOWNLOAD_ORIGIN,
  prefix: DOWNLOAD_PREFIX,
  base: DOWNLOAD_BASE,
  authentication: "none",
  exchangeWriteEnabled: false
});
