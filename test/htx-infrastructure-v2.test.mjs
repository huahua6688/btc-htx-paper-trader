import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPaperDatabase } from "../src/db.mjs";
import { runPublicCommandWithBinary } from "../src/htx-cli.mjs";
import { updateHtxCli } from "../src/htx-upstream.mjs";
import { MarketArchive } from "../src/market-archive.mjs";
import { HtxPublicResearchClient, HTX_RESEARCH_ENDPOINTS } from "../src/htx-public-research-client.mjs";
import { readDataInfrastructureStatusSync } from "../src/data-infrastructure-status.mjs";
import { runMonitorCycle } from "../src/monitor-cycle.mjs";
import { updateHistoricalDataset } from "../src/historical-data.mjs";
import { buildPointInTimeMarket } from "../src/replay-market.mjs";
import { runHistoricalReplay } from "../src/replay-engine.mjs";
import { paperReport } from "./helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const response = (payload, { ok = true, status = 200, retryAfter = null } = {}) => ({
  ok, status,
  headers: { get: (name) => name.toLowerCase() === "retry-after" ? retryAfter : null },
  json: async () => payload
});

function fakeRelease(content) {
  return {
    id: 1, tag: "v9.9.9", publishedAt: "2026-08-24T00:00:00.000Z",
    url: "https://github.com/htx-exchange/htx-skills-hub/releases/tag/v9.9.9",
    commitSha: "a".repeat(40),
    assets: [{
      name: "htx-cli-windows-x64.exe", size: content.length,
      digest: `sha256:${sha256(content)}`,
      downloadUrl: "https://github.com/htx-exchange/htx-skills-hub/releases/download/v9.9.9/htx-cli-windows-x64.exe"
    }]
  };
}

