import { PAPER_CONFIG } from "./config.mjs";
import { analyzeSnapshot } from "./analysis-engine.mjs";
import { analyzeBreakoutChallenger, BREAKOUT_V4_PARAMETERS } from "./breakout-challenger.mjs";
import { hashObject, readJson, resolveResearchPath, round, writeJsonAtomic } from "./research-utils.mjs";
import { access, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

/**
 * One decision stream built from the frozen V1.2 evidence and the V4
 * higher-timeframe structure.  This is a research candidate: it never
 * changes the frozen Champion and it produces one report/one position only.
 */
export const V12_V4_FUSION_PARAMETERS = Object.freeze({
  version: "v1.2-v4-fusion-v2",
  baseStrategy: "V1.2",
  structureStrategy: "breakout-v4",
  v4Parameters: Object.freeze({
    ...BREAKOUT_V4_PARAMETERS,
    breakoutLookback4h: 80,
    trendFilter: "EMA50_PRICE_ALIGNMENT",
    stopAtrMultiple: 1.5,
    targetRiskMultiple: 4
  }),
  policy: "V1.2_OR_V4_ENTRY_WITH_UNIFIED_RISK_GATE",
  useV4BracketOnConfirmedBreakout: true,
  researchOnly: true
});

export function verifyV12V4FusionActiveShadowConfiguration(config, {
  productionDatabasePath = PAPER_CONFIG.databasePath
} = {}) {
  if (!config || config.strategyType !== "v12-v4-fusion") throw new Error("Active Shadow is not v12-v4-fusion");
  if (config.paperOnly !== true || config.safety?.exchangeWrites !== false || config.championChanged !== false) {
    throw new Error("V1.2 + V4 Fusion Shadow safety boundary is invalid");
  }
  if (!config.parameters?.researchOnly || hashObject(config.parameters) !== config.strategyHash) {
    throw new Error("V1.2 + V4 Fusion Shadow parameter hash verification failed");
  }
  const expectedConfigHash = hashObject({ ...config, configHash: undefined });
  if (!config.configHash || config.configHash !== expectedConfigHash) {
    throw new Error("V1.2 + V4 Fusion Shadow configHash verification failed");
  }
  if (!config.databasePath || resolve(config.databasePath) === resolve(productionDatabasePath)) {
    throw new Error("V1.2 + V4 Fusion Shadow database must be independent from production Paper");
  }
  return config;
}

export const V12_V4_FUSION_SHADOW_POLICY = Object.freeze({
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

function activeConfigHash(config) {
  return hashObject({ ...config, configHash: undefined });
}

async function fileExists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function activateV12V4FusionShadow({
  replay,
  replayPath,
  robustnessReport,
  robustnessPath,
  activeConfigPath = resolveResearchPath("active-shadow-strategy.json"),
  databasePath = null,
  replaceActive = false,
  now = new Date().toISOString()
} = {}) {
  if (!replay || replay.strategy !== "v12-v4-fusion") throw new Error("Fusion Shadow requires a v12-v4-fusion historical replay");
  if (replay.strategyHash !== hashObject(V12_V4_FUSION_PARAMETERS)) throw new Error("Fusion replay parameters are not the committed research candidate");
  if (!robustnessReport || robustnessReport.runType !== "MONTE_CARLO_AND_REPLAY_ROBUSTNESS") throw new Error("--robustness must point to a complete fusion robustness report");
  if (robustnessReport.base?.strategyHash !== replay.strategyHash || robustnessReport.gate?.passed !== true) {
    throw new Error("Fusion robustness gate has not passed for the replay candidate");
  }
  const resolvedDatabasePath = resolve(databasePath ?? join(
    dirname(PAPER_CONFIG.databasePath),
    "shadow",
    `v12-v4-fusion-${replay.strategyHash.slice(0, 16)}-${hashObject(robustnessReport).slice(0, 12)}.sqlite`
  ));
  if (resolvedDatabasePath === resolve(PAPER_CONFIG.databasePath)) throw new Error("Fusion Shadow database cannot equal production Paper");
  const existing = await readJson(activeConfigPath);
  const sameActivation = existing?.strategyType === "v12-v4-fusion"
    && existing.strategyHash === replay.strategyHash
    && existing.robustnessHash === hashObject(robustnessReport);
  if (sameActivation) {
    verifyV12V4FusionActiveShadowConfiguration(existing);
    return { activated: false, idempotent: true, replaced: false, activeConfigPath, config: existing, archivedConfigPath: null };
  }
  if (existing && !replaceActive) throw new Error(`Another Shadow configuration is already active (${existing.strategyType ?? "unknown"}/${existing.strategyHash ?? "no-hash"}); pass --replace-active=true to archive and replace it`);
  if (await fileExists(resolvedDatabasePath)) throw new Error(`Refusing to attach Fusion Shadow to an existing database: ${resolvedDatabasePath}`);
  let archivedConfigPath = null;
  if (existing) {
    archivedConfigPath = resolveResearchPath("shadow", "config-archive", `active-shadow-${String(existing.strategyHash ?? "unknown").slice(0, 16)}-${now.replace(/[:.]/g, "-")}.json`);
    await writeJsonAtomic(archivedConfigPath, existing);
  }
  const config = {
    schemaVersion: 3,
    activatedAt: now,
    status: "SHADOW_RESEARCH_ONLY_COLLECTING",
    paperOnly: true,
    strategyType: "v12-v4-fusion",
    version: V12_V4_FUSION_PARAMETERS.version,
    strategyHash: replay.strategyHash,
    parameters: V12_V4_FUSION_PARAMETERS,
    databasePath: resolvedDatabasePath,
    replayPath: resolve(String(replayPath)),
    replayHash: hashObject(replay),
    robustnessPath: resolve(String(robustnessPath)),
    robustnessHash: hashObject(robustnessReport),
    robustnessStatusAtActivation: robustnessReport.status,
    numericalRobustnessPassed: true,
    pendingEvidence: [],
    developmentDatasetManifestHash: replay.dataManifestHash ?? null,
    shadowPolicy: V12_V4_FUSION_SHADOW_POLICY,
    newPositionsAllowed: true,
    championChanged: false,
    automaticPromotion: false,
    safety: { paperOnly: true, exchangeCredentialsRequired: false, htxPrivateApi: false, exchangeWrites: false, productionDatabaseWrites: false }
  };
  config.configHash = activeConfigHash(config);
  verifyV12V4FusionActiveShadowConfiguration(config);
  await mkdir(dirname(resolvedDatabasePath), { recursive: true });
  await writeJsonAtomic(activeConfigPath, config);
  return { activated: true, idempotent: false, replaced: Boolean(existing), activeConfigPath, config, archivedConfigPath };
}

export function evaluateV12V4FusionShadowEvidence({
  config,
  snapshots = [],
  performance = null,
  policy = config?.shadowPolicy ?? V12_V4_FUSION_SHADOW_POLICY
} = {}) {
  const first = snapshots[0]?.captured_at ?? null;
  const last = snapshots.at(-1)?.captured_at ?? null;
  const calendarDays = first && last ? Math.max(0, (new Date(last) - new Date(first)) / 86_400_000) : 0;
  const directional = snapshots.filter((item) => ["LONG", "SHORT"].includes(item.decision));
  const timing = directional.map((item) => Number(item.report?.execution?.signalAgeMs)).filter(Number.isFinite);
  const reasons = [];
  if (calendarDays < policy.minimumCalendarDays) reasons.push(`SHADOW_CALENDAR_DAYS_BELOW_${policy.minimumCalendarDays}`);
  if (directional.length < policy.minimumDirectionalSignals) reasons.push(`SHADOW_DIRECTIONAL_SIGNALS_BELOW_${policy.minimumDirectionalSignals}`);
  if (directional.length && (directional.length - timing.length) / directional.length > policy.maximumMissingTimingRate) reasons.push("SHADOW_TIMING_MISSING_RATE_EXCEEDED");
  if (timing.some((age) => age < 0 || age > policy.maximumSignalAgeMs)) reasons.push("SHADOW_SIGNAL_AGE_EXCEEDED");
  if (!(Number(performance?.cumulativeReturnPct) > policy.minimumNetReturnPct)) reasons.push("SHADOW_NET_RETURN_NOT_POSITIVE");
  if (!(Number(performance?.profitFactor) >= policy.minimumProfitFactor)) reasons.push("SHADOW_PROFIT_FACTOR_BELOW_MINIMUM");
  return {
    status: reasons.length ? "COLLECTING" : "ELIGIBLE_FOR_EXPLICIT_PROMOTION_REVIEW",
    reasons,
    calendarDays: round(calendarDays, 4),
    snapshots: snapshots.length,
    directionalSignals: directional.length,
    timingObservedSignals: timing.length,
    missingTimingRate: directional.length ? round((directional.length - timing.length) / directional.length, 6) : 0,
    staleTimingSignals: timing.filter((age) => age < 0 || age > policy.maximumSignalAgeMs).length,
    maximumObservedSignalAgeMs: timing.length ? Math.max(...timing) : null,
    performance,
    paperOnly: config?.paperOnly === true,
    championChanged: config?.championChanged ?? null,
    automaticPromotion: false,
    policy
  };
}

const SIDES = ["LONG", "SHORT"];

function emptyPlan() {
  return { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null };
}

function sideFromV4Trend(v4) {
  const long = v4?.breakout?.longTrend === true;
  const short = v4?.breakout?.shortTrend === true;
  return long === short ? "WAIT" : long ? "LONG" : "SHORT";
}

function fusionSignalKey(parameters, base, v4, decision, breakoutConfirmed) {
  if (!SIDES.includes(decision)) return null;
  if (breakoutConfirmed && v4?.entryAssessment?.signalKey) {
    return `${hashObject(parameters)}:${v4.entryAssessment.signalKey}`;
  }
  const timestamp = base?.completed15mBar?.timestamp ?? base?.latest15mBar?.timestamp ?? base?.generatedAt;
  return `${hashObject(parameters)}:BTC-USDT:15m:${timestamp}`;
}

function timing(base, now) {
  const timestamp = Number(now);
  return {
    contractVersion: "V12_V4_FUSION_OBSERVATION_V1",
    signalGeneratedAt: base?.generatedAt ?? null,
    executionTimestamp: Number.isFinite(timestamp) ? timestamp : null,
    entryBarTimestamp: base?.completed15mBar?.timestamp ?? base?.latest15mBar?.timestamp ?? null,
    fillReferencePrice: Number(base?.currentPrice) || null,
    fillReferenceSource: "CURRENT_PUBLIC_TICKER_OBSERVATION",
    signalAgeMs: 0,
    maximumSignalAgeMs: 5 * 60 * 1000,
    signalFresh: true,
    eligible: true
  };
}

function combinedOpportunity(base, v4, side, trendDirection, decision) {
  const baseOpportunity = base?.opportunities?.[side] ?? {};
  const v4Opportunity = v4?.opportunities?.[side] ?? {};
  const baseScore = Number(baseOpportunity.score ?? 0);
  const v4Score = Number(v4Opportunity.score ?? 0);
  const aligned = trendDirection === side;
  const score = round(baseScore * 0.7 + v4Score * 0.3 + (aligned ? 5 : -5), 2);
  return {
    ...baseOpportunity,
    side,
    score,
    opportunityScore: score,
    directionalScore: score,
    fusion: {
      v12Score: round(baseScore, 2),
      v4TrendScore: round(v4Score, 2),
      aligned,
      selected: decision === side
    },
    supportingReasons: [
      ...(baseOpportunity.supportingReasons ?? []),
      ...(aligned ? [`V4 4h 结构与${side === "LONG" ? "多头" : "空头"}方向一致`] : [])
    ],
    opposingReasons: [
      ...(baseOpportunity.opposingReasons ?? []),
      ...(!aligned ? [`V4 4h 结构未支持${side === "LONG" ? "多头" : "空头"}方向`] : [])
    ]
  };
}

function usableEntry(report) {
  return SIDES.includes(report?.decision)
    && report?.entryAssessment?.enterNow === true
    && report?.dataQuality?.validForEntry !== false
    && !(report?.dataQuality?.failures?.length);
}

/**
 * Pure report combiner.  Analyzer injection keeps the fusion policy testable
 * without fabricating an entire market dataset in every unit test.
 */
export function combineV12V4Reports(base, v4, parameters = V12_V4_FUSION_PARAMETERS, now = Date.now()) {
  const baseDecision = SIDES.includes(base?.decision) ? base.decision : "WAIT";
  const baseCandidate = usableEntry(base) ? baseDecision : "WAIT";
  const v4Candidate = usableEntry(v4) ? v4.decision : "WAIT";
  const trendDirection = sideFromV4Trend(v4);
  const dataFailures = [
    ...(base?.dataQuality?.failures ?? []),
    ...(v4?.dataQuality?.failures ?? [])
  ];
  const uniqueFailures = [...new Set(dataFailures)];
  const aligned = baseCandidate !== "WAIT" && v4Candidate === baseCandidate;
  const breakoutConfirmed = v4Candidate !== "WAIT" && v4?.entryAssessment?.enterNow === true;
  let decision = "WAIT";
  let decisionSource = "NONE";
  if (breakoutConfirmed) {
    decision = v4Candidate;
    decisionSource = "V4_CONFIRMED_BREAKOUT";
  } else if (baseCandidate !== "WAIT") {
    decision = baseCandidate;
    decisionSource = "V12_ENTRY";
  } else if (v4Candidate !== "WAIT") {
    decision = v4Candidate;
    decisionSource = "V4_ENTRY";
  }
  const selectedPlan = decision === "WAIT"
    ? emptyPlan()
    : decisionSource === "V4_CONFIRMED_BREAKOUT" && parameters.useV4BracketOnConfirmedBreakout
      ? v4.plan
      : decisionSource === "V4_ENTRY" ? v4.plan : base.plan;
  const signalKey = fusionSignalKey(parameters, base, v4, decision, breakoutConfirmed);
  const execution = timing(base, now);
  const selectedFailures = decisionSource.startsWith("V4")
    ? (v4?.dataQuality?.failures ?? [])
    : decisionSource === "V12_ENTRY"
      ? (base?.dataQuality?.failures ?? [])
      : uniqueFailures;
  const longOpportunity = combinedOpportunity(base, v4, "LONG", trendDirection, decision);
  const shortOpportunity = combinedOpportunity(base, v4, "SHORT", trendDirection, decision);
  const reasons = decision === "WAIT"
    ? [
        "V1.2 和 V4 当前都没有达到立即入场条件",
        `V1.2 当前方向：${baseCandidate}`,
        `V4 当前方向：${v4Candidate}; 4h 结构方向：${trendDirection}`
      ]
    : decisionSource === "V4_CONFIRMED_BREAKOUT"
      ? [
          `V4 ${decision} 确认突破，允许独立触发入场`,
          baseCandidate === decision ? `V1.2 也支持${decision === "LONG" ? "多头" : "空头"}` : `V1.2 当前方向：${baseCandidate}`,
          "采用 V4 硬止损/止盈框架"
        ]
      : decisionSource === "V12_ENTRY"
        ? [
            `V1.2 ${decision} 入场质量通过，允许独立触发入场`,
            v4Candidate === decision ? `V4 也支持${decision === "LONG" ? "多头" : "空头"}` : `V4 当前方向：${v4Candidate}`,
            "采用 V1.2 风险计划"
          ]
        : [
            `V4 ${decision} 入场条件通过，允许独立触发入场`,
            `V1.2 当前方向：${baseCandidate}`,
            "采用 V4 风险计划"
          ];
  const report = {
    ...base,
    version: parameters.version,
    mode: "V1.2_V4_FUSION_RESEARCH_PAPER_ONLY",
    strategyHash: hashObject(parameters),
    decision,
    candidateDecision: decision,
    confidencePct: decision === "WAIT" ? Math.min(85, Number(base?.confidencePct ?? 55)) : Number(base?.confidencePct ?? 55),
    finalScore: round(longOpportunity.score - shortOpportunity.score, 2),
    plan: selectedPlan ?? emptyPlan(),
    execution,
    entryTimingContract: {
      version: "V12_V4_FUSION_OBSERVATION_V1",
      signalClock: "COMPLETED_15M_OBSERVATION",
      executionClock: "CURRENT_PUBLIC_TICKER_OBSERVATION",
      maximumSignalAgeMs: execution.maximumSignalAgeMs
    },
    entryAssessment: {
      enterNow: decision !== "WAIT",
      method: decision === "WAIT" ? "WAIT_NO_VALID_COMPONENT_ENTRY" : decisionSource,
      methodLabel: reasons[0],
      reasons,
      missingConditions: decision === "WAIT" ? [...uniqueFailures, ...reasons] : [],
      riskPct: decision === "WAIT" ? 0 : Number(selectedPlan?.riskPct ?? base?.entryAssessment?.riskPct ?? 0),
      signalKey,
      signalBarTimestamp: base?.completed15mBar?.timestamp ?? null,
      signalBarClosedAt: base?.completed15mBar?.timestamp ?? null,
      executionTimestamp: decision === "WAIT" ? null : execution.executionTimestamp,
      entryBarTimestamp: decision === "WAIT" ? null : execution.entryBarTimestamp,
      fillReferencePrice: decision === "WAIT" ? null : execution.fillReferencePrice,
      fillReferenceSource: decision === "WAIT" ? null : execution.fillReferenceSource,
      signalAgeMs: execution.signalAgeMs,
      maximumSignalAgeMs: execution.maximumSignalAgeMs
    },
    opportunities: { LONG: longOpportunity, SHORT: shortOpportunity },
    strategy: {
      ...(base?.strategy ?? {}),
      version: parameters.version,
      bias: decision,
      state: decision === "WAIT" ? "WAIT" : "ENTER_NOW",
      hardBlocks: selectedFailures,
      softWarnings: reasons,
      entryMethod: decision === "WAIT" ? "WAIT_NO_VALID_COMPONENT_ENTRY" : decisionSource,
      positionManagementProfile: selectedPlan?.managementContract?.profile ?? null,
      managementContract: selectedPlan?.managementContract ?? null,
      fusionPolicy: parameters.policy,
      v12Decision: baseCandidate,
      v4Decision: v4Candidate,
      v4TrendDirection: trendDirection,
      v4BreakoutConfirmed: breakoutConfirmed,
      frozenChampionModified: false
    },
    scores: {
      ...(base?.scores ?? {}),
      longOpportunity: longOpportunity.score,
      shortOpportunity: shortOpportunity.score,
      scoreGap: round(Math.abs(longOpportunity.score - shortOpportunity.score), 2),
      fusion: { v12: base?.scores ?? null, v4: v4?.scores ?? null, trendDirection, aligned, breakoutConfirmed, decisionSource }
    },
    dataQuality: {
      validForEntry: decision !== "WAIT"
        ? (decisionSource.startsWith("V4") ? v4?.dataQuality?.validForEntry !== false : base?.dataQuality?.validForEntry !== false)
        : uniqueFailures.length === 0,
      failures: selectedFailures
    },
    fusion: {
      policy: parameters.policy,
      directionSource: "V12_OR_V4_ENTRY_WITH_UNIFIED_RISK_GATE",
      baseDecision,
      baseCandidate,
      v4Candidate,
      trendDirection,
      aligned,
      breakoutConfirmed,
      decisionSource,
      components: { v12: base, v4 }
    },
    safety: {
      apiKeyUsed: false,
      privateEndpointUsed: false,
      exchangeWriteEnabled: false,
      tradingModulePresent: false,
      paperTradingOnly: true,
      frozenChampionModified: false
    }
  };
  return report;
}

export function analyzeV12V4Fusion(market, parameters = V12_V4_FUSION_PARAMETERS, config = PAPER_CONFIG, dependencies = {}) {
  const base = (dependencies.analyzeBase ?? analyzeSnapshot)(market, config);
  const v4Parameters = {
    ...BREAKOUT_V4_PARAMETERS,
    ...(parameters.v4Parameters ?? {}),
    researchOnly: true
  };
  const v4 = (dependencies.analyzeStructure ?? analyzeBreakoutChallenger)(market, v4Parameters, config);
  return combineV12V4Reports(base, v4, parameters, Number(market.ticker?.ts));
}
