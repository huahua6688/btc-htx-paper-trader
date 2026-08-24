// V1.3-DATA-TIERED 候选策略。
//
// 存在的唯一理由：冻结的 V1.2 Champion 把每一项次要衍生品都当成硬门禁，
// 于是一个公开接口抖动就等于整个系统停止交易，历史回放也因为不存在时点盘口
// 而全部变成 WAIT。本候选用分级数据门禁替换那条一票否决规则。
//
// 重要边界：
//   - 不修改 src/analysis-engine.mjs。冻结 Champion 的 SHA-256 保持不变，
//     并且仍然是可复现的 baseline。
//   - 本文件是一个独立的 CANDIDATE 版本，必须走完整的 OOS / Shadow / Promotion Gate
//     才可能晋级，本次修复没有、也不允许让它自动变成 Champion。
//   - 方向判断、评分、regime 全部原样来自 analyzeSnapshot，本候选只改变
//     「数据缺失时是否允许入场，以及降级时收紧多少」。
//   - 缺失数据永远不会被伪造或回填；降级只会收紧风险，不会放宽任何风控。

import { analyzeSnapshot, summarizeTimeframe } from "./analysis-engine.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import {
  classifyDataQuality,
  DATA_POLICIES,
  DATA_STATUS
} from "./data-quality.mjs";

export const DATA_TIERED_PARAMETERS = Object.freeze({
  version: "V1.3-DATA-TIERED-CANDIDATE",
  role: "CANDIDATE",
  paperOnly: true,
  baseStrategy: "V1.2-FROZEN",
  degradationBudget: 1,
  // 降级时在 V1.2 的立即入场门槛之上额外要求的机会分，由降级权重换算。
  degradedEntryScoreScale: 8
});

const round = (value, digits = 1) => Number(Number(value).toFixed(digits));

/**
 * 入场几何沿用 V1.2 已公开的结构止损 + 波动止损 + 2.2R/2.8R 目标。
 * 这里是候选策略自己的实现（冻结源码不可修改），公式与 V1.2 一致，
 * 因此在数据完整时本候选与 Champion 给出相同的计划。
 */
export function buildCandidatePlan(side, currentPrice, timeframes) {
  if (!["LONG", "SHORT"].includes(side)) return null;
  const long = side === "LONG";
  const tf15m = timeframes["15m"];
  const tf1h = timeframes["1h"];
  if (!tf15m?.candles?.length || !Number.isFinite(Number(tf15m.atr14)) || !Number.isFinite(Number(tf1h?.atr14))) return null;
  const recent15m = tf15m.candles.slice(-10, -1);
  if (!recent15m.length) return null;
  const structuralStop = long
    ? Math.min(...recent15m.map((item) => item.low)) - tf15m.atr14 * 0.1
    : Math.max(...recent15m.map((item) => item.high)) + tf15m.atr14 * 0.1;
  const volatilityDistance = Math.max(tf15m.atr14 * 1.1, tf1h.atr14 * 0.55);
  const volatilityStop = long ? currentPrice - volatilityDistance : currentPrice + volatilityDistance;
  const stopLoss = long ? Math.min(structuralStop, volatilityStop) : Math.max(structuralStop, volatilityStop);
  const riskDistance = Math.abs(currentPrice - stopLoss);
  if (!(riskDistance > 0)) return null;
  const takeProfit = long
    ? [currentPrice + riskDistance * 2.2, currentPrice + riskDistance * 2.8]
    : [currentPrice - riskDistance * 2.2, currentPrice - riskDistance * 2.8];
  return {
    entryPrice: round(currentPrice),
    stopLoss: round(stopLoss),
    takeProfit: takeProfit.map((value) => round(value)),
    riskReward: [2.2, 2.8]
  };
}

function timeframesWithCandles(market) {
  return {
    "15m": summarizeTimeframe(market.kline15m, "15m"),
    "1h": summarizeTimeframe(market.kline1h, "1h")
  };
}

export function analyzeDataTiered(market, parameters = DATA_TIERED_PARAMETERS, config = PAPER_CONFIG) {
  const base = analyzeSnapshot(market, config);
  const quality = classifyDataQuality(base, market, {
    policy: DATA_POLICIES.TIERED_DEGRADED,
    degradationBudget: Number(parameters.degradationBudget ?? 1)
  });
  return applyTieredDataPolicy(base, market, quality, parameters, config);
}

