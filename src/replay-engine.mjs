import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { analyzeSnapshot } from "./analysis-engine.mjs";
import {
  analyzeChallenger,
  analyzeHistoricalCompatible,
  CHALLENGER_BASE_PARAMETERS,
  HISTORICAL_COMPATIBLE_PARAMETERS,
  hasChallengerFrameCache
} from "./challenger-strategy.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";
import {
  applyDueFunding,
  calculatePerformance,
  evaluatePaperEntry,
  evaluatePaperExit
} from "./paper-engine.mjs";
import { manageOpenPosition } from "./position-manager.mjs";
import { buildPointInTimeMarket, firstReplayableIndex } from "./replay-market.mjs";
import { BAR_MS, hashObject, mean, round, standardDeviation } from "./research-utils.mjs";
import { analyzeTradableEdge } from "./tradable-edge.mjs";
import { analyzeAntiChaseChallenger, ANTI_CHASE_PARAMETERS } from "./anti-chase-challenger.mjs";
import { analyzeResearchChallengerV2, RESEARCH_CHALLENGER_V2_PARAMETERS } from "./research-challenger-v2.mjs";
import { analyzeDataTiered, DATA_TIERED_PARAMETERS } from "./data-tiered-strategy.mjs";
import { analyzeMultiVenueChallenger, MULTI_VENUE_CHALLENGER_PARAMETERS } from "./multi-venue-challenger.mjs";
import {
  analyzeBreakoutChallenger,
  BREAKOUT_V4_PARAMETERS,
  resolveBreakoutV4Execution
} from "./breakout-challenger.mjs";

/**
 * 研究资金视角。两者必须分开报告，绝不能混为一谈：
 *
 *   PRODUCTION_FAITHFUL   使用真实 Paper 资金规模与真实合约步进，回答
 *                         「当前这个账户实际能执行出什么结果」。
 *   EDGE_REFERENCE_CAPITAL 使用足够大的参考资金，让仓位不再被最小合约步进量化主导，
 *                         回答「策略本身到底有没有 edge」。仅供研究，
 *                         绝不写入、也绝不改变生产 Paper 账户。
 */
export const CAPITAL_PROFILES = Object.freeze({
  PRODUCTION_FAITHFUL: "PRODUCTION_FAITHFUL",
  EDGE_REFERENCE_CAPITAL: "EDGE_REFERENCE_CAPITAL"
});

export const DEFAULT_REFERENCE_CAPITAL_CNY = 20_000;

export function resolveCapitalProfile(paperConfig, {
  capitalProfile = CAPITAL_PROFILES.PRODUCTION_FAITHFUL,
  referenceCapitalCny = DEFAULT_REFERENCE_CAPITAL_CNY
} = {}) {
  if (!Object.values(CAPITAL_PROFILES).includes(capitalProfile)) {
    throw new Error(`Unknown capital profile: ${capitalProfile}`);
  }
  if (capitalProfile === CAPITAL_PROFILES.PRODUCTION_FAITHFUL) {
    return {
      capitalProfile,
      researchOnly: false,
      initialCapitalCny: Number(paperConfig.initialCapitalCny),
      note: "使用真实 Paper 资金规模，结果代表当前账户实际可执行的收益"
    };
  }
  const capital = Number(referenceCapitalCny);
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("referenceCapitalCny must be a positive number");
  return {
    capitalProfile,
    researchOnly: true,
    initialCapitalCny: capital,
    note: "RESEARCH_ONLY：参考资金只用于判断策略 edge 是否存在，不代表当前账户收益，也不会影响生产 Paper 账户"
  };
}

const CONTRACT_STEP_CODES = new Set(["BELOW_MIN_CONTRACT_STEP"]);
const RISK_CODES = new Set(["RISK_BUDGET_ZERO", "RISK_BUDGET_EXCEEDED", "PORTFOLIO_RISK_BUDGET_EXHAUSTED"]);
const MARGIN_CODES = new Set([
  "MARGIN_CAP_BINDING",
  "LEVERAGE_CAP_BINDING",
  "PORTFOLIO_MARGIN_BUDGET_EXHAUSTED",
  "PORTFOLIO_NOTIONAL_BUDGET_EXHAUSTED"
]);

function summarizeEntryRejections(rejectionCounts) {
  const total = Object.values(rejectionCounts).reduce((sum, value) => sum + value, 0);
  const bucket = (codes) => Object.entries(rejectionCounts)
    .filter(([code]) => codes.has(code))
    .reduce((sum, [, value]) => sum + value, 0);
  return {
    total,
    byCode: { ...rejectionCounts },
    contractStepRejections: bucket(CONTRACT_STEP_CODES),
    riskRejections: bucket(RISK_CODES),
    marginRejections: bucket(MARGIN_CODES),
    netRrRejections: (rejectionCounts.NO_TARGET_MEETS_NET_RR ?? 0) + (rejectionCounts.NET_RR_BELOW_MINIMUM ?? 0),
    liquidationBufferRejections: (rejectionCounts.STOP_BEYOND_LIQUIDATION_BUFFER ?? 0)
      + (rejectionCounts.PORTFOLIO_STOP_BEYOND_LIQUIDATION_BUFFER ?? 0)
  };
}

