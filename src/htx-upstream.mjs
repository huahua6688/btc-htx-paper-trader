import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { MARKET_TASKS } from "./market-data.mjs";
import { resolveCliPath, runPublicCommandWithBinary } from "./htx-cli.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceManifestPath = fileURLToPath(new URL("../vendor/htx-cli-source.json", import.meta.url));
const GITHUB_API = "https://api.github.com/repos/htx-exchange/htx-skills-hub";
const SOURCE_REPO = "https://github.com/htx-exchange/htx-skills-hub";
const RELEASE_ASSET_TIMEOUT_MS = 10 * 60_000;
export const HTX_UPDATE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const HTX_UPSTREAM = Object.freeze({
  sourceRepo: SOURCE_REPO,
  releasesApi: `${GITHUB_API}/releases/latest`,
  sourceManifestPath
});

function runtimeDirectory(environment = process.env) {
  const configured = environment.HTX_CLI_STATE_DIR?.trim();
  return configured ? resolve(configured) : fileURLToPath(new URL("../vendor/.htx-runtime/", import.meta.url));
}

export function htxRuntimePaths(environment = process.env) {
  const directory = runtimeDirectory(environment);
  return {
    directory,
    installedMetadata: join(directory, "installed.json"),
    upstreamCheck: join(directory, "upstream-check.json"),
    lock: join(directory, "update.lock")
  };
}

