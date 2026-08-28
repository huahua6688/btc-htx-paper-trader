import { existsSync, readFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PAPER_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";
import { evaluateV4RobustnessEvidence } from "./monte-carlo.mjs";
import { calculatePerformance } from "./paper-engine.mjs";
import { hashObject, readJson, resolveResearchPath, round, writeJsonAtomic } from "./research-utils.mjs";
import { evaluateV12V4FusionShadowEvidence, verifyV12V4FusionActiveShadowConfiguration } from "./v12-v4-fusion.mjs";

export const BREAKOUT_V4_SHADOW_POLICY = Object.freeze({
  minimumCalendarDays: 30,
  minimumDirectionalSignals: 100,
  maximumMissingTimingRate: 0.05,
  maximumSignalAgeMs: 5 * 60 * 1000,
  minimumNetReturnPct: 0,
  minimumProfitFactor: 1.05,
  paperOnly: true,
  championMustRemainUnchanged: true,
  automaticPromotion: false
});

const METRIC_BINDINGS = Object.freeze([
  ["tradeCount", "trades"],
  ["netReturnPct", "returnPct"],
  ["profitFactor", "profitFactor"],
  ["maxDrawdownPct", "maxDrawdownPct"]
]);

function sameNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8;
}

function assertMetricBinding(expected, actual, label) {
  for (const [selectionKey, robustnessKey] of METRIC_BINDINGS) {
    if (!sameNumber(expected?.[selectionKey], actual?.[robustnessKey])) {
      throw new Error(`V4 Shadow robustness ${label} metric mismatch: ${selectionKey}`);
    }
  }
}

function recomputeRobustnessGate(report) {
  return evaluateV4RobustnessEvidence({
    tradeOrderResampling: report.tradeOrderResampling,
    blockBootstrap: report.blockBootstrap,
    pairedAccounting: report.pairedAccounting,
    parameterPerturbation: report.parameterPerturbation,
    delayedExecutionEvidence: report.delayedExecutionEvidence,
    deterministicStress: report.deterministicStress,
    base: report.base,
    policy: report.gate?.policy
  });
}

/**
 * A V4 candidate may enter Shadow only when every numerical robustness gate
 * passed and the sole remaining blocker is evidence that 15m history cannot
 * honestly produce: timestamped one-to-five-minute execution observations.
 */
