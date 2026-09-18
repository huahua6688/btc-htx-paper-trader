// 资金费率持有（cash-and-carry）研究。
//
// 这不是方向策略：现货多 1 份、永续空 1 份，价格涨跌在两条腿之间抵消，
// 收益只来自每 8 小时的资金费结算。空头在费率为正时收钱、为负时付钱。
//
// 之所以单独成篇，是因为它回答的问题和本项目其余部分完全不同：
// 前者问「能不能猜对方向」，这里问「不猜方向时，市场结构本身付不付钱」。
//
// 诚实边界（每一条都会写进报告，不允许只报收益不报这些）：
//   1. 假设对冲完美，不计基差（basis）损益。目录里的 basis 只有两个月，
//      不足以覆盖回测区间，与其用两个月去推两年，不如明确留空。
//   2. 不计现货那条腿的资金占用成本。
//   3. 不模拟再平衡：价格大幅变动后两条腿的名义值会偏离，真实操作需要调仓，
//      调仓有成本。此处给出的是「不调仓」的上界。
//   4. 不模拟强平。强平风险另算成阈值指标，因为那是这个玩法最常见的死法。
//
// 因此本模块给出的是一个**上界**，真实结果只会更差。若上界都不够正，
// 这条路就不必再往下走。

import { PAPER_CONFIG } from "./config.mjs";
import { round } from "./research-utils.mjs";

const SETTLEMENTS_PER_DAY = 3;
const DAYS_PER_YEAR = 365;
const SETTLEMENTS_PER_YEAR = SETTLEMENTS_PER_DAY * DAYS_PER_YEAR;

const finite = (value) => Number.isFinite(Number(value));

/**
 * 把目录里的 funding 记录归一成 { timestamp, rate }，按时间排序、去重。
 * 只接受结构完整的记录：缺失的结算宁可少算，也不插值补齐。
 */
export function normalizeFundingSeries(records = []) {
  const rows = records
    .map((item) => ({
      timestamp: Number(item.timestamp ?? item.eventTime),
      rate: Number(item.fundingRate ?? item.normalized?.fundingRate)
    }))
    .filter((item) => finite(item.timestamp) && finite(item.rate));
  return [...new Map(rows.map((item) => [item.timestamp, item])).values()]
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 空头收到的资金费按名义仓位计价。正费率 = 空头收钱。
 */
function accumulate(series) {
  let cumulative = 0;
  let peak = 0;
  let worstDrawdown = 0;
  let negativeStreak = 0;
  let longestNegativeStreak = 0;
  const path = [];
  for (const item of series) {
    cumulative += item.rate;
    peak = Math.max(peak, cumulative);
    worstDrawdown = Math.min(worstDrawdown, cumulative - peak);
    negativeStreak = item.rate < 0 ? negativeStreak + 1 : 0;
    longestNegativeStreak = Math.max(longestNegativeStreak, negativeStreak);
    path.push({ timestamp: item.timestamp, cumulative });
  }
  return { cumulative, worstDrawdown, longestNegativeStreak, path };
}

/**
 * 空头腿的强平阈值。现货那条腿的浮盈救不了永续腿 —— 这正是这个玩法最常见的死法，
 * 所以必须单独报出来，而不是混进收益里。
 */
export function shortLegLiquidationThresholds({
  maintenanceMarginRate = PAPER_CONFIG.paperMaintenanceMarginRateEstimate,
  leverages = [1, 2, 3, 5, 10]
} = {}) {
  return leverages.map((leverage) => ({
    shortLegLeverage: leverage,
    // 隔离保证金下，空头在价格上涨约 (1/杠杆 - 维持保证金率) 时触及强平。
    priceRisePctToLiquidate: round((1 / leverage - maintenanceMarginRate) * 100, 3)
  }));
}

export function analyzeFundingCarry(fundingRecords, {
  // 两条腿各开各平，因此一个完整来回是 4 次成交。
  perpFeeRatePerSide = PAPER_CONFIG.feeRatePerSide,
  spotFeeRatePerSide = PAPER_CONFIG.feeRatePerSide,
  slippageRatePerSide = PAPER_CONFIG.slippageRate,
  maintenanceMarginRate = PAPER_CONFIG.paperMaintenanceMarginRateEstimate
} = {}) {
  const series = normalizeFundingSeries(fundingRecords);
  if (series.length < 2) throw new Error("资金费率记录不足，无法分析持有收益");

  const { cumulative, worstDrawdown, longestNegativeStreak, path } = accumulate(series);
  const negative = series.filter((item) => item.rate < 0);
  const spanMs = series.at(-1).timestamp - series[0].timestamp;
  const spanDays = spanMs / 86_400_000;

  // 一个完整来回：现货开+平、永续开+平，每次都有手续费与滑点。
  const roundTripCost = 2 * (perpFeeRatePerSide + slippageRatePerSide)
    + 2 * (spotFeeRatePerSide + slippageRatePerSide);
  const net = cumulative - roundTripCost;
  const annualized = spanDays > 0 ? net * (DAYS_PER_YEAR / spanDays) : null;

  const rates = series.map((item) => item.rate);
  const mean = rates.reduce((sum, value) => sum + value, 0) / rates.length;

  return {
    runType: "FUNDING_CARRY_UPPER_BOUND",
    generatedAt: new Date().toISOString(),
    coverage: {
      from: new Date(series[0].timestamp).toISOString(),
      to: new Date(series.at(-1).timestamp).toISOString(),
      settlements: series.length,
      days: round(spanDays, 1),
      // 8 小时一次，缺口意味着目录不完整，不是市场没有结算。
      expectedSettlements: Math.round(spanDays * SETTLEMENTS_PER_DAY),
      missingSettlements: Math.max(0, Math.round(spanDays * SETTLEMENTS_PER_DAY) - series.length)
    },
    fundingPct: {
      cumulative: round(cumulative * 100, 4),
      meanPerSettlement: round(mean * 100, 6),
      annualizedGross: spanDays > 0 ? round(cumulative * (DAYS_PER_YEAR / spanDays) * 100, 3) : null,
      impliedAnnualFromMean: round(mean * SETTLEMENTS_PER_YEAR * 100, 3)
    },
    costPct: {
      roundTrip: round(roundTripCost * 100, 4),
      note: "一个来回 4 次成交：现货开平 + 永续开平，各含手续费与滑点"
    },
    netPct: {
      total: round(net * 100, 4),
      annualized: annualized === null ? null : round(annualized * 100, 3),
      positive: net > 0
    },
    risk: {
      negativeSettlements: negative.length,
      negativeSettlementPct: round(negative.length / series.length * 100, 2),
      worstCumulativeDrawdownPct: round(worstDrawdown * 100, 4),
      longestNegativeStreak,
      longestNegativeStreakHours: longestNegativeStreak * 8,
      shortLegLiquidation: shortLegLiquidationThresholds({ maintenanceMarginRate })
    },
    path,
    limitations: [
      "结果是上界：假设对冲完美、不再平衡、不计基差损益与现货资金占用成本。",
      "不模拟强平。空头腿的强平阈值单列在 risk.shortLegLiquidation，现货腿的浮盈救不了它。",
      "缺失的结算不插值补齐；missingSettlements 大于 0 时累计值被低估，不是市场没付。",
      "费率取自目录里的 realized_rate；若某段用的是预测费率，实际收到的会不同。",
      "本项目为 Paper-only：此分析不构成下单建议，真实执行需要两个场所的真实账户与撤/补仓能力。"
    ]
  };
}
