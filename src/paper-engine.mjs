import { PAPER_CONFIG } from "./config.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

export function shanghaiDayStartIso(timestamp = new Date().toISOString()) {
  const utcMs = new Date(timestamp).getTime();
  if (!Number.isFinite(utcMs)) throw new Error("Invalid timestamp");
  const shanghai = new Date(utcMs + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate()
  ) - 8 * 60 * 60 * 1000).toISOString();
}

function candidateTargets(report) {
  const targets = report.plan?.takeProfit;
  return Array.isArray(targets) ? targets.map(Number).filter(Number.isFinite) : [];
}

function perUnitEconomics(side, entry, stopLoss, takeProfit, fundingRate, config) {
  const adverseMove = side === "LONG" ? entry - stopLoss : stopLoss - entry;
  const favorableMove = side === "LONG" ? takeProfit - entry : entry - takeProfit;
  const adverseFunding = Math.abs(fundingRate) * entry;
  const riskUsdt = adverseMove + config.feeRatePerSide * (entry + stopLoss) + adverseFunding;
  const rewardUsdt = favorableMove - config.feeRatePerSide * (entry + takeProfit) - adverseFunding;
  return {
    riskUsdt,
    rewardUsdt,
    rr: riskUsdt > 0 ? rewardUsdt / riskUsdt : null
  };
}

export function buildPaperCandidate(report, account, config = PAPER_CONFIG) {
  const side = report.decision;
  if (!['LONG', 'SHORT'].includes(side)) return null;
  if (!report.plan || !finite(report.currentPrice) || !finite(report.plan.stopLoss)) return null;

  const entry = Number(report.currentPrice);
  const stopLoss = Number(report.plan.stopLoss);
  const stopIsValid = side === "LONG" ? stopLoss < entry : stopLoss > entry;
  if (!stopIsValid) return null;

  const fundingRate = finite(report.derivatives?.fundingRatePct)
    ? Number(report.derivatives.fundingRatePct) / 100
    : 0;
  const target = candidateTargets(report)
    .map((takeProfit) => ({
      takeProfit,
      ...perUnitEconomics(side, entry, stopLoss, takeProfit, fundingRate, config)
    }))
    .find((item) => {
      const targetIsValid = side === "LONG" ? item.takeProfit > entry : item.takeProfit < entry;
      return targetIsValid && finite(item.rr) && item.rr >= config.minimumRiskReward;
    });
  if (!target) return null;

  const cashCny = Number(account.cash_cny);
  if (!(cashCny > 0)) return null;
  const riskBudgetCny = cashCny * config.maxRiskPerTradePct;
  const riskPerBtcCny = target.riskUsdt * config.usdtCnyRate;
  const quantityByRisk = riskBudgetCny / riskPerBtcCny;
  const quantityByCash = cashCny * config.maxNotionalMultiple / (entry * config.usdtCnyRate);
  const quantityBtc = Math.min(quantityByRisk, quantityByCash);
  if (!(quantityBtc > 0)) return null;

  const notionalCny = quantityBtc * entry * config.usdtCnyRate;
  const entryFeeCny = notionalCny * config.feeRatePerSide;
  const riskCny = quantityBtc * riskPerBtcCny;
  const directionReasons = (side === "LONG" ? report.bullishReasons : report.bearishReasons) ?? [];

  return {
    symbol: report.symbol,
    side,
    openedAt: report.generatedAt,
    entryBarTs: Number(report.latest15mBar?.timestamp ?? new Date(report.generatedAt).getTime()),
    entry: round(entry, 2),
    stopLoss: round(stopLoss, 2),
    takeProfit: round(target.takeProfit, 2),
    rr: round(target.rr, 3),
    quantityBtc: round(quantityBtc, 8),
    riskCny: round(riskCny, 4),
    riskBudgetCny: round(riskBudgetCny, 4),
    notionalCny: round(notionalCny, 4),
    entryFeeCny: round(entryFeeCny, 4),
    openingReasons: [
      ...directionReasons.slice(0, 5),
      `Risk Gate 通过：净 RR ${round(target.rr, 2)}，单笔风险 ${round(riskCny, 2)} CNY`
    ]
  };
}