test("HTX updater stages, verifies, atomically replaces, and preserves rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-update-"));
  const target = join(directory, "cli.exe");
  const oldContent = Buffer.from("old-binary");
  const newContent = Buffer.from("new-official-binary");
  await writeFile(target, oldContent);
  try {
    const result = await updateHtxCli({
      cliPath: target,
      environment: { HTX_CLI_STATE_DIR: join(directory, "state") },
      releaseProvider: async () => fakeRelease(newContent),
      downloadAsset: async (_asset, path) => writeFile(path, newContent),
      smokeTest: async () => ({ compatible: true, checkedAt: "2026-08-24T00:00:00.000Z", commands: [] }),
      verifyProject: async () => {}
    });
    assert.equal(result.changed, true);
    assert.deepEqual(await readFile(target), newContent);
    assert.deepEqual(await readFile(result.backupPath), oldContent);
    assert.equal(result.metadata.asset.officialChecksumVerified, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTX updater incompatibility leaves the production binary byte-identical", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-incompatible-"));
  const target = join(directory, "cli.exe");
  const oldContent = Buffer.from("known-good");
  const candidate = Buffer.from("incompatible");
  await writeFile(target, oldContent);
  try {
    await assert.rejects(() => updateHtxCli({
      cliPath: target,
      environment: { HTX_CLI_STATE_DIR: join(directory, "state") },
      releaseProvider: async () => fakeRelease(candidate),
      downloadAsset: async (_asset, path) => writeFile(path, candidate),
      smokeTest: async () => ({ compatible: false, checkedAt: new Date().toISOString(), commands: [{ compatible: false }] }),
      verifyProject: async () => { throw new Error("must not run"); }
    }), /compatibility smoke test failed/);
    assert.deepEqual(await readFile(target), oldContent);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTX updater restores the old binary if the final candidate replace fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-replace-failure-"));
  const target = join(directory, "cli.exe");
  const oldContent = Buffer.from("old-production-binary");
  const candidate = Buffer.from("verified-new-candidate");
  await writeFile(target, oldContent);
  try {
    await assert.rejects(() => updateHtxCli({
      cliPath: target,
      environment: { HTX_CLI_STATE_DIR: join(directory, "state") },
      releaseProvider: async () => fakeRelease(candidate),
      downloadAsset: async (_asset, path) => writeFile(path, candidate),
      smokeTest: async () => ({ compatible: true, checkedAt: new Date().toISOString(), commands: [] }),
      verifyProject: async () => {},
      replaceBinary: async () => { throw new Error("simulated atomic rename failure"); }
    }), /simulated atomic rename failure/);
    assert.deepEqual(await readFile(target), oldContent);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTX updater records a local digest without claiming an official checksum when upstream publishes none", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-no-checksum-"));
  const target = join(directory, "cli.exe");
  const candidate = Buffer.from("official-release-without-published-checksum");
  try {
    const release = fakeRelease(candidate);
    release.assets[0].digest = null;
    const result = await updateHtxCli({
      cliPath: target,
      environment: { HTX_CLI_STATE_DIR: join(directory, "state") },
      releaseProvider: async () => release,
      downloadAsset: async (_asset, path) => writeFile(path, candidate),
      smokeTest: async () => ({ compatible: true, checkedAt: "2026-08-24T00:00:00.000Z", commands: [] }),
      verifyProject: async () => {}
    });
    assert.equal(result.metadata.asset.officialChecksumProvided, false);
    assert.equal(result.metadata.asset.officialChecksumVerified, false);
    assert.equal(result.metadata.installedSha256, sha256(candidate));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTX CLI subprocess receives no exchange or Telegram secrets", async () => {
  const secretNames = ["HTX_API_KEY", "HTX_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ADMIN_USER_ID"];
  const saved = Object.fromEntries(secretNames.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HTX_API_KEY: "private", HTX_SECRET_KEY: "private", TELEGRAM_BOT_TOKEN: "redacted-test-token", TELEGRAM_CHAT_ID: "123", TELEGRAM_ADMIN_USER_ID: "456" });
  let childEnvironment;
  try {
    await runPublicCommandWithBinary("fake-cli", "futures-market", "detail-merged", { contract_code: "BTC-USDT" }, {
      execFileImpl: async (_path, _args, options) => {
        childEnvironment = options.env;
        return { stdout: JSON.stringify({ status: "ok", ts: Date.now(), tick: { close: 1 } }), stderr: "" };
      }
    });
    for (const key of Object.keys(saved)) assert.equal(childEnvironment[key], undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("HTX public research client honors Retry-After before retrying a 429", async () => {
  const delays = [];
  let calls = 0;
  const client = new HtxPublicResearchClient({
    attempts: 2,
    baseBackoffMs: 10,
    delay: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({}, { ok: false, status: 429, retryAfter: "2" })
        : response({ status: "ok", data: [] });
    }
  });
  const result = await client.get(HTX_RESEARCH_ENDPOINTS.openInterest, {
    contract_code: "BTC-USDT", period: "60min", amount_type: 2, size: 200
  });
  assert.equal(result.payload.status, "ok");
  assert.deepEqual(delays, [2000]);
});

test("archive failure is a warning and cannot fail the monitor cycle", async () => {
  const db = openPaperDatabase(":memory:");
  const report = paperReport({
    decision: "WAIT", candidateDecision: "WAIT",
    entryAssessment: { enterNow: false, method: "WAIT", methodLabel: "等待", reasons: [], missingConditions: ["没有交易机会"] }
  });
  try {
    const result = await runMonitorCycle(db, {
      collect: async () => report,
      analyze: () => report,
      archive: async () => { throw new Error("disk full"); },
      now: () => report.generatedAt
    });
    assert.equal(db.getLatestMonitorRun().status, "OK");
    assert.equal(result.archiveResult.failed, true);
    assert.match(result.collectionWarnings.join(" "), /marketArchive: disk full/);
  } finally { db.close(); }
});

test("archive event unique key is idempotent and raw payload stays immutable", () => {
  const archive = new MarketArchive(":memory:");
  const snapshot = { ticker: { status: "ok", ts: Date.UTC(2026, 7, 24), tick: { close: "78000" } } };
  try {
    const first = archive.archiveSnapshot(snapshot, { observedAt: "2026-08-24T00:00:01.000Z", cliRelease: "v2.0.0", cliSha256: "abc" });
    const second = archive.archiveSnapshot({ ticker: { ...snapshot.ticker, tick: { close: "99999" } } }, { observedAt: "2026-08-24T00:00:02.000Z" });
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(archive.count("ticker"), 1);
    assert.equal(archive.getEvent(1).raw.tick.close, "78000");
  } finally { archive.close(); }
});

test("current Funding archives at observation time while preserving its future settlement time", () => {
  const archive = new MarketArchive(":memory:");
  const observedAt = "2026-08-24T12:00:00.000Z";
  const settlementTime = Date.parse("2026-08-24T16:00:00.000Z");
  try {
    const result = archive.archiveSnapshot({ fundingCurrent: {
      status: "ok", ts: Date.parse(observedAt),
      data: { funding_time: settlementTime, next_funding_time: settlementTime, funding_rate: "0.0001" }
    } }, { observedAt });
    assert.equal(result.errors.length, 0);
    const event = archive.getEvent(1);
    assert.equal(Number(event.event_time), Date.parse(observedAt));
    assert.equal(event.normalized.eventTime, Date.parse(observedAt));
    assert.equal(event.normalized.settlementTime, settlementTime);
  } finally { archive.close(); }
});

test("archive preserves exact upstream object shape while replay receives the compatibility shape", async () => {
  const upstream = {
    status: "ok",
    ts: Date.UTC(2026, 7, 24, 12),
    data: { symbol: "BTC", contract_code: "BTC-USDT", tick: [{ ts: Date.UTC(2026, 7, 24, 11), value: "123" }] }
  };
  const adapted = await runPublicCommandWithBinary("fake-cli", "oi-tracker", "history", {
    contract_code: "BTC-USDT", period: "60min", size: 25
  }, { execFileImpl: async () => ({ stdout: JSON.stringify(upstream), stderr: "" }) });
  const archive = new MarketArchive(":memory:");
  try {
    archive.archiveSnapshot({ oiHistory: adapted }, { observedAt: "2026-08-24T12:00:01.000Z" });
    const event = archive.getEvent(1);
    assert.equal(Array.isArray(event.raw.data), false);
    assert.deepEqual(event.raw, upstream);
    const visible = archive.getVisiblePayload("oiHistory", "2026-08-24T12:01:00.000Z", { ttlMs: 2 * 60 * 60 * 1000 });
    assert.equal(Array.isArray(visible.payload.data), true);
    assert.equal(visible.payload.data[0].tick[0].value, "123");
  } finally { archive.close(); }
});

test("data status degrades safely when the archive file is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-corrupt-archive-"));
  const archivePath = join(directory, "market-archive.sqlite");
  await writeFile(archivePath, "not a sqlite database");
  try {
    const status = readDataInfrastructureStatusSync(null, {
      archivePath,
      catalogDirectory: join(directory, "missing-catalog"),
      environment: { HTX_CLI_STATE_DIR: join(directory, "state") }
    });
    assert.equal(status.archive.available, false);
    assert.match(status.archive.error, /database|file/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("historical backfill checkpoint resumes without downloading completed Kline again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-checkpoint-"));
  const start = Date.UTC(2025, 0, 1);
  const end = start + 4 * 15 * 60 * 1000;
  let klineCalls = 0;
  let fundingFails = true;
  const fetchImpl = async (url) => {
    if (url.pathname.includes("history/kline")) {
      klineCalls += 1;
      const from = Number(url.searchParams.get("from")) * 1000;
      const to = Number(url.searchParams.get("to")) * 1000;
      return response({ status: "ok", data: Array.from({ length: (to - from) / (15 * 60 * 1000) + 1 }, (_, index) => ({
        id: (from + index * 15 * 60 * 1000) / 1000, open: 100, high: 101, low: 99, close: 100, amount: 1, vol: 1, count: 1
      })) });
    }
    if (fundingFails) return response({}, { ok: false, status: 503 });
    return response({ status: "ok", data: { total_page: 1, data: [{ funding_time: String(start), funding_rate: "0.0001" }] } });
  };
  const args = { from: new Date(start).toISOString(), to: new Date(end).toISOString(), directory, fetchImpl, dataTypes: ["kline", "funding"], attempts: 1, delay: async () => {} };
  try {
    await assert.rejects(() => updateHistoricalDataset(args), /HTTP 503/);
    fundingFails = false;
    const result = await updateHistoricalDataset(args);
    assert.equal(klineCalls, 1);
    assert.equal(result.manifest.checkpoint.status, "COMPLETE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function replayCandles(days = 62) {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: days * 96 }, (_, index) => ({
    timestamp: start + index * 15 * 60 * 1000,
    open: 50_000 + index, high: 50_020 + index, low: 49_980 + index, close: 50_010 + index,
    volumeBtc: 10, volumeContracts: 10_000, turnoverUsdt: 500_000, trades: 100
  }));
}

