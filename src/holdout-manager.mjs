import { join } from "node:path";
import { hashObject, readJson, resolveResearchPath, writeJsonAtomic } from "./research-utils.mjs";

export function defaultHoldoutRegistryPath() { return resolveResearchPath("holdout-registry.json"); }
export function defaultCollectingHoldoutRegistryPath() { return resolveResearchPath("holdout-registry-v2.json"); }

function rangeRows(dataset, from, to) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const candles = dataset.candles.filter((item) => item.timestamp >= start && item.timestamp <= end);
  const funding = dataset.funding.filter((item) => item.timestamp >= start && item.timestamp <= end + 8 * 60 * 60 * 1000);
  if (!candles.length) throw new Error("New untouched holdout has no candles");
  return { candles, funding };
}

export async function sealUntouchedHoldout(dataset, {
  from,
  to,
  registryPath = defaultHoldoutRegistryPath()
}) {
  const existing = await readJson(registryPath);
  if (existing) {
    if (existing.holdout?.from !== from || existing.holdout?.to !== to
      || existing.dataManifestHash !== dataset.manifest.manifestHash) {
      throw new Error("A different holdout registry already exists; it may not be overwritten");
    }
    return existing;
  }
  const rows = rangeRows(dataset, from, to);
  const registry = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    dataManifestHash: dataset.manifest.manifestHash,
    datasetId: dataset.manifest.datasetId,
    developmentCutoff: "2026-07-31T23:45:00.000Z",
    priorConsumedFinalOos: {
      from: "2026-02-07T05:45:00.000Z",
      to: "2026-07-31T23:45:00.000Z",
      status: "SEALED_USED_BY_PRIOR_OPTIMIZATION",
      mayTuneFutureCandidates: false
    },
    holdout: {
      id: "post-2026-07-31-untouched-v1",
      from,
      to,
      candleCount: rows.candles.length,
      fundingCount: rows.funding.length,
      candleRangeHash: hashObject(rows.candles),
      fundingRangeHash: hashObject(rows.funding),
      status: "UNTOUCHED",
      selectionEvidence: null,
      openedAt: null,
      usedAt: null,
      resultEvidence: null
    },
    policy: {
      candidateGenerationMayReadHoldout: false,
      candidateRankingMayReadHoldout: false,
      selectedCandidateMayOpenOnce: true,
      resultMayTuneSameHoldout: false
    }
  };
  registry.registryHash = hashObject(registry);
  await writeJsonAtomic(registryPath, registry);
  return registry;
}

export async function openHoldoutForSelectedCandidate(dataset, {
  registryPath = defaultHoldoutRegistryPath(),
  selectedCandidate,
  selectionEvidenceHash,
  selectionCompletedAt
}) {
  const registry = await readJson(registryPath);
  if (!registry) throw new Error("Holdout registry does not exist");
  if (registry.dataManifestHash !== dataset.manifest.manifestHash) throw new Error("Holdout manifest hash changed after sealing");
  if (!selectedCandidate?.version || !selectedCandidate?.strategyHash || !selectionEvidenceHash) throw new Error("Selected candidate evidence is incomplete");
  if (new Date(selectionCompletedAt).getTime() > Date.now()) throw new Error("Invalid candidate selection timestamp");
  if (registry.holdout.status === "USED") throw new Error("Untouched holdout was already consumed and is sealed");
  if (registry.holdout.status === "OPENED"
    && registry.holdout.selectionEvidence?.strategyHash !== selectedCandidate.strategyHash) {
    throw new Error("Holdout was opened by a different selected candidate");
  }
  if (registry.holdout.status === "UNTOUCHED") {
    registry.holdout.status = "OPENED";
    registry.holdout.openedAt = new Date().toISOString();
    registry.holdout.selectionEvidence = {
      version: selectedCandidate.version,
      strategyHash: selectedCandidate.strategyHash,
      selectionEvidenceHash,
      selectionCompletedAt
    };
    registry.registryHash = hashObject({ ...registry, registryHash: undefined });
    await writeJsonAtomic(registryPath, registry);
  }
  const rows = rangeRows(dataset, registry.holdout.from, registry.holdout.to);
  if (hashObject(rows.candles) !== registry.holdout.candleRangeHash || hashObject(rows.funding) !== registry.holdout.fundingRangeHash) {
    throw new Error("Holdout content hash changed after sealing");
  }
  return { registry, range: { from: registry.holdout.from, to: registry.holdout.to } };
}