export function platformAssetName({ platform = process.platform, arch = process.arch } = {}) {
  if (arch !== "x64") throw new Error(`Unsupported HTX CLI architecture: ${platform}/${arch}`);
  if (platform === "linux") return "htx-cli-linux-x64";
  if (platform === "win32") return "htx-cli-windows-x64.exe";
  throw new Error(`Unsupported HTX CLI platform: ${platform}/${arch}`);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function defaultProcessExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function acquireUpdateLock(paths, {
  now,
  pid,
  hostnameValue,
  lockTimeoutMs,
  processExists
}) {
  const createLock = async () => {
    const handle = await open(paths.lock, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ pid, createdAt: now(), hostname: hostnameValue }, null, 2)}\n`, "utf8");
      return handle;
    } catch (error) {
      await handle.close();
      await rm(paths.lock, { force: true });
      throw error;
    }
  };

  try {
    return await createLock();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const [metadata, fileStat] = await Promise.all([
    readJson(paths.lock),
    stat(paths.lock).catch(() => null)
  ]);
  const createdMs = new Date(metadata?.createdAt ?? fileStat?.mtimeMs ?? null).getTime();
  const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : null;
  const expired = ageMs === null || ageMs > lockTimeoutMs;
  const sameHost = !metadata?.hostname || metadata.hostname === hostnameValue;
  const ownerGone = sameHost && Number.isInteger(Number(metadata?.pid)) && !processExists(Number(metadata.pid));
  if (!expired && !ownerGone) throw new Error("Another HTX CLI update is already running");

  await rm(paths.lock, { force: true });
  try {
    return await createLock();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another HTX CLI update acquired the lock while a stale lock was being cleaned");
    throw error;
  }
}

function assertOfficialRelease(release) {
  if (!release || release.draft || release.prerelease) throw new Error("Latest HTX release is missing, draft, or prerelease");
  if (!/^v\d+\.\d+\.\d+$/.test(String(release.tag_name))) throw new Error("Unexpected HTX release tag");
  if (!String(release.html_url ?? "").startsWith(`${SOURCE_REPO}/releases/tag/`)) throw new Error("HTX release identity is not from the official repository");
  return release;
}

function assertNormalizedReleaseIdentity(release) {
  if (!release || !/^v\d+\.\d+\.\d+$/.test(String(release.tag))) throw new Error("Unexpected HTX release identity");
  if (!String(release.url ?? "").startsWith(`${SOURCE_REPO}/releases/tag/`)) {
    throw new Error("HTX release identity is not from the official repository");
  }
  return release;
}

async function fetchJson(url, { fetchImpl = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://api.github.com" || !parsed.pathname.startsWith("/repos/htx-exchange/htx-skills-hub/")) {
    throw new Error("Blocked non-official HTX upstream URL");
  }
  const response = await fetchImpl(parsed, {
    headers: { accept: "application/vnd.github+json", "user-agent": "btc-htx-paper-updater/2" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`HTX upstream query failed: HTTP ${response.status}`);
  return response.json();
}

export async function fetchLatestHtxRelease({ fetchImpl = fetch } = {}) {
  const release = assertOfficialRelease(await fetchJson(HTX_UPSTREAM.releasesApi, { fetchImpl }));
  let commitSha = null;
  try {
    const commit = await fetchJson(`${GITHUB_API}/commits/${encodeURIComponent(release.tag_name)}`, { fetchImpl });
    commitSha = /^[0-9a-f]{40}$/i.test(String(commit.sha)) ? commit.sha : null;
  } catch {
    // Release identity remains usable even if the supplementary commit lookup is unavailable.
  }
  return {
    id: release.id,
    tag: release.tag_name,
    name: release.name || null,
    publishedAt: release.published_at,
    url: release.html_url,
    targetCommitish: release.target_commitish,
    commitSha,
    assets: (release.assets ?? []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: Number(asset.size),
      digest: asset.digest ?? null,
      downloadUrl: asset.browser_download_url,
      createdAt: asset.created_at
    }))
  };
}

export async function getHtxInstalledStatus({
  environment = process.env,
  cliPath = resolveCliPath(),
  verifyHash = true
} = {}) {
  const paths = htxRuntimePaths(environment);
  const [sourceManifest, installedMetadata, lastCheck] = await Promise.all([
    readJson(sourceManifestPath),
    readJson(paths.installedMetadata),
    readJson(paths.upstreamCheck)
  ]);
  const installed = await exists(cliPath);
  const installedSha256 = installed && verifyHash ? await sha256File(cliPath) : installedMetadata?.installedSha256 ?? null;
  const asset = platformAssetName();
  const lockedAsset = sourceManifest?.assets?.[`${process.platform}-${process.arch}`] ?? null;
  const identityMatchesMetadata = Boolean(installed && installedMetadata?.installedSha256 && installedSha256 === installedMetadata.installedSha256);
  return {
    sourceRepo: SOURCE_REPO,
    cliPath,
    asset,
    installed,
    installedSha256,
    hashVerified: Boolean(installed && verifyHash),
    identityMatchesMetadata: verifyHash ? identityMatchesMetadata : null,
    installedMetadata,
    sourceManifest,
    lockedAsset,
    lastCheck,
    upstreamUpdateAvailable: lastCheck && Object.hasOwn(lastCheck, "updateAvailable")
      ? lastCheck.updateAvailable
      : null
  };
}

export async function resolveHtxArchiveIdentity({
  environment = process.env,
  cliPath = resolveCliPath(),
  statusProvider = getHtxInstalledStatus,
  hashProvider = sha256File,
  warn = (message) => process.stderr.write(`${message}\n`)
} = {}) {
  let installed;
  try {
    // Read metadata without hashing here. The binary is hashed exactly once below,
    // at monitor process startup, and the resulting identity is reused by every cycle.
    installed = await statusProvider({ environment, cliPath, verifyHash: false });
  } catch (error) {
    const message = `HTX CLI identity unavailable for archive provenance: ${error.message}`;
    warn(message);
    return { release: null, sha256: null, metadataSha256: null, warnings: [message] };
  }

  const warnings = [];
  let actualSha256 = null;
  if (installed.installed) {
    try {
      actualSha256 = await hashProvider(installed.cliPath ?? cliPath);
    } catch (error) {
      const message = `HTX CLI binary SHA-256 unavailable for archive provenance: ${error.message}`;
      warnings.push(message);
      warn(message);
    }
  }

  const metadataSha256 = installed.installedMetadata?.installedSha256 ?? null;
  if (actualSha256 && metadataSha256 && actualSha256 !== metadataSha256) {
    const message = `HTX CLI metadata SHA-256 mismatch: archive will use actual binary SHA-256 ${actualSha256}`;
    warnings.push(message);
    warn(message);
  }

  return {
    release: installed.installedMetadata?.release?.tag ?? installed.sourceManifest?.release?.tag ?? null,
    // Never substitute a metadata digest for the actual binary digest. A failed
    // hash remains explicit null so provenance cannot silently claim the wrong CLI.
    sha256: actualSha256,
    metadataSha256,
    warnings
  };
}

function validateCompatibilityPayload(key, payload) {
  const array = (value) => Array.isArray(value);
  const finite = (value) => Number.isFinite(Number(value));
  const checks = {
    spotTicker: () => payload?.status === "ok" && finite(payload?.tick?.close) && finite(payload?.ts ?? payload?.tick?.ts),
    spotKline1h: () => array(payload?.data) && payload.data.length > 0 && ["id", "open", "high", "low", "close"].every((field) => payload.data[0]?.[field] !== undefined),
    spotDepth: () => array(payload?.tick?.bids) && array(payload?.tick?.asks) && finite(payload?.tick?.ts ?? payload?.ts),
    spotTrades: () => payload?.status === "ok" && array(payload?.data),
    ticker: () => payload?.status === "ok" && finite(payload?.tick?.close) && finite(payload?.ts ?? payload?.tick?.ts),
    kline15m: () => array(payload?.data) && payload.data.length > 0 && ["id", "open", "high", "low", "close"].every((field) => payload.data[0]?.[field] !== undefined),
    kline1h: () => checks.kline15m(), kline4h: () => checks.kline15m(), kline1d: () => checks.kline15m(),
    depth: () => array(payload?.tick?.bids) && array(payload?.tick?.asks) && finite(payload?.tick?.ts ?? payload?.ts),
    fundingCurrent: () => payload?.status === "ok" && payload?.data?.funding_rate !== undefined,
    fundingHistory: () => array(payload?.data?.data) && (!payload.data.data.length || payload.data.data[0].funding_time !== undefined),
    oiCurrent: () => array(payload?.data) && (!payload.data.length || payload.data[0].value !== undefined),
    oiHistory: () => array(payload?.data?.tick) && (!payload.data.tick.length || payload.data.tick[0].ts !== undefined),
    eliteAccount: () => array(payload?.data?.list),
    elitePosition: () => array(payload?.data?.list),
    liquidations: () => Number(payload?.code) === 200 && array(payload?.data),
    markPrice: () => array(payload?.data) && (!payload.data.length || payload.data[0].id !== undefined),
    premium: () => array(payload?.data) && (!payload.data.length || payload.data[0].id !== undefined),
    basis: () => array(payload?.data) && (!payload.data.length || payload.data[0].basis_rate !== undefined),
    contractElements: () => array(payload?.data) && (!payload.data.length || payload.data[0].contract_code === "BTC-USDT")
  };
  return Boolean(checks[key]?.());
}

export async function runHtxCompatibilitySmokeTest(cliPath, {
  commandRunner = (path, skill, subcommand, params) => runPublicCommandWithBinary(path, skill, subcommand, params, { timeoutMs: 30_000 }),
  concurrency = 3
} = {}) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, async () => {
    while (cursor < MARKET_TASKS.length) {
      const index = cursor++;
      const [key, skill, subcommand, params] = MARKET_TASKS[index];
      try {
        const payload = await commandRunner(cliPath, skill, subcommand, params);
        const compatible = validateCompatibilityPayload(key, payload);
        results[index] = { key, skill, subcommand, compatible, error: compatible ? null : "required JSON fields missing" };
      } catch (error) {
        results[index] = { key, skill, subcommand, compatible: false, error: error.message };
      }
    }
  });
  await Promise.all(workers);
  return {
    checkedAt: new Date().toISOString(),
    compatible: results.every((item) => item.compatible),
    commands: results
  };
}

export function buildHtxCapabilityReport(compatibility = null) {
  const current = MARKET_TASKS.map(([key, skill, subcommand]) => ({ key, skill, subcommand }));
  return {
    currentSupported: current,
    upstreamPublicNotAdopted: [
      "futures-market bbo/trade/history-trade/index/contract-info/risk-info/timestamp/heartbeat",
      "funding-rate batch/estimated-kline",
      "settlement public family"
    ],
    upstreamRestrictedNotAdopted: ["account and exchange-write families"],
    incompatible: compatibility?.commands?.filter((item) => !item.compatible) ?? [],
    whitelistAutoExpanded: false
  };
}

export async function checkHtxUpstream(options = {}) {
  const upstream = await (options.releaseProvider ?? fetchLatestHtxRelease)(options);
  const installed = await (options.installedStatusProvider ?? getHtxInstalledStatus)(options);
  const assetName = platformAssetName(options);
  const asset = upstream.assets.find((item) => item.name === assetName) ?? null;
  if (!asset) throw new Error(`Official release ${upstream.tag} has no ${assetName} asset`);
  const expectedSha256 = officialDigest(asset);
  const installedRelease = installed.installedMetadata?.release ?? installed.sourceManifest?.release ?? null;
  const installedAsset = installed.installedMetadata?.asset ?? installed.lockedAsset ?? null;
  let updateAvailable = null;
  let comparison;
  if (!installed.installed) {
    updateAvailable = true;
    comparison = "NOT_INSTALLED";
  } else if (expectedSha256) {
    updateAvailable = installed.installedSha256
      ? installed.installedSha256.toLowerCase() !== expectedSha256
      : null;
    comparison = installed.installedSha256 ? "OFFICIAL_SHA256" : "INSTALLED_SHA256_UNAVAILABLE";
  } else if (installedRelease?.tag && installedAsset?.name) {
    updateAvailable = installedRelease.tag !== upstream.tag || installedAsset.name !== asset.name;
    comparison = updateAvailable ? "RELEASE_OR_ASSET_CHANGED" : "RELEASE_AND_ASSET_MATCH";
  } else if (installedRelease?.tag) {
    updateAvailable = installedRelease.tag !== upstream.tag;
    comparison = updateAvailable ? "RELEASE_CHANGED" : "ASSET_IDENTITY_UNAVAILABLE";
  } else if (installedAsset?.name && installedAsset.name !== asset.name) {
    updateAvailable = true;
    comparison = "ASSET_CHANGED";
  } else {
    // An absent official digest is not evidence that an update exists. Keep the
    // result unknown when there is insufficient installed release identity.
    comparison = "INSUFFICIENT_IDENTITY_WITHOUT_OFFICIAL_CHECKSUM";
  }
  const result = {
    checkedAt: new Date().toISOString(),
    installed: {
      present: installed.installed,
      release: installedRelease?.tag ?? null,
      releaseId: installedRelease?.id ?? null,
      commitSha: installedRelease?.commitSha ?? null,
      assetName: installedAsset?.name ?? null,
      sha256: installed.installedSha256
    },
    upstream,
    selectedAsset: asset,
    officialChecksumProvided: Boolean(expectedSha256),
    officialChecksumVerified: Boolean(expectedSha256 && installed.installedSha256
      && installed.installedSha256.toLowerCase() === expectedSha256),
    comparison,
    updateAvailable
  };
  await writeJsonAtomic(htxRuntimePaths(options.environment).upstreamCheck, result);
  return result;
}

async function downloadOfficialAsset(asset, path, { fetchImpl = fetch } = {}) {
  const url = new URL(asset.downloadUrl);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/htx-exchange/htx-skills-hub/releases/download/")) {
    throw new Error("Blocked non-official HTX release asset URL");
  }
  const response = await fetchImpl(url, {
    headers: { accept: "application/octet-stream", "user-agent": "btc-htx-paper-updater/2" },
    redirect: "follow",
    // Official CLI assets are close to 100 MB. Keep the operation bounded, but do
    // not reject a valid release merely because a VPS/GitHub route is slower than
    // three minutes. Nothing is installed until this stream and every later gate pass.
    signal: AbortSignal.timeout(RELEASE_ASSET_TIMEOUT_MS)
  });
  if (!response.ok || !response.body) throw new Error(`HTX asset download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { mode: 0o700, flags: "wx" }));
}