test("point-in-time replay never reads a future historical record", () => {
  const candles = replayCandles(1);
  const index = 20;
  const visibleAt = candles[index].timestamp + 15 * 60 * 1000;
  const market = buildPointInTimeMarket(candles, [], index, { historicalSeries: {
    openInterest: [{ eventTime: visibleAt + 60_000, visibleAt: visibleAt + 60_000, normalized: { ts: visibleAt + 60_000, value: 1 } }]
  } });
  assert.equal(market.oiCurrent, null);
  assert.equal(market.replay.fieldStatus.openInterest.provenance, "HISTORICAL_UNAVAILABLE");
});

test("stale historical records cannot masquerade as current replay evidence", () => {
  const candles = replayCandles(1);
  const index = 20;
  const visibleAt = candles[index].timestamp + 15 * 60 * 1000;
  const eventTime = visibleAt - 3 * 60 * 60 * 1000;
  const market = buildPointInTimeMarket(candles, [], index, { historicalSeries: {
    openInterest: [{ eventTime, visibleAt: eventTime + 60 * 60 * 1000, normalized: { ts: eventTime, value: 1 } }]
  } });
  assert.equal(market.oiCurrent, null);
  assert.equal(market.replay.fieldStatus.openInterest.provenance, "STALE");
});

test("HISTORICAL_UNAVAILABLE remains null and never fabricates derivatives", () => {
  const market = buildPointInTimeMarket(replayCandles(1), [], 20, { historicalSeries: {} });
  for (const field of ["depth", "oiCurrent", "oiHistory", "eliteAccount", "elitePosition", "liquidations", "markPrice", "premium", "basis"]) {
    assert.equal(market[field], null);
  }
  assert.equal(Object.values(market.replay.fieldStatus).every((item) => item.provenance === "HISTORICAL_UNAVAILABLE"), true);
});