/**
 * 回放支持的策略 id。`data-tiered` 就是实时 monitor 在 dataPolicyMode=TIERED_DEGRADED
 * 时使用的同一个 V1.3 候选：两边都走 analyzeDataTiered → applyTieredDataPolicy，
 * 没有第二份行为实现。
 */
export const REPLAY_STRATEGIES = Object.freeze([
  "champion", "challenger", "historical-compatible",
  "tradable-edge", "anti-chase", "research-v2", "data-tiered", "multi-venue-v3", "breakout-v4"
]);

export const REPLAY_ASSUMPTIONS = Object.freeze({
  signalClock: "decision at completed 15m candle close",
  executionDelayBars: 1,
  entryClock: "next 15m candle open",
  costs: "same PAPER_CONFIG fee and adverse slippage functions as live Paper",
  funding: "timestamped HTX historical Funding only; no forward-fill",
  intrabarPriority: "same bar SL and TP resolves to SL first",
  unavailableHistory: "order book/OI/elite/liquidation/basis are null, never synthesized"
});

/**
 * 记录本次回放实际生效的组合限制。
 *
 * NET 模式下关闭加仓会把 maxOpenPositions 强制成 1（见 runtime-settings.mjs），
 * 这一条不写进报告，就没人能解释「为什么两年只有二十几笔」。
 */
/**
 * 让回放能按真实账户的组合限制重跑。
 *
 * 默认（portfolio 为 null）不写任何设置，行为与既有回放逐字节一致，
 * 所有已记录的研究数字因此保持可复现。只有显式传入时才改写。
 *
 * 存在的理由：实盘账户可能开着加仓、仓位上限是 4，而回放默认是单槽位。
 * 两者不一致时，回放测出来的成交笔数和风险暴露都描述不了那个账户。
 */
function applyPortfolioOverride(db, portfolio) {
  if (!portfolio) return;
  const patch = {};
  if (portfolio.positionMode !== undefined) patch.positionMode = String(portfolio.positionMode).toUpperCase();
  if (portfolio.allowPyramiding !== undefined) patch.allowPyramiding = portfolio.allowPyramiding === true;
  if (portfolio.maxOpenPositions !== undefined) {
    const limit = Math.trunc(Number(portfolio.maxOpenPositions));
    if (!Number.isFinite(limit) || limit < 1) throw new Error("maxOpenPositions 必须是不小于 1 的整数");
    // 用 MANUAL 固定住，否则 AUTO 会按当轮暴露重新推导，回放就不可复现。
    patch.positionLimitMode = "MANUAL";
    patch.positionLimitManual = limit;
  }
  if (!Object.keys(patch).length) return;
  db.updateRuntimeSettings(patch, { source: "HISTORICAL_REPLAY_PORTFOLIO_OVERRIDE" });
  const applied = db.getRuntimeSettings();
  if (portfolio.maxOpenPositions !== undefined
    && Number(applied.maxOpenPositions) !== Math.trunc(Number(portfolio.maxOpenPositions))) {
    // NET + 关闭加仓会把上限强制回 1。与其安静地按 1 跑完再交出一份
    // 看不出所以然的报告，不如直接报错说明冲突。
    throw new Error(
      `请求的仓位上限 ${portfolio.maxOpenPositions} 未生效（实际 ${applied.maxOpenPositions}）：`
      + `NET 模式下必须同时开启加仓，或改用 HEDGE 模式`
    );
  }
}

function portfolioLimitsInForce(db) {
  const settings = db.getRuntimeSettings();
  const maxOpenPositions = Number(settings.maxOpenPositions);
  const forcedToSingleSlot = maxOpenPositions === 1
    && settings.positionMode === "NET"
    && settings.allowPyramiding !== true;
  return {
    maxOpenPositions,
    positionMode: settings.positionMode,
    allowPyramiding: settings.allowPyramiding === true,
    forcedToSingleSlot,
    note: forcedToSingleSlot
      ? "NET 模式且未开启加仓：同一时间只能持有一个仓位，持仓期间的新信号会被直接丢弃，成交笔数因此受设置限制而非行情限制"
      : `同一时间最多 ${maxOpenPositions} 个仓位`,
    matchesLiveAccount: "UNKNOWN_REPLAY_USES_PAPER_CONFIG_DEFAULTS_NOT_THE_LIVE_ACCOUNT_SETTINGS"
  };
}

function clone(value) { return structuredClone(value); }

