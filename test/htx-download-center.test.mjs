import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  HTX_DOWNLOAD_CENTER_AUDIT,
  HTX_DOWNLOAD_CENTER_SOURCES,
  htxDownloadCenterUrl,
  loadHtxDownloadCenterCatalog,
  pointInTimeDownloadRecords,
  updateHtxDownloadCenterCatalog
} from "../src/htx-download-center.mjs";
import { HTX_HISTORICAL_CAPABILITIES } from "../src/historical-data.mjs";

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

function headers(values = {}) {
  return { get: (name) => values[name.toLowerCase()] ?? null };
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

test("coverage and archive paths distinguish official downloads from Settlement REST", () => {
  assert.equal(HTX_DOWNLOAD_CENTER_AUDIT.settlementRestIsDownloadCenter, false);
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.futuresKline.firstVerifiedDate, "2026-02-01");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.spotTrades.firstVerifiedDate, "2026-02-01");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.futuresDepth.firstVerifiedDate, "2026-05-28");
  assert.equal(HTX_DOWNLOAD_CENTER_SOURCES.spotDepth.firstVerifiedDate, "2026-05-28");
  assert.match(htxDownloadCenterUrl("futuresDepth", "2026-08-23").pathname, /orderbook\/lv150\/BTC-USDT-PERP/);
  assert.match(htxDownloadCenterUrl("spotDepth", "2026-08-23").pathname, /orderbook\/lv400\/BTC-USDT/);
  assert.equal(HTX_HISTORICAL_CAPABILITIES.settlement.mode, "PAGED_BOUNDED_RETENTION");
  assert.equal(HTX_HISTORICAL_CAPABILITIES.depth.mode, "OFFICIAL_DOWNLOAD_CENTER_CATALOG_ON_DEMAND");
});
