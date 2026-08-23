import { PAPER_CONFIG } from "./config.mjs";
import { BAR_MS, mean, round } from "./research-utils.mjs";

const EVALUATION_BARS = 96;

function netDirectionalReturn(side, entry, exit, fundingRate = 0) {
  const direction = side === "LONG" ? 1 : -1;
  const gross = direction * (exit / entry - 1);
  const costs = 2 * (PAPER_CONFIG.feeRatePerSide + PAPER_CONFIG.slippageRate) + Math.abs(fundingRate);
  return gross - costs;
}

function fundingBetween(funding, start, end) {
  let low = 0;
  let high = funding.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (funding[middle].timestamp <= start) low = middle + 1;
    else high = middle;
  }
  let total = 0;
  for (let index = low; index < funding.length && funding[index].timestamp <= end; index += 1) total += Number(funding[index].fundingRate);
  return total;
}

function decisionCounterfactual(dataset, traceItem, funding, index) {
  const visibleAt = new Date(traceItem.visibleAt ?? traceItem.timestamp).getTime();
  if (index < 0 || index + EVALUATION_BARS >= dataset.candles.length) return null;
  const entry = dataset.candles[index].close;
  const delayedEntry = dataset.candles[index + 1].open;
  const path = dataset.candles.slice(index + 1, index + EVALUATION_BARS + 1);
  const exit = path.at(-1).close;
  const fundingRate = fundingBetween(funding, visibleAt, visibleAt + EVALUATION_BARS * BAR_MS);
  const longReturn = netDirectionalReturn("LONG", entry, exit, fundingRate);
  const shortReturn = netDirectionalReturn("SHORT", entry, exit, fundingRate);
  const delayedLong = netDirectionalReturn("LONG", delayedEntry, exit, fundingRate);
  const delayedShort = netDirectionalReturn("SHORT", delayedEntry, exit, fundingRate);
  return {
    timestamp: traceItem.timestamp,
    originalDecision: traceItem.decision,
    candidateDecision: traceItem.candidateDecision,
    evaluationHorizon: "24h",
    longNetReturnPct: round(longReturn * 100, 4),
    shortNetReturnPct: round(shortReturn * 100, 4),
    waitNetReturnPct: 0,
    delayedLongNetReturnPct: round(delayedLong * 100, 4),
    delayedShortNetReturnPct: round(delayedShort * 100, 4),
    longMfePct: round((Math.max(...path.map((row) => row.high)) / entry - 1) * 100, 4),
    longMaePct: round((Math.min(...path.map((row) => row.low)) / entry - 1) * 100, 4),
    bestAlternative: longReturn > Math.max(0, shortReturn) ? "LONG" : shortReturn > Math.max(0, longReturn) ? "SHORT" : "WAIT",
    evaluatedPostHoc: true,
    eligibleAsDecisionInput: false
  };
}