async function verifyProjectCommands({ projectDirectory = projectRoot } = {}) {
  const options = { cwd: projectDirectory, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 };
  // Invoke the exact entry points behind npm test/check:safety without a shell.
  // This behaves identically on Linux and Windows and avoids npm.cmd spawn EINVAL.
  await execFileAsync(process.execPath, ["--test", "test/*.test.mjs"], options);
  await execFileAsync(process.execPath, ["scripts/check-safety.mjs"], options);
}

function officialDigest(asset) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest ?? ""));
  return match?.[1]?.toLowerCase() ?? null;
}

export async function updateHtxCli({
  environment = process.env,
  cliPath = resolveCliPath(),
  releaseProvider = fetchLatestHtxRelease,
  downloadAsset = downloadOfficialAsset,
  smokeTest = runHtxCompatibilitySmokeTest,
  verifyProject = verifyProjectCommands,
  replaceBinary = rename,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  pid = process.pid,
  hostnameValue = hostname(),
  lockTimeoutMs = HTX_UPDATE_LOCK_TIMEOUT_MS,
  processExists = defaultProcessExists
} = {}) {
  const paths = htxRuntimePaths(environment);
  await mkdir(paths.directory, { recursive: true });
  const lock = await acquireUpdateLock(paths, { now, pid, hostnameValue, lockTimeoutMs, processExists });
  let stageDirectory = null;
  let backupPath = null;
  let movedOld = false;
  let installedNew = false;
  try {
    const release = assertNormalizedReleaseIdentity(await releaseProvider({ fetchImpl }));
    const assetName = platformAssetName();
    const asset = release.assets.find((item) => item.name === assetName);
    if (!asset) throw new Error(`Official release ${release.tag} does not contain ${assetName}`);
    await mkdir(dirname(cliPath), { recursive: true });
    stageDirectory = await mkdtemp(join(dirname(cliPath), ".htx-staging-"));
    const stagedPath = join(stageDirectory, assetName);
    await downloadAsset(asset, stagedPath, { fetchImpl });
    if (process.platform !== "win32") await chmod(stagedPath, 0o755);
    const stagedSize = Number((await stat(stagedPath)).size);
    if (Number.isFinite(Number(asset.size)) && Number(asset.size) > 0 && stagedSize !== Number(asset.size)) {
      throw new Error(`Official asset size mismatch for ${assetName}: expected ${asset.size}, received ${stagedSize}`);
    }
    const localSha256 = await sha256File(stagedPath);
    const expected = officialDigest(asset);
    if (expected && localSha256 !== expected) throw new Error(`Official checksum mismatch for ${assetName}`);
    const compatibility = await smokeTest(stagedPath);
    if (!compatibility.compatible) throw new Error("HTX CLI compatibility smoke test failed");
    await verifyProject({ projectDirectory: projectRoot });

    const oldExists = await exists(cliPath);
    const oldSha256 = oldExists ? await sha256File(cliPath) : null;
    if (oldExists && oldSha256 === localSha256) {
      const metadata = {
        schemaVersion: 1,
        sourceRepo: SOURCE_REPO,
        release,
        asset: { ...asset, officialChecksumProvided: Boolean(expected), officialChecksumVerified: Boolean(expected) },
        installedSha256: localSha256,
        installedAt: (await readJson(paths.installedMetadata))?.installedAt ?? now(),
        lastVerifiedAt: now(),
        compatibility,
        capabilityReport: buildHtxCapabilityReport(compatibility)
      };
      await writeJsonAtomic(paths.installedMetadata, metadata);
      return { changed: false, metadata, compatibility, backupPath: null };
    }

    if (oldExists) {
      const rollbackDirectory = join(dirname(cliPath), "rollback");
      await mkdir(rollbackDirectory, { recursive: true });
      backupPath = join(rollbackDirectory, `${assetName}.${oldSha256}.bak`);
      if (await exists(backupPath)) await unlink(cliPath);
      else await rename(cliPath, backupPath);
      movedOld = true;
    }
    await replaceBinary(stagedPath, cliPath);
    installedNew = true;
    const metadata = {
      schemaVersion: 1,
      sourceRepo: SOURCE_REPO,
      release,
      asset: { ...asset, officialChecksumProvided: Boolean(expected), officialChecksumVerified: Boolean(expected) },
      installedSha256: localSha256,
      installedAt: now(),
      previous: oldSha256 ? { sha256: oldSha256, backupPath } : null,
      compatibility,
      capabilityReport: buildHtxCapabilityReport(compatibility)
    };
    await writeJsonAtomic(paths.installedMetadata, metadata);
    return { changed: true, metadata, compatibility, backupPath };
  } catch (error) {
    // Replacement is a single failure domain: once the old binary moved, every
    // later error (candidate rename or metadata write included) restores it.
    if (installedNew && await exists(cliPath)) await unlink(cliPath);
    if (movedOld && backupPath && await exists(backupPath) && !await exists(cliPath)) {
      await copyFile(backupPath, cliPath);
    }
    throw error;
  } finally {
    await lock?.close();
    await rm(paths.lock, { force: true });
    if (stageDirectory) await rm(stageDirectory, { recursive: true, force: true });
  }
}

export async function verifyHtxSourceLock() {
  const manifest = await readJson(sourceManifestPath);
  if (!manifest?.sourceRepo || !manifest?.release?.tag) throw new Error("HTX source lock is missing or invalid");
  return manifest;
}
