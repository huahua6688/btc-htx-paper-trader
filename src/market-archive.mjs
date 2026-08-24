import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { MARKET_ARCHIVE_CONFIG } from "./config.mjs";
import { MARKET_TASKS } from "./market-data.mjs";
import { collectProviderTimestamps } from "./market-context.mjs";
import { HTX_RAW_PAYLOAD, normalizePublicCommandPayload } from "./htx-cli.mjs";

const TYPE_METADATA = new Map(MARKET_TASKS.map(([key, skill, subcommand]) => [key, { skill, subcommand }]));
const ARCHIVE_SCHEMA_VERSION = 2;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid archive timestamp: ${value}`);
  return date.toISOString();
}

export function normalizeArchivedPayload(type, payload, { observedAt = null } = {}) {
  const normalizers = {
    ticker: () => ({ ts: Number(payload.ts ?? payload.tick?.ts), close: Number(payload.tick?.close), open: Number(payload.tick?.open), high: Number(payload.tick?.high), low: Number(payload.tick?.low), bid: payload.tick?.bid ?? null, ask: payload.tick?.ask ?? null }),
    kline15m: () => (payload.data ?? []).map((row) => ({ eventTime: Number(row.id) * 1000, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), amount: Number(row.amount), volume: Number(row.vol), turnover: Number(row.trade_turnover), trades: Number(row.count) })),
    kline1h: () => normalizers.kline15m(), kline4h: () => normalizers.kline15m(), kline1d: () => normalizers.kline15m(),
    depth: () => ({ eventTime: Number(payload.tick?.ts ?? payload.ts), bids: payload.tick?.bids ?? [], asks: payload.tick?.asks ?? [] }),
    fundingCurrent: () => ({
      // funding_time/next_funding_time describe the settlement schedule and can
      // legitimately be in the future. The archive event is the live observation.
      eventTime: observedAt ? new Date(observedAt).getTime() : Number(payload.ts),
      settlementTime: Number(payload.data?.funding_time),
      fundingRate: Number(payload.data?.funding_rate),
      nextFundingTime: Number(payload.data?.next_funding_time)
    }),
    fundingHistory: () => (payload.data?.data ?? []).map((row) => ({ eventTime: Number(row.funding_time), fundingRate: Number(row.realized_rate ?? row.funding_rate), averagePremiumIndex: Number(row.avg_premium_index) })),
    oiCurrent: () => (payload.data ?? []).map((row) => ({ eventTime: Number(row.ts ?? payload.ts), value: Number(row.value), volume: Number(row.volume), amountType: Number(row.amount_type) })),
    oiHistory: () => (payload.data ?? []).flatMap((item) => item.tick ?? []).map((row) => ({ eventTime: Number(row.ts), value: Number(row.value), volume: Number(row.volume), amountType: Number(row.amount_type) })),
    eliteAccount: () => (payload.data ?? []).flatMap((item) => item.list ?? []).map((row) => ({ eventTime: Number(row.ts), buyRatio: Number(row.buy_ratio), sellRatio: Number(row.sell_ratio), lockedRatio: Number(row.locked_ratio) })),
    elitePosition: () => (payload.data ?? []).flatMap((item) => item.list ?? []).map((row) => ({ eventTime: Number(row.ts), buyRatio: Number(row.buy_ratio), sellRatio: Number(row.sell_ratio) })),
    liquidations: () => (payload.data ?? []).map((row) => ({ eventTime: Number(row.created_at), direction: row.direction, offset: row.offset, volume: Number(row.volume), amount: Number(row.amount), price: Number(row.price), turnover: Number(row.trade_turnover) })),
    markPrice: () => (payload.data ?? []).map((row) => ({ eventTime: Number(row.id) * 1000, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) })),
    premium: () => normalizers.markPrice(),
    basis: () => (payload.data ?? []).map((row) => ({ eventTime: Number(row.id) * 1000, indexPrice: Number(row.index_price), contractPrice: Number(row.contract_price), basis: Number(row.basis), basisRate: Number(row.basis_rate) })),
    contractElements: () => (payload.data ?? []).map((row) => ({ contractCode: row.contract_code, priceTick: Number(row.price_tick), instrumentValue: Number(row.instrument_value), minLevel: Number(row.min_level), maxLevel: Number(row.max_level), settlePeriod: Number(row.settle_period), observedTs: Number(payload.ts) }))
  };
  return normalizers[type]?.() ?? payload;
}

function encodeRaw(payload) {
  const text = JSON.stringify(payload);
  return { bytes: gzipSync(Buffer.from(text)), sha256: sha256(text), codec: "gzip-json-utf8" };
}

function decodeRaw(row) {
  if (row.raw_codec !== "gzip-json-utf8") throw new Error(`Unsupported archive codec: ${row.raw_codec}`);
  return JSON.parse(gunzipSync(row.raw_payload).toString("utf8"));
}

export class MarketArchive {
  constructor(path = MARKET_ARCHIVE_CONFIG.path, { readOnly = false } = {}) {
    this.path = path;
    this.readOnly = readOnly;
    if (path !== ":memory:" && !readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (!readOnly) {
      if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL;");
      this.initialize();
    }
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('SELF_ARCHIVED','LIVE_OBSERVED')),
        schema_version INTEGER NOT NULL,
        raw_codec TEXT NOT NULL,
        raw_payload BLOB NOT NULL,
        raw_sha256 TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        normalized_schema_version INTEGER NOT NULL,
        cli_release TEXT,
        cli_sha256 TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(event_type, source, event_time)
      );
      CREATE INDEX IF NOT EXISTS archive_events_visible_idx ON archive_events(event_type, event_time, observed_at);
      CREATE TABLE IF NOT EXISTS archive_ingest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        attempted INTEGER NOT NULL,
        inserted INTEGER NOT NULL,
        duplicates INTEGER NOT NULL,
        errors_json TEXT NOT NULL
      );
    `);
  }

  archiveSnapshot(snapshot, {
    observedAt = new Date().toISOString(),
    cliRelease = null,
    cliSha256 = null,
    source = "HTX_PUBLIC_CLI"
  } = {}) {
    if (this.readOnly) throw new Error("Market archive is read-only");
    const observedIso = iso(observedAt);
    const observedMs = new Date(observedIso).getTime();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO archive_events(
        event_type, source, event_time, observed_at, provenance, schema_version,
        raw_codec, raw_payload, raw_sha256, normalized_json, normalized_schema_version,
        cli_release, cli_sha256, created_at
      ) VALUES (?, ?, ?, ?, 'SELF_ARCHIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const errors = [];
    let attempted = 0;
    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [type] of TYPE_METADATA) {
        const payload = snapshot[type];
        if (payload === null || payload === undefined) continue;
        attempted += 1;
        try {
          const timestamps = collectProviderTimestamps(payload, type);
          const eventTime = type === "fundingCurrent"
            ? observedMs
            : timestamps.length ? Math.max(...timestamps) : observedMs;
          if (eventTime > observedMs + 60_000) throw new Error("provider event time is in the future");
          const raw = encodeRaw(payload[HTX_RAW_PAYLOAD] ?? payload);
          const normalized = normalizeArchivedPayload(type, payload, { observedAt: observedIso });
          const result = insert.run(type, source, eventTime, observedIso, ARCHIVE_SCHEMA_VERSION,
            raw.codec, raw.bytes, raw.sha256, json(normalized), ARCHIVE_SCHEMA_VERSION,
            cliRelease, cliSha256, observedIso);
          inserted += Number(result.changes);
        } catch (error) {
          errors.push({ type, error: error.message });
        }
      }
      this.db.prepare("INSERT INTO archive_ingest_runs(observed_at, attempted, inserted, duplicates, errors_json) VALUES (?, ?, ?, ?, ?)")
        .run(observedIso, attempted, inserted, attempted - inserted - errors.length, json(errors));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { observedAt: observedIso, attempted, inserted, duplicates: attempted - inserted - errors.length, errors };
  }

  count(type = null) {
    return Number(type
      ? this.db.prepare("SELECT COUNT(*) AS count FROM archive_events WHERE event_type=?").get(type).count
      : this.db.prepare("SELECT COUNT(*) AS count FROM archive_events").get().count);
  }

  getEvent(id) {
    const row = this.db.prepare("SELECT * FROM archive_events WHERE id=?").get(id);
    return row ? { ...row, normalized: parseJson(row.normalized_json), raw: decodeRaw(row) } : null;
  }

  regenerateNormalized(id) {
    if (this.readOnly) throw new Error("Market archive is read-only");
    const row = this.db.prepare("SELECT * FROM archive_events WHERE id=?").get(id);
    if (!row) throw new Error(`Archive event not found: ${id}`);
    const normalized = normalizeArchivedPayload(row.event_type, decodeRaw(row), { observedAt: row.observed_at });
    this.db.prepare("UPDATE archive_events SET normalized_json=?, normalized_schema_version=? WHERE id=?")
      .run(json(normalized), ARCHIVE_SCHEMA_VERSION, id);
    return normalized;
  }

  getVisiblePayload(type, visibleAt, { ttlMs = null, source = "HTX_PUBLIC_CLI" } = {}) {
    const visibleIso = iso(visibleAt);
    const visibleMs = new Date(visibleIso).getTime();
    const row = this.db.prepare(`
      SELECT * FROM archive_events
      WHERE event_type=? AND source=? AND event_time<=? AND observed_at<=?
      ORDER BY event_time DESC, id DESC LIMIT 1
    `).get(type, source, visibleMs, visibleIso);
    if (!row) return { payload: null, provenance: "HISTORICAL_UNAVAILABLE", eventTime: null, observedAt: null, ageMs: null };
    const ageMs = visibleMs - Number(row.event_time);
    if (ttlMs !== null && ageMs > ttlMs) return { payload: null, provenance: "STALE", eventTime: Number(row.event_time), observedAt: row.observed_at, ageMs };
    const metadata = TYPE_METADATA.get(type);
    const rawPayload = decodeRaw(row);
    const payload = metadata ? normalizePublicCommandPayload(metadata.skill, metadata.subcommand, rawPayload) : rawPayload;
    return { payload, normalized: parseJson(row.normalized_json), provenance: "SELF_ARCHIVED", eventTime: Number(row.event_time), observedAt: row.observed_at, ageMs, rawSha256: row.raw_sha256 };
  }

  coverageReport({ expectedIntervalMs = 5 * 60 * 1000 } = {}) {
    const rows = this.db.prepare(`
      SELECT event_type, COUNT(*) AS records, MIN(event_time) AS earliest, MAX(event_time) AS latest,
        MAX(observed_at) AS latest_observed_at
      FROM archive_events GROUP BY event_type ORDER BY event_type
    `).all();
    return rows.map((row) => {
      const events = this.db.prepare("SELECT event_time FROM archive_events WHERE event_type=? ORDER BY event_time").all(row.event_type);
      const gaps = [];
      for (let index = 1; index < events.length; index += 1) {
        const delta = Number(events[index].event_time) - Number(events[index - 1].event_time);
        if (delta > expectedIntervalMs * 2) gaps.push({ after: Number(events[index - 1].event_time), before: Number(events[index].event_time), durationMs: delta });
      }
      return {
        type: row.event_type,
        records: Number(row.records),
        earliest: new Date(Number(row.earliest)).toISOString(),
        latest: new Date(Number(row.latest)).toISOString(),
        latestObservedAt: row.latest_observed_at,
        gaps
      };
    });
  }

  storageStatistics() {
    const pageCount = Number(this.db.prepare("PRAGMA page_count").get().page_count);
    const pageSize = Number(this.db.prepare("PRAGMA page_size").get().page_size);
    return {
      path: this.path,
      records: this.count(),
      bytes: this.path === ":memory:" ? pageCount * pageSize : existsSync(this.path) ? statSync(this.path).size : 0,
      allocatedBytes: pageCount * pageSize,
      rawPayloadPolicy: "immutable gzip JSON",
      retentionPolicy: "no automatic deletion; report-only"
    };
  }

  latestIngestRun() {
    const row = this.db.prepare("SELECT * FROM archive_ingest_runs ORDER BY id DESC LIMIT 1").get();
    return row ? { ...row, errors: parseJson(row.errors_json, []) } : null;
  }

  close() { this.db.close(); }
}

export function openMarketArchive(path = MARKET_ARCHIVE_CONFIG.path, options = {}) {
  return new MarketArchive(path, options);
}

export function readMarketArchiveStatus(path = MARKET_ARCHIVE_CONFIG.path) {
  if (path !== ":memory:" && !existsSync(path)) return { path, available: false, coverage: [], storage: null, latestIngest: null };
  let archive;
  try {
    archive = openMarketArchive(path, { readOnly: true });
    return { path, available: true, coverage: archive.coverageReport(), storage: archive.storageStatistics(), latestIngest: archive.latestIngestRun() };
  } finally {
    archive?.close();
  }
}

export const MARKET_ARCHIVE_SCHEMA_VERSION = ARCHIVE_SCHEMA_VERSION;
