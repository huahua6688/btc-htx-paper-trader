import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { inflateRawSync, createGunzip } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { hashObject, readJson, resolveResearchPath, sha256, writeJsonAtomic } from "./research-utils.mjs";

const DOWNLOAD_ORIGIN = "https://futures.htx.com";
const DOWNLOAD_PREFIX = "/data/historical_data/";
const DOWNLOAD_BASE = `${DOWNLOAD_ORIGIN}${DOWNLOAD_PREFIX}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const KLINE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_NORMALIZED_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ON_DEMAND_ARCHIVE_BYTES = 256 * 1024 * 1024;
const ON_DEMAND_TYPES = new Set(["futuresTrades", "futuresDepth", "spotTrades", "spotDepth"]);
const DEPTH_TYPES = new Set(["futuresDepth", "spotDepth"]);

export const HTX_DOWNLOAD_CENTER_AUDIT = Object.freeze({
  auditedAt: "2026-08-24T00:00:00.000Z",
  officialLandingPage: "https://www.htx.com/futures/data/landing_page",
  officialInstitutionPage: "https://www.htx.com/en-us/institutions",
  serviceAdvertisedStart: "2026-02-01",
  latestAvailabilityProbeDate: "2026-08-23",
  settlementRestIsDownloadCenter: false,
  method: "Official landing-page route audit plus public archive/.CHECKSUM availability probes; content verification is true only after downloading the archive and matching its local SHA-256"
});

export const HTX_DOWNLOAD_CENTER_SOURCES = Object.freeze({
  futuresKline: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "KLINE", interval: "15m",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m candle open; visibleAt is eventTime + 15m"
  },
  futuresTrades: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "TRADES",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `futures/daily/trades/BTC-USDT-PERP/BTC-USDT-PERP-trades-${date}.zip`,
    pitSemantics: "each trade carries exchange ts; archive is not transformed unless explicitly requested"
  },
  futuresDepth: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "ORDER_BOOK_L2_150",
    firstAvailableDate: "2026-05-28", lastAvailabilityProbeDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `futures/daily/orderbook/lv150/BTC-USDT-PERP/BTC-USDT-PERP-l2orderbook-150lv-${date}.tar.gz`,
    pitSemantics: "JSONL snapshot plus updates carry exchange ts; optional parsing reconstructs the book and samples the final visible state in each 15m UTC bucket"
  },
  futuresMarkPrice: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "MARK_PRICE_KLINE", interval: "15m",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/mark-klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-mark-price-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m mark-price candle open; visibleAt is eventTime + 15m"
  },
  futuresIndexPrice: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "INDEX_PRICE_KLINE", interval: "15m",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/index-klines/BTC-USDT-PERP/15m/BTC-USDT-PERP-index-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m index-price candle open; visibleAt is eventTime + 15m"
  },
  futuresFunding: {
    market: "HTX USDT-M perpetual", instrument: "BTC-USDT-PERP", kind: "FUNDING_RATE",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `futures/daily/funding-rates/BTC-USDT-PERP/BTC-USDT-PERP-fundingRates-${date}.zip`,
    pitSemantics: "eventTime and visibleAt are the official fundingTime"
  },
  spotKline: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "KLINE", interval: "15m",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "PIT_NORMALIZED",
    path: ({ date }) => `spot/daily/klines/BTC-USDT/15m/BTC-USDT-klines-15m-${date}.zip`,
    pitSemantics: "eventTime is 15m candle open; visibleAt is eventTime + 15m"
  },
  spotTrades: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "TRADES",
    firstAvailableDate: "2026-02-01", lastAvailabilityProbeDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `spot/daily/trades/BTC-USDT/BTC-USDT-trades-${date}.zip`,
    pitSemantics: "each trade carries exchange ts; archive is not transformed unless explicitly requested"
  },
  spotDepth: {
    market: "HTX spot", instrument: "BTC-USDT", kind: "ORDER_BOOK_L2_400",
    firstAvailableDate: "2026-05-28", lastAvailabilityProbeDate: "2026-08-23", ingestion: "CATALOGED_ON_DEMAND",
    path: ({ date }) => `spot/daily/orderbook/lv400/BTC-USDT/BTC-USDT-l2orderbook-400lv-${date}.tar.gz`,
    pitSemantics: "JSONL snapshot plus updates carry exchange ts; optional parsing reconstructs the book and samples the final visible state in each 15m UTC bucket"
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

async function request(url, { fetchImpl = fetch, method = "GET", attempts = 3, timeoutMs = 30_000 } = {}) {
  assertDownloadUrl(url);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { accept: "application/octet-stream,text/plain", "user-agent": "btc-htx-paper-research/1.0" },
        signal: AbortSignal.timeout(timeoutMs)
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
  let content = null;
  if (method === 0) content = compressed;
  else if (method === 8) {
    try {
      content = inflateRawSync(compressed, { maxOutputLength: MAX_NORMALIZED_ARCHIVE_BYTES });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error("PIT-normalized archive exceeds the fixed safe size limit", { cause: error });
      }
      throw error;
    }
  }
  if (!content) throw new Error(`Unsupported ZIP compression method: ${method}`);
  if (content.length > MAX_NORMALIZED_ARCHIVE_BYTES) throw new Error("PIT-normalized archive exceeds the fixed safe size limit");
  return { fileName, csv: content.toString("utf8") };
}

export function parseDownloadCenterCsv(csv) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => csvRow(headers, line));
}

function parseCsvLine(line) {
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
  if (quoted) throw new Error("Download Center CSV contains an unterminated quoted field");
  values.push(value);
  return values;
}

function csvRow(headers, line) {
  const values = parseCsvLine(line);
  return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
}

function numericObject(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (["instId", "action", "side", "tradeId"].includes(key) || value === "") return [key, value];
    const numeric = Number(value);
    return [key, Number.isFinite(numeric) ? numeric : value];
  }));
}

function timestampFromRow(type, row) {
  const candidates = type === "futuresFunding"
    ? [row.fundingTime, row.funding_time]
    : [row.ts, row.tradeTs, row.tradeTime, row.timestamp, row.time];
  let value = Number(candidates.find((item) => item !== undefined && item !== null && item !== ""));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${type} row has invalid event time`);
  if (value < 1e11) value *= 1000;
  else if (value >= 1e18) value /= 1e6;
  else if (value >= 1e15) value /= 1000;
  return Math.trunc(value);
}