export async function markHoldoutUsed({
  registryPath = defaultHoldoutRegistryPath(),
  selectedCandidateHash,
  resultEvidence
}) {
  const registry = await readJson(registryPath);
  if (!registry || registry.holdout.status !== "OPENED") throw new Error("Holdout must be OPENED before it can be marked USED");
  if (registry.holdout.selectionEvidence.strategyHash !== selectedCandidateHash) throw new Error("Holdout selected-candidate hash mismatch");
  registry.holdout.status = "USED";
  registry.holdout.usedAt = new Date().toISOString();
  registry.holdout.resultEvidence = resultEvidence;
  registry.policy.resultMayTuneSameHoldout = false;
  registry.registryHash = hashObject({ ...registry, registryHash: undefined });
  await writeJsonAtomic(registryPath, registry);
  return registry;
}

export async function copyHoldoutRegistry(registryPath, outputDirectory) {
  const registry = await readJson(registryPath);
  if (!registry) return null;
  const path = join(outputDirectory, "holdout-registry.json");
  await writeJsonAtomic(path, registry);
  return path;
}

export async function updateCollectingHoldout(dataset, {
  from,
  minimumCalendarDays = 30,
  minimumBars = minimumCalendarDays * 96,
  registryPath = defaultCollectingHoldoutRegistryPath(),
  preselectedCandidate = null
}) {
  const start = new Date(from).getTime();
  if (!Number.isFinite(start)) throw new Error("Collecting holdout requires a valid future start timestamp");
  const existing = await readJson(registryPath);
  if (existing && existing.holdout.from !== new Date(start).toISOString()) {
    throw new Error("Collecting holdout start is immutable and may not be overwritten");
  }
  if (existing?.holdout.status === "USED") return existing;
  // Holdout boundaries use catalog candle-open timestamps, matching Historical Replay.
  // The candle immediately before `from` may close at `from`, but it belonged to the
  // prior consumed interval and must not be counted again.
  const candles = dataset.candles.filter((row) => row.timestamp >= start);
  const latestVisibleAt = candles.length ? candles.at(-1).timestamp + 15 * 60 * 1000 : null;
  const targetEarliestEnd = start + minimumCalendarDays * 24 * 60 * 60 * 1000;
  const mature = candles.length >= minimumBars && Number(latestVisibleAt) >= targetEarliestEnd;
  const registry = existing ?? {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    datasetId: dataset.manifest.datasetId,
    priorConsumedFinalOos: [
      { from: "2026-02-07T05:45:00.000Z", to: "2026-07-31T23:45:00.000Z", status: "USED", mayTuneFutureCandidates: false },
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-23T05:30:00.000Z", status: "USED", mayTuneFutureCandidates: false }
    ],
    policy: {
      valuesMayBeReadBeforeMaturity: false,
      candidateMayBeSelectedBeforeCollection: true,
      selectedCandidateMayOpenOnceAfterMaturity: true,
      resultMayTuneSameHoldout: false
    },
    holdout: {
      id: "post-2026-08-23-future-untouched-v2",
      from: new Date(start).toISOString(),
      targetEarliestEnd: new Date(targetEarliestEnd).toISOString(),
      minimumCalendarDays,
      minimumBars,
      status: "COLLECTING",
      preselectedCandidate: null,
      openedAt: null,
      usedAt: null
    }
  };
  if (preselectedCandidate) {
    const old = registry.holdout.preselectedCandidate;
    if (old && old.strategyHash !== preselectedCandidate.strategyHash) {
      throw new Error("Collecting holdout is already reserved for a different preselected candidate");
    }
    registry.holdout.preselectedCandidate = preselectedCandidate;
  }
  registry.lastObservedAt = new Date().toISOString();
  registry.latestDataManifestHash = dataset.manifest.manifestHash;
  registry.holdout.observedBars = candles.length;
  registry.holdout.latestVisibleAt = latestVisibleAt ? new Date(latestVisibleAt).toISOString() : null;
  registry.holdout.remainingBars = Math.max(0, minimumBars - candles.length);
  registry.holdout.status = mature ? "READY_UNOPENED" : "COLLECTING";
  registry.registryHash = hashObject({ ...registry, registryHash: undefined });
  await writeJsonAtomic(registryPath, registry);
  return registry;
}