test("raw archive payload can deterministically regenerate normalized data", () => {
  const archive = new MarketArchive(":memory:");
  try {
    archive.archiveSnapshot({ basis: { status: "ok", data: [{ id: 1787576400, index_price: "78000", contract_price: "78010", basis: "10", basis_rate: "0.000128" }] } }, { observedAt: new Date(1787576400 * 1000 + 1000).toISOString() });
    archive.db.prepare("UPDATE archive_events SET normalized_json='{}' WHERE id=1").run();
    const regenerated = archive.regenerateNormalized(1);
    assert.equal(regenerated[0].basisRate, 0.000128);
    assert.deepEqual(archive.getEvent(1).normalized, regenerated);
  } finally { archive.close(); }
});

test("Replay passes real timestamp-visible OI and Basis into the strategy core", async () => {
  const candles = replayCandles();
  const eventTime = candles[60 * 96].timestamp;
  const series = {
    openInterest: [{ eventTime: eventTime - 60 * 60 * 1000, visibleAt: eventTime, normalized: { ts: eventTime - 60 * 60 * 1000, value: 2_000_000_000, volume: 25_000, amount_type: 2 } }],
    basis: [{ eventTime: eventTime - 60 * 60 * 1000, visibleAt: eventTime, normalized: { id: (eventTime - 60 * 60 * 1000) / 1000, index_price: "55000", contract_price: "55022", basis: "22", basis_rate: "0.0004" } }]
  };
  const dataset = { manifest: { datasetId: "pit-real-fields", manifestHash: "pit-real-fields" }, candles, funding: [], series };
  const replay = await runHistoricalReplay(dataset, {
    strategy: "champion", from: new Date(eventTime).toISOString(), to: new Date(eventTime + 2 * 60 * 60 * 1000).toISOString(),
    eventStride: 4, forceCloseAtEnd: false
  });
  assert.ok(replay.replayDataCoverage.fields.openInterest.availableEvents > 0);
  assert.ok(replay.replayDataCoverage.fields.basis.availableEvents > 0);
  assert.equal(replay.trace.some((item) => item.replayFields.openInterest.available && item.replayFields.basis.available), true);
});

test("real replay exposes an explicit coverage warning when all historical derivatives are absent", async () => {
  const candles = replayCandles();
  const eventTime = candles[60 * 96].timestamp;
  const dataset = { manifest: { datasetId: "missing-combination", manifestHash: "missing-combination" }, candles, funding: [], series: {} };
  const replay = await runHistoricalReplay(dataset, {
    strategy: "champion", from: new Date(eventTime).toISOString(), to: new Date(eventTime + 60 * 60 * 1000).toISOString(),
    eventStride: 4, forceCloseAtEnd: false
  });
  assert.equal(replay.replayDataCoverage.noDerivativeEvidence, true);
  assert.match(replay.replayDataCoverage.warning, /NO_DERIVATIVES_HISTORY/);
  assert.equal(replay.performance.decisions.counts.WAIT, replay.eventCount);
});