export function verifyBreakoutV4RobustnessForShadow(selection, report) {
  if (selection?.report?.runType !== "BREAKOUT_V4_LOCAL_RESILIENCE_DEVELOPMENT_ONLY_SELECTION") {
    throw new Error("V4 Shadow requires a verified local-resilience selection");
  }
  if (!report || report.runType !== "MONTE_CARLO_AND_REPLAY_ROBUSTNESS") {
    throw new Error("--robustness must point to a complete V4 robustness-report.json");
  }
  if (report.base?.strategyHash !== selection.parameterHash || report.base?.executable !== true) {
    throw new Error("V4 Shadow robustness base is not the selected executable strategy");
  }
  assertMetricBinding(selection.report.winner?.baseMetrics, report.base, "base");

  const expectedPerturbations = selection.report.winner?.perturbations ?? [];
  const actualPerturbations = report.parameterPerturbation ?? [];
  if (expectedPerturbations.length !== 6 || actualPerturbations.length !== expectedPerturbations.length) {
    throw new Error("V4 Shadow robustness perturbation evidence is incomplete");
  }
  for (let index = 0; index < expectedPerturbations.length; index += 1) {
    const expected = expectedPerturbations[index];
    const actual = actualPerturbations[index];
    if (actual?.label !== expected.label) throw new Error(`V4 Shadow robustness perturbation order mismatch at ${index}`);
    if (hashObject(actual.parameters) !== expected.parameterHash || actual.result?.strategyHash !== expected.parameterHash) {
      throw new Error(`V4 Shadow robustness perturbation hash mismatch: ${expected.label}`);
    }
    if (actual.result?.executable !== true) throw new Error(`V4 Shadow perturbation is not executable: ${expected.label}`);
    assertMetricBinding(expected.metrics, actual.result, expected.label);
  }

  const execution = selection.report.replayContract;
  const portfolio = report.executionContract?.portfolio;
  if (Number(report.executionContract?.eventStride) !== Number(execution?.eventStride)
    || Number(report.executionContract?.baseExecutionDelayBars) !== Number(execution?.executionDelayBars)
    || report.executionContract?.forceCloseAtEnd !== (execution?.forceCloseAtDevelopmentEnd === true)
    || Number(portfolio?.maxOpenPositions) !== Number(execution?.portfolio?.maxOpenPositions)
    || portfolio?.positionMode !== execution?.portfolio?.positionMode
    || Boolean(portfolio?.allowPyramiding) !== Boolean(execution?.portfolio?.allowPyramiding)) {
    throw new Error("V4 Shadow robustness execution contract does not match selection");
  }

  const recomputed = recomputeRobustnessGate(report);
  const expectedBlockers = ["DELAYED_EXECUTION_EVIDENCE_UNAVAILABLE"];
  if (recomputed.status !== "partial" || recomputed.failureReasons.length !== 0
    || hashObject(recomputed.blockedReasons) !== hashObject(expectedBlockers)) {
    throw new Error(`V4 Shadow numerical robustness did not pass: ${recomputed.gateReasons.join(", ") || "unknown"}`);
  }
  if (report.status !== recomputed.status
    || hashObject(report.gate?.failureReasons ?? []) !== hashObject(recomputed.failureReasons)
    || hashObject(report.gate?.blockedReasons ?? []) !== hashObject(recomputed.blockedReasons)) {
    throw new Error("V4 Shadow robustness gate summary does not match recomputed evidence");
  }
  if (report.delayedExecutionEvidence?.available !== false
    || report.delayedExecutionEvidence?.safetyRejectionExpected !== true) {
    throw new Error("V4 Shadow delayed-execution blocker is not the expected 15m-history limitation");
  }
  return {
    report,
    robustnessHash: hashObject(report),
    numericalGatesPassed: true,
    pendingEvidence: expectedBlockers,
    warnings: recomputed.warnings
  };
}

function activeConfigHash(config) {
  return hashObject({ ...config, configHash: undefined });
}

