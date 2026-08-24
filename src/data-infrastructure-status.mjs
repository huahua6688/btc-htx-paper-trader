import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKET_ARCHIVE_CONFIG } from "./config.mjs";
import { defaultCatalogDirectory } from "./historical-data.mjs";
import { htxRuntimePaths, getHtxInstalledStatus, HTX_UPSTREAM } from "./htx-upstream.mjs";
import { resolveCliPath } from "./htx-cli.mjs";
import { readMarketArchiveStatus } from "./market-archive.mjs";
import { readJson } from "./research-utils.mjs";

function safeJsonSync(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function unavailableArchive(path, error = null) {
  return {
    path,
    available: false,
    coverage: [],
    storage: null,
    latestIngest: null,
    error: error ? String(error.message ?? error) : null
  };
}

function safeArchiveStatus(path) {
  try {
    return readMarketArchiveStatus(path);
  } catch (error) {
    return unavailableArchive(path, error);
  }
}

function catalogSummary(manifest, directory) {
  if (!manifest) return { directory, available: false, schemaVersion: null, coverage: null, sources: [] };
  return {
    directory,
    available: true,
    schemaVersion: manifest.schemaVersion,
    datasetId: manifest.datasetId,
    manifestHash: manifest.manifestHash,
    quality: manifest.quality,
    coverage: manifest.actualCoverage,
    sources: Object.entries(manifest.sources ?? {}).map(([type, source]) => ({
      type,
      availability: source.availability,
      records: Number(source.records ?? 0),
      earliest: source.earliest ?? null,
      latest: source.latest ?? null,
      gaps: source.gaps?.length ?? 0,
      error: source.error ?? null
    }))
  };
}

function replayAvailability(catalog, archive) {
  const archiveTypes = new Map((archive.coverage ?? []).map((item) => [item.type, item]));
  const catalogTypes = new Map((catalog.sources ?? []).map((item) => [item.type, item]));
  const fields = [
    ["depth", "depth"], ["openInterest", "oiHistory"], ["eliteAccount", "eliteAccount"],
    ["elitePosition", "elitePosition"], ["liquidations", "liquidations"],
    ["markPrice", "markPrice"], ["premium", "premium"], ["basis", "basis"],
    ["contractElements", "contractElements"]
  ];
  return fields.map(([field, archiveType]) => {
    const historical = catalogTypes.get(field);
    const archived = archiveTypes.get(archiveType);
    return {
      field,
      provenance: archived?.records
        ? "SELF_ARCHIVED"
        : historical?.records
          ? "HTX_HISTORICAL"
          : historical?.availability === "STALE"
            ? "STALE"
            : historical?.availability === "LIVE_FAILURE"
              ? "LIVE_FAILURE"
              : "HISTORICAL_UNAVAILABLE",
      historicalRecords: historical?.records ?? 0,
      archiveRecords: archived?.records ?? 0,
      latest: archived?.latest ?? historical?.latest ?? null
    };
  });
}

function sourceHealth(db) {
  return db?.getLatestDataSourceQuality?.().map((item) => ({
    source: item.source_key,
    status: item.quality_status,
    lastSuccessAt: item.missing ? null : item.provider_updated_at ?? item.collected_at,
    collectedAt: item.collected_at,
    missing: Boolean(item.missing)
  })) ?? [];
}

export async function buildDataInfrastructureStatus(db, {
  catalogDirectory = defaultCatalogDirectory(),
  archivePath = MARKET_ARCHIVE_CONFIG.path,
  verifyCliHash = false,
  installedStatusProvider = getHtxInstalledStatus
} = {}) {
  const [htx, manifest] = await Promise.all([
    installedStatusProvider({ verifyHash: verifyCliHash }),
    readJson(join(catalogDirectory, "manifest.json"), null)
  ]);
  const catalog = catalogSummary(manifest, catalogDirectory);
  const archive = safeArchiveStatus(archivePath);
  return {
    checkedAt: new Date().toISOString(),
    htx: {
      installed: htx.installed,
      path: htx.cliPath,
      release: htx.installedMetadata?.release?.tag ?? htx.sourceManifest?.release?.tag ?? null,
      sha256: htx.installedSha256,
      updateAvailable: htx.upstreamUpdateAvailable,
      compatibility: htx.installedMetadata?.compatibility ?? null,
      sourceRepo: htx.sourceRepo
    },
    sources: sourceHealth(db),
    archive,
    catalog,
    replayFields: replayAvailability(catalog, archive)
  };
}

export function readDataInfrastructureStatusSync(db, {
  catalogDirectory = defaultCatalogDirectory(),
  archivePath = MARKET_ARCHIVE_CONFIG.path,
  environment = process.env
} = {}) {
  const paths = htxRuntimePaths(environment);
  const installedMetadata = safeJsonSync(paths.installedMetadata);
  const sourceManifest = safeJsonSync(HTX_UPSTREAM.sourceManifestPath);
  const lastCheck = safeJsonSync(paths.upstreamCheck);
  const cliPath = resolveCliPath();
  const catalog = catalogSummary(safeJsonSync(join(catalogDirectory, "manifest.json")), catalogDirectory);
  const archive = safeArchiveStatus(archivePath);
  return {
    checkedAt: new Date().toISOString(),
    htx: {
      installed: existsSync(cliPath), path: cliPath,
      release: installedMetadata?.release?.tag ?? sourceManifest?.release?.tag ?? null,
      sha256: installedMetadata?.installedSha256 ?? null,
      updateAvailable: lastCheck?.updateAvailable ?? null,
      compatibility: installedMetadata?.compatibility ?? null,
      sourceRepo: sourceManifest?.sourceRepo ?? HTX_UPSTREAM.sourceRepo
    },
    sources: sourceHealth(db), archive, catalog,
    replayFields: replayAvailability(catalog, archive)
  };
}

export function formatDataInfrastructureStatus(status) {
  const compatible = status.htx.compatibility;
  const lines = [
    "HTX Integration + Research Data V2",
    `HTX CLI：${status.htx.installed ? "INSTALLED" : "MISSING"} / ${status.htx.release ?? "未知"}`,
    `CLI SHA-256：${status.htx.sha256 ?? "—"}`,
    `上游更新：${status.htx.updateAvailable === null ? "未检查" : status.htx.updateAvailable ? "AVAILABLE" : "CURRENT"}`,
    `命令兼容：${compatible ? compatible.compatible ? `PASS (${compatible.commands.length})` : "FAIL" : "尚未运行"}`,
    `Archive：${status.archive.available ? `${status.archive.storage.records} records / ${status.archive.path}` : `${status.archive.error ? `不可读取（${status.archive.error}）` : "尚未建立"} / ${status.archive.path}`}`,
    `Catalog：${status.catalog.available ? `schema v${status.catalog.schemaVersion} / ${status.catalog.quality} / ${status.catalog.coverage?.from ?? "—"} → ${status.catalog.coverage?.to ?? "—"}` : `尚未建立 / ${status.catalog.directory}`}`,
    "Replay 字段：",
    ...status.replayFields.map((item) => `- ${item.field}: ${item.provenance}（historical ${item.historicalRecords} / archive ${item.archiveRecords}）`),
    "实时数据源：",
    ...(status.sources.length ? status.sources.map((item) => `- ${item.source}: ${item.status} / 最近成功 ${item.lastSuccessAt ?? "—"}`) : ["- 尚无 monitor 采集记录"]),
    "安全：只读 public data；无账户、下单或交易所写权限。"
  ];
  return lines.join("\n");
}