/**
 * 把分级数据政策施加到一份已经算好的报告上。
 * 只有当 V1.2 唯一的阻拦理由是「可降级的数据缺失」时才可能把 WAIT 提升为方向决策，
 * 并且必须同时满足更高的机会分门槛和可构造的止损计划。
 */
export function applyTieredDataPolicy(base, market, quality, parameters = DATA_TIERED_PARAMETERS, config = PAPER_CONFIG) {
  const report = { ...base, dataPolicy: null };
  const scoreScale = Number(parameters.degradedEntryScoreScale ?? 8);
  const entryScoreBonus = quality.status === DATA_STATUS.DEGRADED
    ? Number((quality.degradationScore * scoreScale).toFixed(4))
    : 0;
  const requiredScore = config.minimumImmediateEntryScore + entryScoreBonus;
  const candidateDecision = base.candidateDecision;
  const winnerScore = Number(base.opportunities?.[candidateDecision]?.score ?? 0);

  const decisionActions = [];
  let decision = base.decision;
  let plan = base.plan;
  let riskGates = [...(base.riskGates ?? [])];

  if (quality.status === DATA_STATUS.BLOCKED) {
    decision = "WAIT";
    plan = { entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null };
    riskGates = [...new Set([...riskGates, ...quality.hardBlockReasons])];
    decisionActions.push("数据被判定为 DATA_BLOCKED，本轮禁止入场");
  } else if (base.decision === "WAIT" && ["LONG", "SHORT"].includes(candidateDecision)) {
    // V1.2 的 WAIT 可能来自数据门禁，也可能来自机会分不够。只有前者才可降级放行。
    const dataGateWasTheBlocker = (base.dataQuality?.failures ?? []).length > 0;
    if (dataGateWasTheBlocker && winnerScore >= requiredScore) {
      const rebuilt = buildCandidatePlan(candidateDecision, Number(base.currentPrice), timeframesWithCandles(market));
      if (rebuilt) {
        decision = candidateDecision;
        plan = rebuilt;
        // 数据门禁不再是硬拦截，但缺失事实必须继续记录在案。
        riskGates = riskGates.filter((item) => !(base.dataQuality?.failures ?? []).includes(item));
        decisionActions.push(`分级数据门禁：降级放行，机会分 ${winnerScore} ≥ 要求 ${round(requiredScore, 2)}`);
      } else {
        decisionActions.push("降级放行被拒：无法构造有效止损计划");
      }
    } else if (dataGateWasTheBlocker) {
      decisionActions.push(`降级放行被拒：机会分 ${winnerScore} < 降级后要求 ${round(requiredScore, 2)}`);
    }
  }

  report.decision = decision;
  report.plan = plan;
  report.riskGates = riskGates;
  report.entryAssessment = {
    ...base.entryAssessment,
    enterNow: decision !== "WAIT",
    missingConditions: decision !== "WAIT" ? [] : [...(base.entryAssessment?.missingConditions ?? []), ...decisionActions]
  };
  report.dataPolicy = {
    strategyVersion: parameters.version,
    role: parameters.role,
    baseStrategy: parameters.baseStrategy,
    status: quality.status,
    degradationScore: quality.degradationScore,
    riskMultiplier: quality.riskMultiplier,
    entryScoreBonus,
    requiredEntryScore: round(requiredScore, 4),
    missing: quality.missing,
    missingByTier: quality.missingByTier,
    historicallyUnavailableKeys: quality.historicallyUnavailableKeys,
    liveFailureKeys: quality.liveFailureKeys,
    staleKeys: quality.staleKeys,
    replayArchiveErrorKeys: quality.replayArchiveErrorKeys,
    actions: decisionActions,
    championDecisionUnchanged: base.decision,
    unavailableNeverSynthesized: true
  };
  report.dataQuality = {
    ...base.dataQuality,
    tieredStatus: quality.status,
    validForEntry: quality.status !== DATA_STATUS.BLOCKED
  };
  report.strategy = {
    ...base.strategy,
    version: parameters.version,
    role: "CANDIDATE",
    frozenChampionUnchanged: true
  };
  return report;
}