export function verifyBreakoutV4ActiveShadowConfiguration(config, {
  productionDatabasePath = PAPER_CONFIG.databasePath
} = {}) {
  if (!config || config.strategyType !== "breakout-v4") throw new Error("Active Shadow is not breakout-v4");
  if (config.paperOnly !== true || config.safety?.exchangeWrites !== false || config.championChanged !== false) {
    throw new Error("Breakout V4 Shadow safety boundary is invalid");
  }
  if (!config.parameters?.researchOnly || hashObject(config.parameters) !== config.strategyHash) {
    throw new Error("Breakout V4 Shadow parameter hash verification failed");
  }
  if (!config.configHash || config.configHash !== activeConfigHash(config)) {
    throw new Error("Breakout V4 Shadow configHash verification failed");
  }
  if (!config.databasePath || resolve(config.databasePath) === resolve(productionDatabasePath)) {
    throw new Error("Breakout V4 Shadow database must be independent from production Paper");
  }
  return config;
}

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function activateBreakoutV4Shadow({
  selection,
  robustnessReport,
  selectionPath,
  robustnessPath,
  activeConfigPath = resolveResearchPath("active-shadow-strategy.json"),
  databasePath = null,
  replaceActive = false,
  now = new Date().toISOString()
} = {}) {
  const robustness = verifyBreakoutV4RobustnessForShadow(selection, robustnessReport);
  const resolvedDatabasePath = resolve(databasePath ?? join(
    dirname(PAPER_CONFIG.databasePath),
    "shadow",
    `breakout-v4-${selection.parameterHash.slice(0, 16)}-${selection.selectionHash.slice(0, 12)}.sqlite`
  ));
  if (resolvedDatabasePath === resolve(PAPER_CONFIG.databasePath)) {
    throw new Error("Breakout V4 Shadow database cannot equal production PAPER_DB_PATH");
  }

  const existing = await readJson(activeConfigPath);
  const sameActivation = existing?.strategyType === "breakout-v4"
    && existing.strategyHash === selection.parameterHash
    && existing.selectionHash === selection.selectionHash
    && existing.robustnessHash === robustness.robustnessHash;
  if (sameActivation) {
    verifyBreakoutV4ActiveShadowConfiguration(existing);
    return { activated: false, idempotent: true, replaced: false, activeConfigPath, config: existing, archivedConfigPath: null };
  }
  if (existing && !replaceActive) {
    throw new Error(`Another Shadow configuration is already active (${existing.strategyType ?? "unknown"}/${existing.strategyHash ?? "no-hash"}); pass --replace-active=true to archive and replace it`);
  }
  if (await exists(resolvedDatabasePath)) {
    throw new Error(`Refusing to attach a new V4 Shadow activation to an existing database: ${resolvedDatabasePath}`);
  }

  let archivedConfigPath = null;
  if (existing) {
    archivedConfigPath = resolveResearchPath(
      "shadow",
      "config-archive",
      `active-shadow-${String(existing.strategyHash ?? "unknown").slice(0, 16)}-${now.replace(/[:.]/g, "-")}.json`
    );
    await writeJsonAtomic(archivedConfigPath, existing);
  }

  const config = {
    schemaVersion: 3,
    activatedAt: now,
    status: "SHADOW_RESEARCH_ONLY_COLLECTING",
    paperOnly: true,
    strategyType: "breakout-v4",
    version: selection.parameters.version,
    strategyHash: selection.parameterHash,
    parameters: selection.parameters,
    databasePath: resolvedDatabasePath,
    selectionPath: resolve(String(selectionPath)),
    selectionHash: selection.selectionHash,
    robustnessPath: resolve(String(robustnessPath)),
    robustnessHash: robustness.robustnessHash,
    robustnessStatusAtActivation: robustness.report.status,
    numericalRobustnessPassed: true,
    pendingEvidence: robustness.pendingEvidence,
    developmentDatasetManifestHash: selection.datasetManifestHash,
    shadowPolicy: BREAKOUT_V4_SHADOW_POLICY,
    newPositionsAllowed: true,
    championChanged: false,
    automaticPromotion: false,
    safety: {
      paperOnly: true,
      exchangeCredentialsRequired: false,
      htxPrivateApi: false,
      exchangeWrites: false,
      productionDatabaseWrites: false
    }
  };
  config.configHash = activeConfigHash(config);
  verifyBreakoutV4ActiveShadowConfiguration(config);
  await mkdir(dirname(resolvedDatabasePath), { recursive: true });
  await writeJsonAtomic(activeConfigPath, config);
  return { activated: true, idempotent: false, replaced: Boolean(existing), activeConfigPath, config, archivedConfigPath };
}

