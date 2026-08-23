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

export const REPLAY_ASSUMPTIONS = Object.freeze({
  signalClock: "decision at completed 15m candle close",
  executionDelayBars: 1,
  entryClock: "next 15m candle open",
  costs: "same PAPER_CONFIG fee and adverse slippage functions as live Paper",
  funding: "timestamped HTX historical Funding only; no forward-fill",
  intrabarPriority: "same bar SL and TP resolves to SL first",
  unavailableHistory: "order book/OI/elite/liquidation/basis are null, never synthesized"
});

function clone(value) { return structuredClone(value); }

function executionReport(signal, candle, delayBars) {
  const report = clone(signal);
  const oldEntry = Number(signal.currentPrice);
  const newEntry = Number(candle.open);
  report.generatedAt = new Date(candle.timestamp).toISOString();
  report.currentPrice = newEntry;
  report.execution = {
    signalGeneratedAt: signal.generatedAt,
    signalPrice: oldEntry,
    fillReferencePrice: newEntry,
    delayBars,
    delayMs: BAR_MS * delayBars
  };
  if (report.plan && Number.isFinite(Number(report.plan.stopLoss))) {
    report.plan.entryPrice = newEntry;
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
    const management = manageOpenPosition(position, report);
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

function executePending(db, signal, candle, market, actions, config, delayBars) {
  if (!signal || !["LONG", "SHORT"].includes(signal.decision)) return null;
  const report = executionReport(signal, candle, delayBars);
  const gate = evaluatePaperEntry(db, report, config, market);
  if (!gate.allowed) {
    actions.push({ type: "DELAYED_ENTRY_REJECTED", reasons: gate.reasons, signalAt: signal.generatedAt });
    return null;
  }
  const snapshotId = db.insertSnapshot(report);
  gate.candidate.entryBarTs = candle.timestamp - 1;
  gate.candidate.openedAt = report.generatedAt;
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
    : strategy === "historical-compatible"
      ? analyzeHistoricalCompatible(market, parameters, config)
      : strategy === "tradable-edge"
        ? analyzeTradableEdge(market, parameters, config)
        : strategy === "anti-chase"
          ? analyzeAntiChaseChallenger(market, parameters, config)
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
  forceCloseAtEnd = true
} = {}) {
  if (!["champion", "challenger", "historical-compatible", "tradable-edge", "anti-chase"].includes(strategy)) throw new Error(`Unknown replay strategy: ${strategy}`);
  if (strategy === "historical-compatible" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = HISTORICAL_COMPATIBLE_PARAMETERS;
  if (strategy === "anti-chase" && parameters === CHALLENGER_BASE_PARAMETERS) parameters = ANTI_CHASE_PARAMETERS;
  const rangeStart = new Date(from).getTime();
  const rangeEnd = new Date(to).getTime();
  const warmupIndex = firstReplayableIndex(dataset.candles);
  if (warmupIndex < 0) throw new Error("Dataset has fewer than 60 completed daily candles");
  const firstIndex = Math.max(warmupIndex, dataset.candles.findIndex((item) => item.timestamp >= rangeStart));
  let lastIndex = dataset.candles.findLastIndex((item) => item.timestamp <= rangeEnd);
  if (lastIndex < 0) lastIndex = dataset.candles.length - 1;
  if (firstIndex < 0 || lastIndex <= firstIndex) throw new Error("Replay interval has no usable candles after warmup");
  if (!Number.isInteger(eventStride) || eventStride < 1) throw new Error("eventStride must be a positive integer");
  if (!Number.isInteger(executionDelayBars) || executionDelayBars < 1 || executionDelayBars > 8) throw new Error("executionDelayBars must be between 1 and 8");
  if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
  const resolvedDbPath = dbPath ?? (outputDirectory ? join(outputDirectory, `${strategy}.sqlite`) : ":memory:");
  const config = { ...paperConfig, databasePath: resolvedDbPath, databasePathSource: "HISTORICAL_REPLAY" };
  const db = openPaperDatabase(resolvedDbPath, config);
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
  let lastReport = null;
  try {
    for (let index = firstIndex; index <= lastIndex; index += eventStride) {
      const candle = dataset.candles[index];
      // Anti-Chase consumes raw 15m/1h geometry on every event and therefore
      // cannot use the 12-row summary-cache shortcut.
      const compactCachedFrame = ["challenger", "historical-compatible", "tradable-edge"].includes(strategy)
        && hasChallengerFrameCache(candle.timestamp + BAR_MS, candle.close);
      const market = buildPointInTimeMarket(dataset.candles, dataset.funding, index, { maximumBars: compactCachedFrame ? 12 : 260 });
      if (pending?.remaining === 1) {
        executePending(db, pending.report, candle, market, actions, config, executionDelayBars);
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
      if (collectTrace) trace.push({
        eventTimestamp: candle.timestamp,
        eventClose: candle.close,
        timestamp: report.generatedAt,
        visibleAt: report.replay.visibleAt,
        price: report.currentPrice,
        decision: report.decision,
        candidateDecision: report.candidateDecision,
        longScore: report.scores.longOpportunity,
        shortScore: report.scores.shortOpportunity,
        opportunityIndex: report.opportunityIndex ?? null,
        tradableEdge: report.tradableEdge ?? null,
        entryQuality: report.entryQuality ?? null,
        regime: report.strategy.marketRegime,
        validForEntry: report.dataQuality.validForEntry,
        riskGates: report.riskGates
      });
      if (!pending && ["LONG", "SHORT"].includes(report.decision) && db.getOpenPositions().length === 0) {
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
      assumptions: { ...REPLAY_ASSUMPTIONS, executionDelayBars },
      pointInTimeGuarantees: {
        closedCandlesOnly: true,
        highTimeframeCloseBoundaryEnforced: true,
        futureRowsPassedToStrategy: false,
        historicalMissingValuesSynthesized: false
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