export function getDailyRiskState(db, at = new Date().toISOString(), config = PAPER_CONFIG) {
  const dayStart = shanghaiDayStartIso(at);
  const events = db.getAccountEvents({ since: dayStart });
  const dailyPnlCny = events.reduce((sum, event) => sum + Number(event.amount_cny), 0);
  const cashCny = Number(db.getAccount().cash_cny);
  const dayStartBalanceCny = cashCny - dailyPnlCny;
  const dailyLossCny = Math.max(0, -dailyPnlCny);
  const maxDailyLossCny = dayStartBalanceCny * config.maxDailyLossPct;
  const closed = db.getClosedPositions({ since: dayStart });
  let consecutiveLosses = 0;
  for (let index = closed.length - 1; index >= 0; index -= 1) {
    if (Number(closed[index].net_pnl_cny) < 0) consecutiveLosses += 1;
    else break;
  }
  const lossLimitReached = dailyLossCny >= maxDailyLossCny;
  const streakLimitReached = consecutiveLosses >= config.maxConsecutiveLosses;
  return {
    dayStart,
    dayStartBalanceCny: round(dayStartBalanceCny, 4),
    dailyPnlCny: round(dailyPnlCny, 4),
    dailyLossCny: round(dailyLossCny, 4),
    maxDailyLossCny: round(maxDailyLossCny, 4),
    consecutiveLosses,
    paused: lossLimitReached || streakLimitReached,
    pauseReasons: [
      ...(lossLimitReached ? [`当日损失已达到 ${config.maxDailyLossPct * 100}% 上限`] : []),
      ...(streakLimitReached ? [`当日已连续亏损 ${consecutiveLosses} 笔`] : [])
    ]
  };
}

export function evaluatePaperEntry(db, report, config = PAPER_CONFIG) {
  const reasons = [];
  if (!['LONG', 'SHORT'].includes(report.decision)) reasons.push("当前决策不是 LONG/SHORT");
  if (report.riskGates?.length) reasons.push(...report.riskGates);
  if (db.getOpenPosition()) reasons.push("已有模拟仓位");
  const dailyRisk = getDailyRiskState(db, report.generatedAt, config);
  if (dailyRisk.paused) reasons.push(...dailyRisk.pauseReasons);
  let candidate = null;
  if (!reasons.length) {
    candidate = buildPaperCandidate(report, db.getAccount(), config);
    if (!candidate) reasons.push("没有满足净 RR ≥ 2 与仓位约束的有效计划");
  }
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    dailyRisk,
    candidate
  };
}

export function evaluatePaperExit(position, report, config = PAPER_CONFIG) {
  const bar = report.latest15mBar;
  const canUseBar = finite(bar?.timestamp) && Number(bar.timestamp) > Number(position.entry_bar_ts);
  let hitStop = false;
  let hitTarget = false;

  if (canUseBar && finite(bar.low) && finite(bar.high)) {
    if (position.side === "LONG") {
      hitStop = Number(bar.low) <= Number(position.stop_loss);
      hitTarget = Number(bar.high) >= Number(position.take_profit);
    } else {
      hitStop = Number(bar.high) >= Number(position.stop_loss);
      hitTarget = Number(bar.low) <= Number(position.take_profit);
    }
  } else if (finite(report.currentPrice)) {
    if (position.side === "LONG") {
      hitStop = Number(report.currentPrice) <= Number(position.stop_loss);
      hitTarget = Number(report.currentPrice) >= Number(position.take_profit);
    } else {
      hitStop = Number(report.currentPrice) >= Number(position.stop_loss);
      hitTarget = Number(report.currentPrice) <= Number(position.take_profit);
    }
  }

  if (!hitStop && !hitTarget) return null;
  const exitReason = hitStop ? "SL" : "TP";
  const exitPrice = Number(hitStop ? position.stop_loss : position.take_profit);
  const direction = position.side === "LONG" ? 1 : -1;
  const grossPnlCny = direction * (exitPrice - Number(position.entry_price))
    * Number(position.quantity_btc) * config.usdtCnyRate;
  const exitFeeCny = exitPrice * Number(position.quantity_btc)
    * config.usdtCnyRate * config.feeRatePerSide;
  return {
    closedAt: report.generatedAt,
    exitPrice: round(exitPrice, 2),
    exitReason,
    grossPnlCny: round(grossPnlCny, 4),
    exitFeeCny: round(exitFeeCny, 4),
    conservativeSameBar: Boolean(hitStop && hitTarget)
  };
}