export function evaluateBreakoutV4ShadowEvidence({
  config,
  snapshots = [],
  performance = null,
  policy = config?.shadowPolicy ?? BREAKOUT_V4_SHADOW_POLICY
} = {}) {
  const first = snapshots[0]?.captured_at ?? null;
  const last = snapshots.at(-1)?.captured_at ?? null;
  const calendarDays = first && last ? Math.max(0, (new Date(last) - new Date(first)) / 86_400_000) : 0;
  const directionalBySignal = new Map();
  for (const snapshot of snapshots) {
    if (!["LONG", "SHORT"].includes(snapshot.decision)) continue;
    const key = snapshot.report?.entryAssessment?.signalKey ?? `snapshot:${snapshot.id}`;
    if (!directionalBySignal.has(key)) directionalBySignal.set(key, snapshot);
  }
  const directional = [...directionalBySignal.values()];
  const timing = directional.map((item) => Number(item.report?.execution?.signalAgeMs));
  const timingObserved = timing.filter(Number.isFinite);
  const missingTimingRate = directional.length ? (directional.length - timingObserved.length) / directional.length : 0;
  const staleTimingSignals = timingObserved.filter((age) => age < 0 || age > policy.maximumSignalAgeMs).length;
  const reasons = [];
  if (calendarDays < policy.minimumCalendarDays) reasons.push(`SHADOW_CALENDAR_DAYS_BELOW_${policy.minimumCalendarDays}`);
  if (directional.length < policy.minimumDirectionalSignals) reasons.push(`SHADOW_DIRECTIONAL_SIGNALS_BELOW_${policy.minimumDirectionalSignals}`);
  if (missingTimingRate > policy.maximumMissingTimingRate) reasons.push("SHADOW_TIMING_MISSING_RATE_EXCEEDED");
  if (staleTimingSignals > 0) reasons.push("SHADOW_SIGNAL_AGE_EXCEEDED");
  if (!(Number(performance?.cumulativeReturnPct) > policy.minimumNetReturnPct)) reasons.push("SHADOW_NET_RETURN_NOT_POSITIVE");
  if (!(Number(performance?.profitFactor) >= policy.minimumProfitFactor)) reasons.push("SHADOW_PROFIT_FACTOR_BELOW_MINIMUM");
  return {
    status: reasons.length ? "COLLECTING" : "ELIGIBLE_FOR_EXPLICIT_PROMOTION_REVIEW",
    reasons,
    calendarDays: round(calendarDays, 4),
    snapshots: snapshots.length,
    directionalSignals: directional.length,
    timingObservedSignals: timingObserved.length,
    missingTimingRate: round(missingTimingRate, 6),
    staleTimingSignals,
    maximumObservedSignalAgeMs: timingObserved.length ? Math.max(...timingObserved) : null,
    performance,
    paperOnly: config?.paperOnly === true,
    championChanged: config?.championChanged ?? null,
    automaticPromotion: false,
    policy
  };
}

export function inspectBreakoutV4Shadow({
  activeConfigPath = resolveResearchPath("active-shadow-strategy.json")
} = {}) {
  if (!existsSync(activeConfigPath)) return { available: false, reason: "NO_ACTIVE_SHADOW", activeConfigPath };
  try {
    const config = JSON.parse(readFileSync(activeConfigPath, "utf8"));
    if (config.strategyType !== "breakout-v4") {
      if (config.strategyType !== "v12-v4-fusion") {
        return { available: true, strategyType: config.strategyType ?? "unknown", config, evidence: null, activeConfigPath };
      }
      verifyV12V4FusionActiveShadowConfiguration(config);
      if (!existsSync(config.databasePath)) {
        return {
          available: true,
          strategyType: config.strategyType,
          config,
          evidence: evaluateV12V4FusionShadowEvidence({ config, snapshots: [], performance: null }),
          databaseAvailable: false,
          activeConfigPath
        };
      }
      const fusionDb = openPaperDatabase(config.databasePath, undefined, { readOnly: true });
      try {
        const snapshots = fusionDb.getSnapshots();
        const performance = calculatePerformance(fusionDb);
        return {
          available: true,
          strategyType: config.strategyType,
          config,
          evidence: evaluateV12V4FusionShadowEvidence({ config, snapshots, performance }),
          databaseAvailable: true,
          activeConfigPath
        };
      } finally {
        fusionDb.close();
      }
    }
    verifyBreakoutV4ActiveShadowConfiguration(config);
    if (!existsSync(config.databasePath)) {
      return {
        available: true,
        strategyType: config.strategyType,
        config,
        evidence: evaluateBreakoutV4ShadowEvidence({ config, snapshots: [], performance: null }),
        databaseAvailable: false,
        activeConfigPath
      };
    }
    const db = openPaperDatabase(config.databasePath, undefined, { readOnly: true });
    try {
      const snapshots = db.getSnapshots();
      const performance = calculatePerformance(db);
      return {
        available: true,
        strategyType: config.strategyType,
        config,
        evidence: evaluateBreakoutV4ShadowEvidence({ config, snapshots, performance }),
        databaseAvailable: true,
        activeConfigPath
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { available: false, reason: "INVALID_ACTIVE_SHADOW", error: error.message, activeConfigPath };
  }
}