function executionReport(signal, candle, delayBars) {
  const report = clone(signal);
  const oldEntry = Number(signal.currentPrice);
  const newEntry = Number(candle.open);
  const signalGeneratedAtMs = new Date(signal.generatedAt).getTime();
  report.generatedAt = new Date(candle.timestamp).toISOString();
  report.currentPrice = newEntry;
  report.execution = {
    signalGeneratedAt: signal.generatedAt,
    signalPrice: oldEntry,
    fillReferencePrice: newEntry,
    delayBars,
    delayMs: Number.isFinite(signalGeneratedAtMs) ? candle.timestamp - signalGeneratedAtMs : null
  };
  if (signal.version === BREAKOUT_V4_PARAMETERS.version) {
    report.execution = {
      ...report.execution,
      ...resolveBreakoutV4Execution({
        signalBarClosedAt: signal.entryAssessment?.signalBarClosedAt,
        observationTimestamp: candle.timestamp,
        fillReferencePrice: newEntry,
        observationSource: "REPLAY_NEXT_15M_OPEN"
      })
    };
    report.entryAssessment = {
      ...report.entryAssessment,
      executionTimestamp: report.execution.executionTimestamp,
      entryBarTimestamp: report.execution.entryBarTimestamp,
      fillReferencePrice: report.execution.fillReferencePrice,
      fillReferenceSource: report.execution.fillReferenceSource,
      signalAgeMs: report.execution.signalAgeMs,
      maximumSignalAgeMs: report.execution.maximumSignalAgeMs
    };
  }
  if (report.plan && Number.isFinite(Number(report.plan.stopLoss))) {
    report.plan.entryPrice = newEntry;
    if (report.strategy?.positionManagementProfile === "HARD_BRACKET_HOLD_V1") {
      const direction = signal.decision === "LONG" ? 1 : -1;
      const riskDistance = Number(signal.plan.initialRiskDistance ?? Math.abs(oldEntry - Number(signal.plan.stopLoss)));
      const targetR = Number(signal.plan.riskReward?.[0]);
      report.plan.stopLoss = round(newEntry - direction * riskDistance, 2);
      report.plan.takeProfit = [round(newEntry + direction * riskDistance * targetR, 2)];
      report.plan.executionReanchored = true;
    }
  }
  report.latest15mBar = {
    timestamp: candle.timestamp - 1,
    open: newEntry, high: newEntry, low: newEntry, close: newEntry
  };
  return report;
}

function closePosition(db, position, exit, actions) {
  const closed = db.closePosition(position.id, exit);
  actions.push({ type: "CLOSE", position: closed, exit });
  return closed;
}

function managePositions(db, report, actions, config) {
  for (const original of db.getOpenPositions()) {
    const funding = applyDueFunding(db, original, report);
    let position = funding.position;
    if (funding.settlements.length) actions.push({ type: "FUNDING", positionId: position.id, settlements: funding.settlements });
    if (funding.skipped) actions.push({ type: "FUNDING_SKIPPED", positionId: position.id, reason: funding.skipped });
    const hardExit = evaluatePaperExit(position, report, config, { checkStop: true, checkTarget: false });
    if (hardExit) {
      closePosition(db, position, hardExit, actions);
      continue;
    }
    const management = manageOpenPosition(position, report, config);
    if (management.action === "EXIT") {
      const exit = evaluatePaperExit(position, report, config, {
        checkStop: false,
        checkTarget: false,
        forcedReason: management.exitReason,
        managementReason: management.reason
      });
      closePosition(db, position, exit, actions);
      continue;
    }
    if (management.action === "UPDATE") {
      position = db.updatePositionManagement(position.id, management);
      actions.push({ type: "POSITION_MANAGED", position, management });
    }
    const targetExit = evaluatePaperExit(position, report, config, { checkStop: false, checkTarget: true });
    if (targetExit) closePosition(db, position, targetExit, actions);
  }
}

function executePending(db, signal, candle, market, actions, config, delayBars, rejectionCounts) {
  if (!signal || !["LONG", "SHORT"].includes(signal.decision)) return null;
  const report = executionReport(signal, candle, delayBars);
  if (signal.version === BREAKOUT_V4_PARAMETERS.version && !report.execution.signalFresh) {
    rejectionCounts.SIGNAL_TOO_OLD = (rejectionCounts.SIGNAL_TOO_OLD ?? 0) + 1;
    actions.push({
      type: "DELAYED_ENTRY_REJECTED",
      reasons: ["Breakout V4 signal exceeded its maximum execution age"],
      reasonCodes: ["SIGNAL_TOO_OLD"],
      signalAt: signal.generatedAt,
      executionTimestamp: report.execution.executionTimestamp,
      signalAgeMs: report.execution.signalAgeMs,
      maximumSignalAgeMs: report.execution.maximumSignalAgeMs
    });
    return null;
  }
  const gate = evaluatePaperEntry(db, report, config, market);
  if (!gate.allowed) {
    // 每一种拒绝都单独计数，研究报告才能把「最小合约步进不够」和
    // 「风险/保证金上限」分开回答，而不是混成一句无法归因的话。
    for (const code of gate.reasonCodes) rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1;
    actions.push({
      type: "DELAYED_ENTRY_REJECTED",
      reasons: gate.reasons,
      reasonCodes: gate.reasonCodes,
      sizingRejection: gate.sizingRejection,
      signalAt: signal.generatedAt
    });
    return null;
  }
  const snapshotId = db.insertSnapshot(report);
  gate.candidate.entryBarTs = Number(report.execution?.entryBarTimestamp ?? candle.timestamp - 1);
  gate.candidate.openedAt = new Date(Number(report.execution?.executionTimestamp ?? candle.timestamp)).toISOString();
  const position = db.openPosition(gate.candidate, snapshotId, {
    settingsRevision: gate.settings.revision,
    settingsUpdatedAt: gate.settings.updatedAt
  });
  actions.push({ type: "OPEN", position, candidate: gate.candidate, delayedFrom: signal.generatedAt });
  return position;
}