function parseBookSide(value, label) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`Depth ${label} must be a JSON array`);
  return parsed.map((level) => {
    if (!Array.isArray(level) || level.length < 2 || !Number.isFinite(Number(level[0])) || !Number.isFinite(Number(level[1]))) {
      throw new Error(`Depth ${label} contains an invalid price/size level`);
    }
    return [Number(level[0]), Number(level[1])];
  });
}

function normalizedPayload(type, row) {
  const normalized = numericObject(row);
  if (DEPTH_TYPES.has(type)) {
    normalized.bids = parseBookSide(row.bids ?? row.b, "bids");
    normalized.asks = parseBookSide(row.asks ?? row.a, "asks");
  }
  return normalized;
}

function normalizeRows(type, rows, archive) {
  const isFunding = type === "futuresFunding";
  const immediateVisibility = isFunding || ON_DEMAND_TYPES.has(type);
  return rows.map((row) => {
    const normalized = normalizedPayload(type, row);
    const eventTime = timestampFromRow(type, row);
    const visibleAt = immediateVisibility ? eventTime : eventTime + KLINE_INTERVAL_MS;
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
  const key = (row) => `${row.eventTime}:${row.normalized?.instId ?? ""}:${row.normalized?.tradeId ?? row.normalized?.seqNum ?? ""}`;
  return [...new Map([...prior, ...fetched].map((row) => [key(row), row])).values()].sort((a, b) => a.eventTime - b.eventTime);
}

async function downloadArchiveToFile(response, target, { maximumBytes = MAX_ON_DEMAND_ARCHIVE_BYTES } = {}) {
  const advertised = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) throw new Error(`Archive exceeds the ${maximumBytes}-byte on-demand safety limit`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.partial`;
  const handle = await open(temporary, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const chunks = response.body
      ? response.body
      : [Buffer.from(await response.arrayBuffer())];
    for await (const value of chunks) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maximumBytes) throw new Error(`Archive exceeds the ${maximumBytes}-byte on-demand safety limit`);
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
  return { bytes, sha256: hash.digest("hex") };
}

class SingleDataTarExtractor extends Transform {
  constructor() {
    super();
    this.pending = Buffer.alloc(0);
    this.remaining = 0;
    this.padding = 0;
    this.emitCurrent = false;
    this.dataFile = null;
    this.ended = false;
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.#drain();
      callback();
    } catch (error) { callback(error); }
  }

  _flush(callback) {
    try {
      this.#drain();
      if (!this.dataFile) throw new Error("TAR.GZ archive does not contain a supported CSV/JSONL data member");
      if (this.remaining !== 0) throw new Error("TAR.GZ archive ended inside a member");
      callback();
    } catch (error) { callback(error); }
  }

  #drain() {
    while (this.pending.length) {
      if (this.remaining > 0) {
        const length = Math.min(this.remaining, this.pending.length);
        const data = this.pending.subarray(0, length);
        this.pending = this.pending.subarray(length);
        this.remaining -= length;
        if (this.emitCurrent) this.push(data);
        continue;
      }
      if (this.padding > 0) {
        const length = Math.min(this.padding, this.pending.length);
        this.pending = this.pending.subarray(length);
        this.padding -= length;
        continue;
      }
      if (this.ended || this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every((value) => value === 0)) { this.ended = true; return; }
      const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
      const name = text(0, 100);
      const prefix = text(345, 155);
      const member = prefix ? `${prefix}/${name}` : name;
      if (!member || member.startsWith("/") || member.split("/").includes("..")) throw new Error("Unsafe TAR member path");
      const sizeText = text(124, 12).trim();
      const size = Number.parseInt(sizeText || "0", 8);
      if (!Number.isFinite(size) || size < 0) throw new Error("Invalid TAR member size");
      const type = text(156, 1) || "0";
      const regular = type === "0";
      const isData = regular && /\.(?:csv|data|jsonl)$/i.test(member);
      if (isData && this.dataFile) throw new Error("Expected one data member in TAR.GZ archive");
      if (isData) this.dataFile = member;
      this.emitCurrent = isData;
      this.remaining = size;
      this.padding = (512 - (size % 512)) % 512;
    }
  }
}

async function extractOnDemandData(archivePath, archiveFile, temporaryData) {
  if (archiveFile.endsWith(".zip")) {
    const extracted = extractSingleCsvZip(await readFile(archivePath));
    await writeFile(temporaryData, extracted.csv, "utf8");
    return extracted.fileName;
  }
  if (archiveFile.endsWith(".tar.gz")) {
    const extractor = new SingleDataTarExtractor();
    await pipeline(createReadStream(archivePath), createGunzip(), extractor, createWriteStream(temporaryData, { flags: "wx" }));
    return extractor.dataFile;
  }
  throw new Error(`Unsupported on-demand archive format: ${archiveFile}`);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function parseOnDemandArchive(type, archive, directory) {
  const archivePath = join(directory, archive.localFile);
  const temporaryData = `${archivePath}.${process.pid}.${Date.now()}.data`;
  const relativeSeriesFile = `series/${type}/${archive.date}.ndjson`;
  const target = join(directory, relativeSeriesFile);
  const temporarySeries = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  let output;
  let records = 0;
  let earliestEventTime = null;
  let latestEventTime = null;
  let latestVisibleAt = null;
  try {
    const dataFile = await extractOnDemandData(archivePath, basename(archivePath), temporaryData);
    const lines = createInterface({ input: createReadStream(temporaryData), crlfDelay: Infinity });
    output = createWriteStream(temporarySeries, { flags: "wx" });
    const writeNormalized = async (normalized) => {
      if (!output.write(`${JSON.stringify(normalized)}\n`)) await once(output, "drain");
      records += 1;
      earliestEventTime = earliestEventTime === null ? normalized.eventTime : Math.min(earliestEventTime, normalized.eventTime);
      latestEventTime = latestEventTime === null ? normalized.eventTime : Math.max(latestEventTime, normalized.eventTime);
      latestVisibleAt = latestVisibleAt === null ? normalized.visibleAt : Math.max(latestVisibleAt, normalized.visibleAt);
    };
    if (DEPTH_TYPES.has(type) && /\.(?:data|jsonl)$/i.test(dataFile)) {
      const bids = new Map();
      const asks = new Map();
      let initialized = false;
      let bucket = null;
      let lastEvent = null;
      const applySide = (book, levels, label) => {
        if (!Array.isArray(levels)) throw new Error(`Depth ${label} update is not an array`);
        for (const [rawPrice, rawSize] of levels) {
          const price = Number(rawPrice);
          const size = Number(rawSize);
          if (!Number.isFinite(price) || !Number.isFinite(size)) throw new Error(`Depth ${label} update contains invalid numbers`);
          if (size === 0) book.delete(price);
          else book.set(price, size);
        }
      };
      const flush = async () => {
        if (!lastEvent || !initialized) return;
        const limit = type === "futuresDepth" ? 150 : 400;
        const row = {
          instId: lastEvent.instId,
          action: "snapshot",
          ts: lastEvent.eventTime,
          bids: [...bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, limit),
          asks: [...asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit)
        };
        await writeNormalized(normalizeRows(type, [row], archive)[0]);
      };
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const eventTime = timestampFromRow(type, row);
        const nextBucket = Math.floor(eventTime / KLINE_INTERVAL_MS) * KLINE_INTERVAL_MS;
        if (bucket !== null && nextBucket !== bucket) await flush();
        bucket = nextBucket;
        if (row.action === "snapshot") { bids.clear(); asks.clear(); initialized = true; }
        else if (row.action !== "update") throw new Error(`Unknown depth action: ${row.action}`);
        else if (!initialized) throw new Error("Depth update appeared before the initial snapshot");
        applySide(bids, row.bids, "bids");
        applySide(asks, row.asks, "asks");
        lastEvent = { instId: row.instId, eventTime };
      }
      await flush();
    } else {
      let headers = null;
      for await (const line of lines) {
        if (!line.length) continue;
        if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
        await writeNormalized(normalizeRows(type, [csvRow(headers, line)], archive)[0]);
      }
      if (!headers) throw new Error("On-demand CSV is empty");
    }
    output.end();
    await finished(output);
    await rename(temporarySeries, target);
    return {
      date: archive.date,
      file: relativeSeriesFile,
      format: "NDJSON",
      dataFile,
      transformation: DEPTH_TYPES.has(type)
        ? "RECONSTRUCT_SNAPSHOT_PLUS_UPDATES_THEN_SAMPLE_FINAL_STATE_PER_15M_UTC_BUCKET"
        : "PRESERVE_EACH_TRADE_WITH_EXCHANGE_TIMESTAMP",
      sha256: await hashFile(target),
      records,
      earliestEventTime: earliestEventTime === null ? null : new Date(earliestEventTime).toISOString(),
      latestEventTime: latestEventTime === null ? null : new Date(latestEventTime).toISOString(),
      latestVisibleAt: latestVisibleAt === null ? null : new Date(latestVisibleAt).toISOString(),
      futureBackfillUsed: false
    };
  } catch (error) {
    output?.destroy();
    await rm(temporarySeries, { force: true });
    throw error;
  } finally {
    await rm(temporaryData, { force: true });
  }
}

export async function updateHtxDownloadCenterCatalog({
  from,
  to,
  directory = defaultHtxDownloadCenterDirectory(),
  dataTypes = HTX_DOWNLOAD_CENTER_TYPES,
  fetchImpl = fetch,
  nowMs = Date.now(),
  onProgress = null,
  downloadOnDemandTypes = [],
  parseOnDemandTypes = [],
  allowLargeDepth = false
} = {}) {
  if (!from || !to) throw new Error("Download Center update requires explicit completed UTC --from and --to dates");
  const dates = enumerateDates(from, to, nowMs);
  const selected = [...new Set(dataTypes)];
  for (const type of selected) if (!HTX_DOWNLOAD_CENTER_TYPES.includes(type)) throw new Error(`Unknown HTX Download Center type: ${type}`);
  const downloadRequested = new Set(downloadOnDemandTypes);
  const parseRequested = new Set(parseOnDemandTypes);
  for (const type of [...downloadRequested, ...parseRequested]) {
    if (!selected.includes(type) || !ON_DEMAND_TYPES.has(type)) throw new Error(`On-demand fetch is not valid for ${type}`);
  }
  for (const type of parseRequested) if (!downloadRequested.has(type)) throw new Error(`Parsing ${type} requires an explicit on-demand download`);
  if (!allowLargeDepth && [...downloadRequested].some((type) => DEPTH_TYPES.has(type))) {
    throw new Error("Depth download requires explicit allowLargeDepth=true because daily archives can exceed 100 MB");
  }
  const prior = await readJson(join(directory, "manifest.json"), {});
  const archiveMap = new Map((prior.archives ?? []).map((item) => [`${item.type}:${item.date}`, item]));
  const series = { ...(prior.series ?? {}) };
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
            reason: date < source.firstAvailableDate ? `before first available ${source.firstAvailableDate}` : "official archive returned 404"
          });
          continue;
        }
        const officialChecksum = parseOfficialChecksum(await checksumResponse.text(), basename(archiveUrl.pathname));
        if (source.ingestion === "CATALOGED_ON_DEMAND" && !downloadRequested.has(type)) {
          const head = await request(archiveUrl, { fetchImpl, method: "HEAD" });
          if (head.status === 404) throw new Error("Archive checksum exists but archive returned 404");
          archiveMap.set(`${type}:${date}`, {
            type, date, path: archivePath, url: archiveUrl.toString(), availability: "CATALOGED_ON_DEMAND",
            provenance: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026", officialChecksumAdvertised: officialChecksum,
            contentLength: Number(head.headers?.get?.("content-length")) || null,
            etag: head.headers?.get?.("etag") ?? null,
            checkedAt: new Date(nowMs).toISOString(), pointInTime: true, pitSemantics: source.pitSemantics,
            downloaded: false, localSha256: null, contentChecksumVerified: false
          });
          continue;
        }
        const response = await request(archiveUrl, {
          fetchImpl,
          timeoutMs: source.ingestion === "CATALOGED_ON_DEMAND" ? 10 * 60 * 1000 : 30_000
        });
        if (source.ingestion === "CATALOGED_ON_DEMAND") {
          const archiveFile = basename(archiveUrl.pathname);
          const localFile = `archives/${type}/${date}/${archiveFile}`;
          const localPath = join(directory, localFile);
          const downloadedAt = new Date(nowMs).toISOString();
          const downloaded = await downloadArchiveToFile(response, localPath);
          if (downloaded.sha256 !== officialChecksum) {
            await rm(localPath, { force: true });
            throw new Error(`Official checksum mismatch for ${archiveFile}`);
          }
          const archive = {
            type, date, path: archivePath, url: archiveUrl.toString(), availability: "DOWNLOADED_VERIFIED_ON_DEMAND",
            provenance: "HTX_OFFICIAL_DOWNLOAD_CENTER_2026", officialChecksum,
            officialChecksumAdvertised: officialChecksum, localSha256: downloaded.sha256,
            sha256: downloaded.sha256, contentChecksumVerified: true,
            contentLength: downloaded.bytes, etag: response.headers?.get?.("etag") ?? null,
            downloaded: true, localFile, downloadedAt, pointInTime: true, pitSemantics: source.pitSemantics
          };
          archiveMap.set(`${type}:${date}`, archive);
          if (parseRequested.has(type)) {
            try {
              const parsed = await parseOnDemandArchive(type, archive, directory);
              const priorFiles = series[type]?.files ?? [];
              const files = [...new Map([...priorFiles, parsed].map((item) => [item.date, item])).values()]
                .sort((a, b) => a.date.localeCompare(b.date));
              series[type] = {
                format: "NDJSON_BY_UTC_DATE",
                files,
                records: files.reduce((sum, item) => sum + item.records, 0),
                earliestEventTime: files.map((item) => item.earliestEventTime).filter(Boolean).sort()[0] ?? null,
                latestEventTime: files.map((item) => item.latestEventTime).filter(Boolean).sort().at(-1) ?? null,
                latestVisibleAt: files.map((item) => item.latestVisibleAt).filter(Boolean).sort().at(-1) ?? null,
                futureBackfillUsed: false
              };
              archive.availability = "INGESTED_PIT_ON_DEMAND";
              archive.parsedSeriesFile = parsed.file;
              archive.records = parsed.records;
            } catch (error) {
              archive.parseError = error.message;
              errors.push({ type, date, stage: "PIT_PARSE", error: error.message });
            }
          }
          continue;
        }
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
          localSha256: archiveSha256, contentChecksumVerified: true,
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
    availabilityCoverage: {
      from: source.firstAvailableDate,
      through: source.lastAvailabilityProbeDate,
      probedAt: HTX_DOWNLOAD_CENTER_AUDIT.auditedAt,
      evidence: "ARCHIVE_AND_CHECKSUM_FILE_AVAILABILITY"
    },
    actualArchiveDatesCataloged: archives.filter((item) => item.type === type && item.availability !== "HISTORICAL_UNAVAILABLE").map((item) => item.date),
    status: archives.some((item) => item.type === type && item.availability === "INGESTED_PIT_ON_DEMAND") ? "PIT_PARSED_ON_DEMAND"
      : archives.some((item) => item.type === type && item.availability === "DOWNLOADED_VERIFIED_ON_DEMAND") ? "DOWNLOADED_VERIFIED_ON_DEMAND"
        : archives.some((item) => item.type === type && item.availability !== "HISTORICAL_UNAVAILABLE") ? source.ingestion
          : selected.includes(type) ? "HISTORICAL_UNAVAILABLE_FOR_REQUESTED_RANGE" : "NOT_CATALOGED"
  }]));
  const manifest = {
    schemaVersion: 2,
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

export async function fetchHtxDownloadCenterOnDemand({
  type,
  date,
  parse = false,
  allowLargeDepth = false,
  ...options
} = {}) {
  if (!ON_DEMAND_TYPES.has(type)) throw new Error(`On-demand Download Center type required: ${[...ON_DEMAND_TYPES].join(", ")}`);
  if (!date) throw new Error("On-demand Download Center fetch requires one explicit completed UTC date");
  return updateHtxDownloadCenterCatalog({
    ...options,
    from: date,
    to: date,
    dataTypes: [type],
    downloadOnDemandTypes: [type],
    parseOnDemandTypes: parse ? [type] : [],
    allowLargeDepth
  });
}

export async function loadHtxDownloadCenterCatalog(directory = defaultHtxDownloadCenterDirectory()) {
  const manifest = await readJson(join(directory, "manifest.json"));
  if (!manifest) throw new Error(`HTX Download Center manifest not found: ${directory}`);
  const expectedManifestHash = hashObject({ ...manifest, manifestHash: undefined });
  if (manifest.manifestHash !== expectedManifestHash) throw new Error("HTX Download Center manifest hash mismatch");
  const series = {};
  for (const [type, descriptor] of Object.entries(manifest.series ?? {})) {
    if (Array.isArray(descriptor.files)) {
      const records = [];
      for (const file of descriptor.files) {
        const text = await readFile(join(directory, file.file), "utf8");
        if (sha256(text) !== file.sha256) throw new Error(`${type} ${file.date} Download Center series hash mismatch`);
        for (const line of text.split(/\r?\n/)) if (line) records.push(JSON.parse(line));
      }
      series[type] = records.sort((a, b) => a.eventTime - b.eventTime);
      continue;
    }
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