export function fundingBoundaries(lastFundingAt, now) {
  const start = new Date(lastFundingAt).getTime();
  const end = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const boundaries = [];
  let boundary = Math.floor(start / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS + FUNDING_INTERVAL_MS;
  while (boundary <= end) {
    boundaries.push(new Date(boundary).toISOString());
    boundary += FUNDING_INTERVAL_MS;
  }
  return boundaries;
}

export function applyDueFunding(db, position, report) {
  const rate = finite(report.derivatives?.fundingRatePct)
    ? Number(report.derivatives.fundingRatePct) / 100
    : 0;
  const settlements = [];
  let current = position;
  for (const settledAt of fundingBoundaries(position.last_funding_at, report.generatedAt)) {
    const payerSign = current.side === "LONG" ? -1 : 1;
    const cashflowCny = round(Number(current.notional_cny) * rate * payerSign, 4);
    current = db.applyFunding(current.id, cashflowCny, settledAt, {
      fundingRate: rate,
      side: current.side,
      source: "HTX_CURRENT_PUBLIC_RATE_SIMULATION"
    });
    settlements.push({ settledAt, rate, cashflowCny });
  }
  return { position: current, settlements };
}

export function calculateUnrealized(position, currentPrice, config = PAPER_CONFIG) {
  if (!position || !finite(currentPrice)) return null;
  const direction = position.side === "LONG" ? 1 : -1;
  return round(direction * (Number(currentPrice) - Number(position.entry_price))
    * Number(position.quantity_btc) * config.usdtCnyRate, 4);
}

export function calculatePerformance(db) {
  const account = db.getAccount();
  const trades = db.getClosedPositions();
  const events = db.getAccountEvents();
  const netResults = trades.map((trade) => Number(trade.net_pnl_cny));
  const wins = netResults.filter((value) => value > 0);
  const losses = netResults.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const initialCapital = Number(account.initial_capital_cny);
  let peak = initialCapital;
  let maxDrawdownCny = 0;
  let maxDrawdownPct = 0;
  for (const event of events) {
    const balance = Number(event.balance_after_cny);
    peak = Math.max(peak, balance);
    const drawdown = peak - balance;
    if (drawdown > maxDrawdownCny) {
      maxDrawdownCny = drawdown;
      maxDrawdownPct = peak > 0 ? drawdown / peak * 100 : 0;
    }
  }
  const cashCny = Number(account.cash_cny);
  const cumulativePnlCny = cashCny - initialCapital;
  return {
    initialCapitalCny: round(initialCapital, 2),
    cashCny: round(cashCny, 2),
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? round(wins.length / trades.length * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : (grossProfit > 0 ? Infinity : null),
    expectancyCny: trades.length ? round(netResults.reduce((sum, value) => sum + value, 0) / trades.length, 4) : 0,
    maxDrawdownCny: round(maxDrawdownCny, 4),
    maxDrawdownPct: round(maxDrawdownPct, 4),
    cumulativePnlCny: round(cumulativePnlCny, 4),
    cumulativeReturnPct: round(cumulativePnlCny / initialCapital * 100, 4),
    feesCny: round(events.reduce((sum, event) => {
      if (event.event_type === "ENTRY_FEE") return sum + Math.abs(Number(event.amount_cny));
      if (event.event_type === "CLOSE") return sum + Number(event.details.exitFeeCny ?? 0);
      return sum;
    }, 0), 4),
    fundingCny: round(events
      .filter((event) => event.event_type === "FUNDING")
      .reduce((sum, event) => sum + Number(event.amount_cny), 0), 4)
  };
}

export const PAPER_TIME = Object.freeze({ DAY_MS, FUNDING_INTERVAL_MS });