function lowerBound(candles, timestamp) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function reviewTrade(dataset, trade) {
  const openedAt = new Date(trade.opened_at).getTime();
  const closedAt = new Date(trade.closed_at).getTime();
  const startIndex = lowerBound(dataset.candles, openedAt);
  const endIndex = lowerBound(dataset.candles, closedAt + 1);
  const path = dataset.candles.slice(startIndex, endIndex);
  const direction = trade.side === "LONG" ? 1 : -1;
  const bestFavorable = path.length
    ? (trade.side === "LONG" ? Math.max(...path.map((row) => row.high)) : Math.min(...path.map((row) => row.low)))
    : Number(trade.exit_trigger_price);
  const maximumGross = direction * (bestFavorable - Number(trade.signal_entry_price)) * Number(trade.quantity_btc) * PAPER_CONFIG.usdtCnyRate;
  const totalCosts = Number(trade.entry_fee_cny) + Number(trade.exit_fee_cny)
    + Number(trade.entry_slippage_cny) + Number(trade.exit_slippage_cny) - Number(trade.funding_cny);
  return {
    positionId: trade.id,
    side: trade.side,
    openedAt: trade.opened_at,
    closedAt: trade.closed_at,
    direction: {
      result: Number(trade.gross_pnl_cny) > 0 ? "correct over holding period" : "incorrect over holding period",
      grossPnlCny: round(Number(trade.gross_pnl_cny), 4)
    },
    entry: {
      signalPrice: Number(trade.signal_entry_price),
      fillPrice: Number(trade.entry_price),
      slippageCny: Number(trade.entry_slippage_cny),
      delayWasSimulated: true
    },
    exit: {
      reason: trade.exit_reason,
      triggerPrice: Number(trade.exit_trigger_price),
      fillPrice: Number(trade.exit_price),
      maximumFavorableGrossPnlCny: round(maximumGross, 4),
      capturedFractionPct: maximumGross > 0 ? round(Number(trade.gross_pnl_cny) / maximumGross * 100, 2) : null
    },
    stop: {
      initialStop: Number(trade.initial_stop_loss),
      finalStop: Number(trade.stop_loss),
      exitReason: trade.exit_reason,
      moved: Number(trade.initial_stop_loss) !== Number(trade.stop_loss)
    },
    positionSizing: {
      accountEquityCny: Number(trade.account_equity_cny),
      expectedLossCny: Number(trade.expected_loss_cny),
      expectedLossPct: round(Number(trade.expected_loss_cny) / Number(trade.account_equity_cny) * 100, 4),
      actualNetPnlCny: Number(trade.net_pnl_cny),
      leverage: Number(trade.leverage),
      marginUsagePct: round(Number(trade.margin_usage_pct) * 100, 4)
    },
    costs: {
      entryFeeCny: Number(trade.entry_fee_cny), exitFeeCny: Number(trade.exit_fee_cny),
      entrySlippageCny: Number(trade.entry_slippage_cny), exitSlippageCny: Number(trade.exit_slippage_cny),
      fundingCny: Number(trade.funding_cny), totalCostsCny: round(totalCosts, 4),
      costToGrossPct: Number(trade.gross_pnl_cny) !== 0 ? round(totalCosts / Math.abs(Number(trade.gross_pnl_cny)) * 100, 2) : null
    },
    postHocOnly: true
  };
}

export function runCounterfactualReview(dataset, replay) {
  const funding = dataset.funding;
  const indexByVisibleAt = new Map(dataset.candles.map((row, index) => [row.timestamp + BAR_MS, index]));
  const decisions = replay.trace.map((item) => {
    const visibleAt = new Date(item.visibleAt ?? item.timestamp).getTime();
    return decisionCounterfactual(dataset, item, funding, indexByVisibleAt.get(visibleAt) ?? -1);
  }).filter(Boolean);
  const wait = decisions.filter((item) => item.originalDecision === "WAIT");
  const decisionRegret = (item) => Math.max(item.longNetReturnPct, item.shortNetReturnPct, 0)
    - (item.originalDecision === "LONG" ? item.longNetReturnPct : item.originalDecision === "SHORT" ? item.shortNetReturnPct : 0);
  return {
    runType: "POST_HOC_COUNTERFACTUAL_REVIEW",
    sourceStrategyHash: replay.strategyHash,
    decisionCount: decisions.length,
    waitTracked: wait.length,
    tradeReviews: replay.trades.map((trade) => reviewTrade(dataset, trade)),
    decisionCounterfactuals: decisions,
    aggregate: {
      averageDecisionRegretPct: round(mean(decisions.map(decisionRegret)), 4),
      averageWaitOpportunityPct: round(mean(wait.map((item) => Math.max(item.longNetReturnPct, item.shortNetReturnPct, 0))), 4),
      waitBestWasLongPct: wait.length ? round(wait.filter((item) => item.bestAlternative === "LONG").length / wait.length * 100, 2) : null,
      waitBestWasShortPct: wait.length ? round(wait.filter((item) => item.bestAlternative === "SHORT").length / wait.length * 100, 2) : null,
      waitWasBestPct: wait.length ? round(wait.filter((item) => item.bestAlternative === "WAIT").length / wait.length * 100, 2) : null
    },
    leakageControl: "Counterfactual columns are generated only after replay completion and are never joined back into strategy inputs."
  };
}