function buildReport(strategy, market, parameters, config) {
  const report = strategy === "champion"
    ? analyzeSnapshot(market, config)
    : strategy === "data-tiered"
      ? analyzeDataTiered(market, parameters, config)
    : strategy === "historical-compatible"
      ? analyzeHistoricalCompatible(market, parameters, config)
      : strategy === "tradable-edge"
        ? analyzeTradableEdge(market, parameters, config)
      : strategy === "anti-chase"
          ? analyzeAntiChaseChallenger(market, parameters, config)
      : strategy === "research-v2"
          ? analyzeResearchChallengerV2(market, parameters, config, { useCache: false })
        : strategy === "multi-venue-v3"
          ? analyzeMultiVenueChallenger(market, parameters, config)
        : strategy === "breakout-v4"
          ? analyzeBreakoutChallenger(market, parameters, config)
      : analyzeChallenger(market, parameters, config);
  const candle = market.replay.eventCandle;
  report.latest15mBar = {
    timestamp: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close
  };
  report.completed15mBar = { ...report.latest15mBar, volumeRatio: report.completed15mBar?.volumeRatio ?? null };
  report.replay = {
    pointInTime: true,
    visibleAt: new Date(market.replay.visibleAt).toISOString(),
    closedCounts: market.replay.closedCounts,
    unavailableSources: market.replay.unavailableSources
  };
  report.derivatives.fundingSource = market.fundingCurrent?.data?.source ?? "UNAVAILABLE_NO_BACKFILL";
  report.derivatives.fundingObservationAgeMs = Number(market.fundingCurrent?.data?.age_ms ?? 0);
  return report;
}

function summarizeDecisions(trace) {
  const counts = { LONG: 0, SHORT: 0, WAIT: 0 };
  const candidateCounts = { LONG: 0, SHORT: 0, WAIT: 0 };
  for (const item of trace) {
    counts[item.decision] += 1;
    candidateCounts[item.candidateDecision] += 1;
  }
  return { counts, candidateCounts };
}

