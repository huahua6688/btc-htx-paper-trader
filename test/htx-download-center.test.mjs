import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  HTX_DOWNLOAD_CENTER_AUDIT,
  HTX_DOWNLOAD_CENTER_SOURCES,
  extractSingleCsvZip,
  fetchHtxDownloadCenterOnDemand,
  htxDownloadCenterUrl,
  loadHtxDownloadCenterCatalog,
  pointInTimeDownloadRecords,
  updateHtxDownloadCenterCatalog
} from "../src/htx-download-center.mjs";
import { HTX_HISTORICAL_CAPABILITIES } from "../src/historical-data.mjs";
import { buildPointInTimeMarket } from "../src/replay-market.mjs";

function storedZip(fileName, content) {
  const name = Buffer.from(fileName);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function deflatedZipWithFalseSmallSize(fileName, content, advertisedSize = 100) {
  const name = Buffer.from(fileName);
  const compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(advertisedSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(advertisedSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function headers(values = {}) {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}

function tarGz(fileName, content) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(fileName, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

test("official Download Center catalog verifies checksum, hashes files and enforces PIT visibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-download-center-"));
  const date = "2026-02-01";
  const klineName = "BTC-USDT-PERP-klines-15m-2026-02-01.zip";
  const klineZip = storedZip(klineName.replace(".zip", ".csv"), [
    "instId,open,high,low,close,vol,volCcy,volCcyQuote,ts",
    "BTC-USDT-PERP,100,102,99,101,10,1,1000,1769904000"
  ].join("\n"));
  const klineHash = createHash("sha256").update(klineZip).digest("hex");
  const tradeChecksum = "a".repeat(64);
  const fetchImpl = async (url, options = {}) => {
    const file = basename(url.pathname.replace(/\.CHECKSUM$/, ""));
    const isChecksum = url.pathname.endsWith(".CHECKSUM");
    const isTrade = url.pathname.includes("/trades/");
    if (isChecksum) {
      return {
        ok: true, status: 200, headers: headers(),
        text: async () => `${isTrade ? tradeChecksum : klineHash}  ${file}`
      };
    }
    if (options.method === "HEAD") {
      return { ok: true, status: 200, headers: headers({ "content-length": "123456", etag: '"trade-etag"' }) };
    }
    return {
      ok: true, status: 200, headers: headers({ etag: '"kline-etag"' }),
      arrayBuffer: async () => klineZip
    };
  };
  try {
    const result = await updateHtxDownloadCenterCatalog({
      from: date,
      to: date,
      directory,
      dataTypes: ["futuresKline", "futuresTrades"],
      fetchImpl,
      nowMs: Date.UTC(2026, 1, 3)
    });
    assert.equal(result.manifest.settlementRestUsedAsDownloadCenter, false);
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresKline").availability, "INGESTED_PIT");
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresKline").sha256, klineHash);
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresTrades").availability, "CATALOGED_ON_DEMAND");
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresTrades").downloaded, false);
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresTrades").officialChecksumAdvertised, tradeChecksum);
    assert.equal(result.manifest.archives.find((item) => item.type === "futuresTrades").contentChecksumVerified, false);

    const loaded = await loadHtxDownloadCenterCatalog(directory);
    const record = loaded.series.futuresKline[0];
    assert.equal(record.eventTime, 1769904000000);
    assert.equal(record.visibleAt, record.eventTime + 15 * 60_000);
    assert.equal(pointInTimeDownloadRecords([record], record.visibleAt - 1).length, 0);
    assert.equal(pointInTimeDownloadRecords([record], record.visibleAt).length, 1);
    assert.equal(record.officialChecksum, klineHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ZIP extraction enforces the actual inflated byte limit even when metadata lies", () => {
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 65);
  const archive = deflatedZipWithFalseSmallSize("malicious.csv", oversized);
  assert.throws(() => extractSingleCsvZip(archive), /fixed safe size limit/);
});

test("on-demand trades download stores the archive, verifies its content and optionally parses PIT rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-trades-on-demand-"));
  const date = "2026-02-01";
  const fileName = "BTC-USDT-PERP-trades-2026-02-01.zip";
  const archive = storedZip(fileName.replace(".zip", ".csv"), [
    "instId,tradeId,price,qty,side,ts",
    "BTC-USDT-PERP,t-1,101,0.2,buy,1769904000123",
    "BTC-USDT-PERP,t-2,102,0.1,sell,1769904000456"
  ].join("\n"));
  const checksum = createHash("sha256").update(archive).digest("hex");
  const fetchImpl = async (url) => url.pathname.endsWith(".CHECKSUM")
    ? { ok: true, status: 200, headers: headers(), text: async () => `${checksum}  ${fileName}` }
    : { ok: true, status: 200, headers: headers({ "content-length": String(archive.length), etag: '"trades"' }), arrayBuffer: async () => archive };
  try {
    const result = await fetchHtxDownloadCenterOnDemand({
      type: "futuresTrades", date, parse: true, directory, fetchImpl, nowMs: Date.UTC(2026, 1, 3)
    });
    const descriptor = result.manifest.archives.find((item) => item.type === "futuresTrades" && item.date === date);
    assert.equal(descriptor.availability, "INGESTED_PIT_ON_DEMAND");
    assert.equal(descriptor.contentChecksumVerified, true);
    assert.equal(descriptor.localSha256, checksum);
    assert.equal(createHash("sha256").update(await readFile(join(directory, descriptor.localFile))).digest("hex"), checksum);
    const loaded = await loadHtxDownloadCenterCatalog(directory);
    assert.equal(loaded.series.futuresTrades.length, 2);
    assert.equal(loaded.series.futuresTrades[0].visibleAt, loaded.series.futuresTrades[0].eventTime);
    assert.equal(pointInTimeDownloadRecords(loaded.series.futuresTrades, 1769904000122).length, 0);
    assert.equal(pointInTimeDownloadRecords(loaded.series.futuresTrades, 1769904000123).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("large depth requires explicit opt-in, verifies the downloaded TAR.GZ and becomes Replay-consumable only when parsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "htx-depth-on-demand-"));
  const date = "2026-05-28";
  const fileName = "BTC-USDT-PERP-l2orderbook-150lv-2026-05-28.tar.gz";
  const replayVisibleAt = Date.UTC(2026, 4, 28, 0, 15, 0);
  const eventTime = replayVisibleAt - 1_000;
  const archive = tarGz(fileName.replace(".tar.gz", ".data"), [
    JSON.stringify({ instId: "BTC-USDT-PERP", action: "snapshot", ts: String(eventTime * 1000), bids: [[100, 2], [99, 3]], asks: [[101, 4], [102, 5]] }),
    JSON.stringify({ instId: "BTC-USDT-PERP", action: "update", ts: String(replayVisibleAt * 1000), bids: [[100, 0], [100.5, 6]], asks: [[101, 7]] })
  ].join("\n"));
  const checksum = createHash("sha256").update(archive).digest("hex");
  let archiveGets = 0;
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith(".CHECKSUM")) return { ok: true, status: 200, headers: headers(), text: async () => `${checksum}  ${fileName}` };
    archiveGets += 1;
    return { ok: true, status: 200, headers: headers({ "content-length": String(archive.length) }), arrayBuffer: async () => archive };
  };
  try {
    await assert.rejects(fetchHtxDownloadCenterOnDemand({
      type: "futuresDepth", date, parse: true, directory, fetchImpl, nowMs: Date.UTC(2026, 4, 30)
    }), /allowLargeDepth=true/);
    assert.equal(archiveGets, 0, "depth must not start downloading before explicit large-file opt-in");

    const result = await fetchHtxDownloadCenterOnDemand({
      type: "futuresDepth", date, parse: true, allowLargeDepth: true,
      directory, fetchImpl, nowMs: Date.UTC(2026, 4, 30)
    });
    const descriptor = result.manifest.archives.find((item) => item.type === "futuresDepth" && item.date === date);
    assert.equal(descriptor.availability, "INGESTED_PIT_ON_DEMAND");
    assert.equal(descriptor.contentChecksumVerified, true);
    const loaded = await loadHtxDownloadCenterCatalog(directory);
    assert.deepEqual(loaded.series.futuresDepth.at(-1).normalized.bids, [[100.5, 6], [99, 3]]);
    const barMs = 15 * 60_000;
    const candles = [
      { timestamp: replayVisibleAt - barMs, open: 100, high: 101, low: 99, close: 100, volumeBtc: 1, volumeContracts: 1, turnoverUsdt: 100, trades: 1 }
    ];
    const market = buildPointInTimeMarket(candles, [], 0, { historicalSeries: { depth: loaded.series.futuresDepth } });
    assert.equal(market.replay.fieldStatus.depth.provenance, "HTX_HISTORICAL");
    assert.deepEqual(market.depth.tick.asks, [[101, 7], [102, 5]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coverage and archive paths distinguish official downloads from Settlement REST", () => {
  assert.equal(HTX_DOWNLOAD_CENTER_AUDIT.settlementRestIsDownloadCenter, false);
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.futuresKline.firstAvailableDate, "2026-02-01");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.spotTrades.firstAvailableDate, "2026-02-01");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.futuresDepth.firstAvailableDate, "2026-05-28");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.spotDepth.firstAvailableDate, "2026-05-28");
  assert.match(htxDownloadCenterUrl("futuresDepth", "2026-08-23").pathname, /orderbook\/lv150\/BTC-USDT-PERP/);
  assert.match(htxDownloadCenterUrl("spotDepth", "2026-08-23").pathname, /orderbook\/lv400\/BTC-USDT/);
  assert.equal(HTX_HISTORICAL_CAPABILITIES.settlement.mode, "PAGED_BOUNDED_RETENTION");
  assert.equal(HTX_HISTORICAL_CAPABILITIES.depth.mode, "OFFICIAL_DOWNLOAD_CENTER_CATALOG_ON_DEMAND");
});