function maximumConsecutiveLosses(trades) {
  let current = 0;
  let maximum = 0;
  for (const trade of trades) {
    current = Number(trade.net_pnl_cny) < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function enrichPerformance(db, trace) {
  const base = calculatePerformance(db);
  const trades = db.getClosedPositions();
  const tradeReturns = trades.map((trade) => Number(trade.net_pnl_cny) / Number(trade.account_equity_cny)).filter(Number.isFinite);
  const average = mean(tradeReturns) ?? 0;
  const deviation = standardDeviation(tradeReturns);
  const snapshots = new Map(db.getSnapshots().map((item) => [item.id, item.report]));
  const regimes = {};
  for (const trade of trades) {
    const regime = snapshots.get(trade.snapshot_id)?.strategy?.marketRegime ?? "UNKNOWN";
    regimes[regime] ??= { trades: 0, wins: 0, netPnlCny: 0, grossPnlCny: 0, costsCny: 0 };
    regimes[regime].trades += 1;
    regimes[regime].wins += Number(trade.net_pnl_cny) > 0 ? 1 : 0;
    regimes[regime].netPnlCny += Number(trade.net_pnl_cny);
    regimes[regime].grossPnlCny += Number(trade.gross_pnl_cny);
    regimes[regime].costsCny += Number(trade.entry_fee_cny) + Number(trade.exit_fee_cny) + Number(trade.entry_slippage_cny) + Number(trade.exit_slippage_cny) - Number(trade.funding_cny);
  }
  for (const value of Object.values(regimes)) {
    value.winRatePct = value.trades ? round(value.wins / value.trades * 100, 2) : 0;
    value.netPnlCny = round(value.netPnlCny, 4);
    value.grossPnlCny = round(value.grossPnlCny, 4);
    value.costsCny = round(value.costsCny, 4);
  }
  return {
    ...base,
    tradeSharpe: deviation > 0 ? round(average / deviation * Math.sqrt(tradeReturns.length), 4) : null,
    maximumConsecutiveLosses: maximumConsecutiveLosses(trades),
    decisions: summarizeDecisions(trace),
    byEntryRegime: regimes
  };
}

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function tradePathContext(db, dataset, trades) {
  const snapshots = new Map(db.getSnapshots().map((item) => [item.id, item.report]));
  return trades.map((trade) => {
    const entryReport = snapshots.get(trade.snapshot_id) ?? {};
    const openedAt = new Date(trade.opened_at).getTime();
    const closedAt = new Date(trade.closed_at).getTime();
    const start = lowerBound(dataset.candles, openedAt);
    const end = lowerBound(dataset.candles, closedAt);
    const path = dataset.candles.slice(start, Math.max(start + 1, end));
    const entry = Number(trade.entry_price);
    const side = trade.side;
    const highs = path.map((item) => Number(item.high)).filter(Number.isFinite);
    const lows = path.map((item) => Number(item.low)).filter(Number.isFinite);
    const maximumHigh = highs.length ? Math.max(...highs) : entry;
    const minimumLow = lows.length ? Math.min(...lows) : entry;
    const mfePct = side === "LONG"
      ? (maximumHigh / entry - 1) * 100
      : (entry / minimumLow - 1) * 100;
    const maePct = side === "LONG"
      ? (minimumLow / entry - 1) * 100
      : (entry / maximumHigh - 1) * 100;
    const feesCny = Number(trade.entry_fee_cny ?? 0) + Number(trade.exit_fee_cny ?? 0);
    const slippageCny = Number(trade.entry_slippage_cny ?? 0) + Number(trade.exit_slippage_cny ?? 0);
    const fundingCny = Number(trade.funding_cny ?? 0);
    const totalCostsCny = feesCny + slippageCny - fundingCny;
    const notionalCny = Number(trade.notional_cny);
    return {
      tradeId: trade.id,
      side,
      openedAt: trade.opened_at,
      closedAt: trade.closed_at,
      holdingMinutes: round((closedAt - openedAt) / 60_000, 2),
      entryType: entryReport.entryAssessment?.method ?? entryReport.strategy?.entryMethod ?? "UNKNOWN",
      exitType: trade.exit_reason ?? "UNKNOWN",
      marketRegime: entryReport.strategy?.marketRegime ?? "UNKNOWN",
      opportunityScore: Number(trade.opportunity_score ?? entryReport.opportunities?.[side]?.score ?? 0),
      featureSet: entryReport.featureSet ?? entryReport.strategy?.featureSet ?? "LEGACY_CHALLENGER",
      entryExtensionAtr: Number(entryReport.entryQuality?.extensionAtr),
      entryImpulseAtr: Number(entryReport.entryQuality?.impulseAtr),
      entryRangePositionPct: Number(entryReport.entryQuality?.rangePositionPct),
      entryNetRemainingRoomPct: Number(entryReport.entryQuality?.netRemainingRoomPct),
      entryPrice: entry,
      exitPrice: Number(trade.exit_price),
      notionalCny,
      grossPnlCny: round(Number(trade.gross_pnl_cny), 6),
      netPnlCny: round(Number(trade.net_pnl_cny), 6),
      grossEdgePct: notionalCny > 0 ? round(Number(trade.gross_pnl_cny) / notionalCny * 100, 6) : null,
      netEdgePct: notionalCny > 0 ? round(Number(trade.net_pnl_cny) / notionalCny * 100, 6) : null,
      feesCny: round(feesCny, 6),
      slippageCny: round(slippageCny, 6),
      fundingCny: round(fundingCny, 6),
      totalCostsCny: round(totalCostsCny, 6),
      costPctOfNotional: notionalCny > 0 ? round(totalCostsCny / notionalCny * 100, 6) : null,
      mfePct: round(Math.max(0, mfePct), 6),
      maePct: round(Math.min(0, maePct), 6),
      initialStopDistancePct: Number(trade.stop_distance_pct ?? 0),
      initialNetRr: Number(trade.net_rr ?? trade.rr ?? 0)
    };
  });
}

export async function runHistoricalReplay(dataset, {
  strategy = "challenger",
  parameters = CHALLENGER_BASE_PARAMETERS,
  from = dataset.manifest.requestedCoverage.from,
  to = dataset.manifest.requestedCoverage.to,
  outputDirectory,
  dbPath = null,
  eventStride = 1,
  executionDelayBars = 1,
  paperConfig = PAPER_CONFIG,
  collectTrace = true,
  forceCloseAtEnd = true,
  capitalProfile = CAPITAL_PROFILES.PRODUCTION_FAITHFUL,
  referenceCapitalCny = DEFAULT_REFERENCE_CAPITAL_CNY,
  // 留空即沿用 PAPER_CONFIG 默认组合限制，既有回放结果逐字节不变。
  // 传入 { maxOpenPositions, positionMode, allowPyramiding } 可按真实账户重跑。
  portfolio = null,
  archive = null
} = {}) {
  if (!REPLAY_STRATEGIES.includes(strategy)) throw new Error(`Unknown replay strategy: ${strategy}`);
  if (strategy === "historical-compatible" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = HISTORICAL_COMPATIBLE_PARAMETERS;
  if (strategy === "anti-chase" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = ANTI_CHASE_PARAMETERS;
  if (strategy === "research-v2" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = RESEARCH_CHALLENGER_V2_PARAMETERS;
  if (strategy === "data-tiered" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = DATA_TIERED_PARAMETERS;
  if (strategy === "multi-venue-v3" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = MULTI_VENUE_CHALLENGER_PARAMETERS;
  if (strategy === "breakout-v4" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = BREAKOUT_V4_PARAMETERS;
  const rangeStart = new Date(from).getTime();
  const rangeEnd = new Date(to).getTime();
  // Multi-scale research profiles need more than the frozen engine's 60 daily
  // bars (STANDARD_SWING uses EMA60 plus initialization history).  Give those
  // strategies an explicit warm-up instead of letting their first event crash.
  const requiredDailyWarmup = ["research-v2", "multi-venue-v3"].includes(strategy) ? 70 : 60;
  const warmupIndex = firstReplayableIndex(dataset.candles, requiredDailyWarmup);
  if (warmupIndex < 0) throw new Error("Dataset has fewer than 60 completed daily candles");
  const firstIndex = Math.max(warmupIndex, dataset.candles.findIndex((item) => item.timestamp >= rangeStart));
  let lastIndex = dataset.candles.findLastIndex((item) => item.timestamp <= rangeEnd);
  if (lastIndex < 0) lastIndex = dataset.candles.length - 1;
  if (firstIndex < 0 || lastIndex <= firstIndex) throw new Error("Replay interval has no usable candles after warmup");
  if (!Number.isInteger(eventStride) || eventStride < 1) throw new Error("eventStride must be a positive integer");
  if (!Number.isInteger(executionDelayBars) || executionDelayBars < 1 || executionDelayBars > 8) throw new Error("executionDelayBars must be between 1 and 8");
  if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
  const resolvedDbPath = dbPath ?? (outputDirectory ? join(outputDirectory, `${strategy}.sqlite`) : ":memory:");
  const capital = resolveCapitalProfile(paperConfig, { capitalProfile, referenceCapitalCny });
  const config = {
    ...paperConfig,
    initialCapitalCny: capital.initialCapitalCny,
    databasePath: resolvedDbPath,
    databasePathSource: "HISTORICAL_REPLAY"
  };
  const db = openPaperDatabase(resolvedDbPath, config);
  applyPortfolioOverride(db, portfolio);
  const rejectionCounts = {};
  const trace = [];
  const actionCounts = {};
  const actions = {
    push: (...items) => {
      for (const item of items) actionCounts[item.type] = (actionCounts[item.type] ?? 0) + 1;
      return Object.values(actionCounts).reduce((sum, value) => sum + value, 0);
    }
  };
  let eventCount = 0;
  let firstEventAt = null;
  let lastEventAt = null;
  const eventHasher = createHash("sha256");
  const decisionCounts = { LONG: 0, SHORT: 0, WAIT: 0 };
  const candidateDecisionCounts = { LONG: 0, SHORT: 0, WAIT: 0 };
  let pending = null;
  const seenSignalKeys = new Set();
  let lastReport = null;
  try {
    for (let index = firstIndex; index <= lastIndex; index += eventStride) {
      const candle = dataset.candles[index];
      // Anti-Chase consumes raw 15m/1h geometry on every event and therefore
      // cannot use the 12-row summary-cache shortcut.
      const compactCachedFrame = ["challenger", "historical-compatible", "tradable-edge"].includes(strategy)
        && hasChallengerFrameCache(candle.timestamp + BAR_MS, candle.close);
      const market = buildPointInTimeMarket(dataset.candles, dataset.funding, index, {
        maximumBars: compactCachedFrame ? 12 : 260,
        historicalSeries: dataset.series ?? {},
        archive,
        multiVenueFunding: dataset.multiVenueFunding ?? dataset.multiVenue?.funding ?? []
      });
      if (pending?.remaining === 1) {
        executePending(db, pending.report, candle, market, actions, config, executionDelayBars, rejectionCounts);
        pending = null;
      } else if (pending) pending.remaining -= 1;
      const report = buildReport(strategy, market, parameters, config);
      eventCount += 1;
      firstEventAt ??= report.generatedAt;
      lastEventAt = report.generatedAt;
      eventHasher.update(`${candle.timestamp}:${candle.close}\n`);
      decisionCounts[report.decision] += 1;
      candidateDecisionCounts[report.candidateDecision] += 1;
      managePositions(db, report, actions, config);
      const signalKey = report.entryAssessment?.signalKey ?? null;
      const duplicateSignalBar = Boolean(signalKey && seenSignalKeys.has(signalKey));
      if (signalKey && ["LONG", "SHORT"].includes(report.decision) && !duplicateSignalBar) seenSignalKeys.add(signalKey);
      if (duplicateSignalBar) rejectionCounts.DUPLICATE_SIGNAL_BAR = (rejectionCounts.DUPLICATE_SIGNAL_BAR ?? 0) + 1;
      if (collectTrace) trace.push({
        eventTimestamp: candle.timestamp,
        eventClose: candle.close,
        timestamp: report.generatedAt,
        visibleAt: report.replay.visibleAt,
        replayFields: market.replay.fieldStatus,
        multiVenueFunding: market.multiVenue?.funding ?? null,
        price: report.currentPrice,
        decision: report.decision,
        candidateDecision: report.candidateDecision,
        longScore: report.scores.longOpportunity,
        shortScore: report.scores.shortOpportunity,
        opportunityIndex: report.opportunityIndex ?? null,
        tradableEdge: report.tradableEdge ?? null,
        entryQuality: report.entryQuality ?? null,
        entryGeometry: report.entryGeometry ?? null,
        indicatorProfile: report.multiScaleContext?.profile?.selected ?? null,
        directionState: report.directionState ?? null,
        signalKey,
        signalBarTimestamp: report.entryAssessment?.signalBarTimestamp ?? null,
        duplicateSignalBar,
        regime: report.strategy.marketRegime,
        validForEntry: report.dataQuality.validForEntry,
        riskGates: report.riskGates
      });
      if (!duplicateSignalBar && !pending && ["LONG", "SHORT"].includes(report.decision) && db.getOpenPositions().length === 0) {
        pending = { report: clone(report), remaining: executionDelayBars };
      }
      lastReport = report;
    }
    if (forceCloseAtEnd && lastReport) {
      for (const position of db.getOpenPositions()) {
        const exit = evaluatePaperExit(position, lastReport, config, {
          checkStop: false,
          checkTarget: false,
          forcedReason: "END_OF_REPLAY",
          managementReason: "回放区间结束，按最后可见价格强制结算"
        });
        closePosition(db, position, exit, actions);
      }
    }
    const closedTrades = db.getClosedPositions();
    const replayFieldNames = [...new Set(trace.flatMap((item) => Object.keys(item.replayFields ?? {})))];
    const replayDataCoverage = Object.fromEntries(replayFieldNames.map((field) => [field, {
      availableEvents: trace.filter((item) => item.replayFields?.[field]?.available).length,
      staleEvents: trace.filter((item) => item.replayFields?.[field]?.provenance === "STALE").length,
      unavailableEvents: trace.filter((item) => item.replayFields?.[field]?.provenance === "HISTORICAL_UNAVAILABLE").length
    }]));
    const derivativeFields = ["depth", "openInterest", "eliteAccount", "elitePosition", "liquidations", "markPrice", "premium", "basis"];
    const noDerivativeEvidence = derivativeFields.every((field) => Number(replayDataCoverage[field]?.availableEvents ?? 0) === 0);
    const report = {
      schemaVersion: 1,
      runType: "HISTORICAL_REPLAY",
      strategy,
      strategyVersion: strategy === "champion" ? "V1.2-FROZEN" : parameters.version,
      strategyHash: strategy === "champion" ? "9B7D3C533B9C1D971E3695348D22F1D3F2FEACB8F22519D619A4A63AA7990FA6" : hashObject(parameters),
      dataManifestHash: dataset.manifest.manifestHash,
      datasetId: dataset.manifest.datasetId,
      requestedRange: { from: new Date(rangeStart).toISOString(), to: new Date(rangeEnd).toISOString() },
      effectiveRange: { from: firstEventAt, to: lastEventAt },
      eventCount,
      eventStreamHash: eventHasher.digest("hex"),
      capital,
      // 「合约步进拒绝」和「风险/保证金拒绝」必须分开统计：前者是小账户的粒度问题，
      // 后者才是策略本身的风险约束。混在一起就无法判断 edge 是否存在。
      entryRejections: summarizeEntryRejections(rejectionCounts),
      // 组合限制会直接决定成交笔数的上限：只有一个仓位槽时，持仓期间的每一个新信号
      // 都会被丢弃，交易数因此可能被设置卡住而不是被行情卡住。回放用的是
      // PAPER_CONFIG 默认值，未必等于实盘账户的设置，所以必须如实记录下来，
      // 否则读者会把「一个槽位的成交笔数」误读成「这套策略的自然频率」。
      portfolioLimits: portfolioLimitsInForce(db),
      assumptions: { ...REPLAY_ASSUMPTIONS, executionDelayBars },
      pointInTimeGuarantees: {
        closedCandlesOnly: true,
        highTimeframeCloseBoundaryEnforced: true,
        futureRowsPassedToStrategy: false,
        historicalMissingValuesSynthesized: false
      },
      replayDataCoverage: {
        fields: replayDataCoverage,
        noDerivativeEvidence,
        warning: noDerivativeEvidence
          ? "NO_DERIVATIVES_HISTORY: replay decisions may all WAIT under the frozen strict data gate; this is a coverage limitation, not strategy evidence"
          : null
      },
      performance: {
        ...enrichPerformance(db, trace),
        decisions: { counts: decisionCounts, candidateCounts: candidateDecisionCounts }
      },
      tradeCount: closedTrades.length,
      actionCounts,
      trades: closedTrades,
      tradeContexts: tradePathContext(db, dataset, closedTrades),
      trace,
      limitations: strategy === "champion" ? [
        "Frozen V1.2 requires historical execution/derivatives fields that the catalog cannot reconstruct; its original data gates remain active.",
        "A WAIT caused by unavailable historical evidence is retained and is not converted to a trade."
      ] : strategy === "historical-compatible" ? [
        "Historical-Compatible Champion uses only the declared point-in-time OHLCV/Funding feature set.",
        "Unavailable historical execution and derivatives fields remain absent and are never synthesized."
      ] : strategy === "tradable-edge" ? [
        "Tradable Edge uses a frozen non-ML empirical model trained only on its declared pre-OOS interval.",
        "Every entry still passes the unchanged Paper risk/execution core after the net-edge gate.",
        "Unavailable historical execution and derivatives fields remain absent and are never synthesized."
      ] : strategy === "data-tiered" ? [
        "V1.3-DATA-TIERED is a CANDIDATE. It reuses the frozen V1.2 direction, scoring and regime unchanged and only replaces the all-or-nothing data gate with the tiered CRITICAL/IMPORTANT/AUXILIARY policy.",
        "Replay calls the same analyzeDataTiered/applyTieredDataPolicy used by live monitor under dataPolicyMode=TIERED_DEGRADED; there is no second behavioural implementation.",
        "Historically unavailable order book/OI/elite/mark-basis stay absent and are never synthesized; they degrade the risk budget and raise the entry score bar instead of forcing WAIT.",
        "This replay does not promote anything and must not touch the untouched Final OOS."
      ] : strategy === "research-v2" ? [
        "Research V2 uses only point-in-time closed OHLCV and timestamp-visible Funding in historical replay.",
        "Its independent-dimension scoring, price-extension gate, structure target and Tradable Edge calculation are shared with live Shadow; it does not modify the frozen V1.2 Champion.",
        "Historical Order Book/OI/liquidations/elite positioning are absent and never synthesized; the derivatives dimension degrades to actually visible Funding only."
      ] : strategy === "multi-venue-v3" ? [
        "V3 scores LONG and SHORT as separate evidence sets; they are not complements and are not probabilities.",
        "Only timestamp-visible realized Funding observations are used across venues; missing venues remain missing and no present value is copied backward.",
        "Cross-venue Funding is a research candidate feature. It has no production weight until purged OOS and Shadow gates pass.",
        "The SWING_RUNNER_V1 management profile keeps hard SL/TP but delays break-even and trailing so a 2R+ entry contract has room to resolve."
      ] : strategy === "breakout-v4" ? [
        "V4 is a research-only 4h Donchian breakout candidate selected in development exploration; it is not promoted production evidence.",
        "Signals use completed 4h candles only, enter at the next 15m open, and re-anchor the 2.5 ATR stop and fixed 4R target to that simulated fill.",
        "HARD_BRACKET_HOLD_V1 preserves the original hard SL/TP and disables break-even, trailing, target extension, and short-horizon signal exits.",
        "Funding is included as timestamp-visible carrying cost only; derivatives and cross-venue observations are not directional triggers."
      ] : [
        "Challenger uses only timestamp-valid candle and Funding fields; it is a research strategy and does not replace Champion."
      ]
    };
    return report;
  } finally {
    db.close();
  }
}

export async function runChampionChallengerComparison(dataset, options = {}) {
  const champion = await runHistoricalReplay(dataset, { ...options, strategy: "champion", outputDirectory: options.outputDirectory ? join(options.outputDirectory, "champion") : undefined });
  const challenger = await runHistoricalReplay(dataset, { ...options, strategy: "challenger", parameters: options.parameters ?? CHALLENGER_BASE_PARAMETERS, outputDirectory: options.outputDirectory ? join(options.outputDirectory, "challenger") : undefined });
  const sameEvents = champion.trace.length === challenger.trace.length
    && champion.trace.every((item, index) => item.eventTimestamp === challenger.trace[index].eventTimestamp
      && item.eventClose === challenger.trace[index].eventClose);
  return {
    runType: "CHAMPION_CHALLENGER_SAME_EVENT_COMPARISON",
    sameEvents,
    champion,
    challenger,
    isolation: {
      separateDatabase: true,
      separateEquityCurves: true,
      challengerCanAffectChampion: false,
      paperOnly: true
    }
  };
}
