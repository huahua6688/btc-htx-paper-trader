// 分级数据质量门禁。
//
// 冻结的 V1.2 Champion 把 Order Book / Funding / OI / 精英多空比 / Mark-Basis 中
// 任何一项缺失都当成硬门禁，于是「一个次要公开接口抖动」等于「整个系统停止交易」，
// 历史回放里也因为根本不存在时点盘口档案而全部变成 WAIT。
//
// 本模块只做分类和评级，不改变任何策略判断。是否据此放行由调用方的 policy 决定：
//   FROZEN_V12_STRICT —— 复现冻结 Champion 的行为，任何一项缺失都 BLOCKED（默认）。
//   TIERED_DEGRADED   —— 新候选策略使用的分级降级政策。
//
// 缺失来源必须区分：
//   LIVE_FAILURE            实时公开接口失败，属于运行时风险。
//   HISTORICAL_UNAVAILABLE  该时点历史档案天然不存在，绝不允许用现在的值回填。
// 两者都不会被伪造，但对交易的含义完全不同。

export const DATA_TIERS = Object.freeze({
  CRITICAL: "CRITICAL",
  IMPORTANT: "IMPORTANT",
  AUXILIARY: "AUXILIARY"
});

export const DATA_POLICIES = Object.freeze({
  FROZEN_V12_STRICT: "FROZEN_V12_STRICT",
  TIERED_DEGRADED: "TIERED_DEGRADED"
});

export const DATA_STATUS = Object.freeze({
  OK: "DATA_OK",
  DEGRADED: "DATA_DEGRADED",
  BLOCKED: "DATA_BLOCKED"
});

export const PROVENANCE = Object.freeze({
  LIVE_FAILURE: "LIVE_FAILURE",
  HISTORICAL_UNAVAILABLE: "HISTORICAL_UNAVAILABLE"
});

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

// 每一项缺失带来的降级权重。累计权重达到 1 表示「剩余证据已不足以安全判断方向」。
const CHECKS = Object.freeze([
  {
    key: "price",
    tier: DATA_TIERS.CRITICAL,
    label: "当前价格",
    weight: 1,
    present: (report) => finite(report.currentPrice) && Number(report.currentPrice) > 0
  },
  {
    key: "kline15m",
    tier: DATA_TIERS.CRITICAL,
    label: "15 分钟 K 线新鲜度",
    weight: 1,
    present: (report) => {
      const barTs = Number(report.latest15mBar?.timestamp);
      const generatedMs = new Date(report.generatedAt).getTime();
      if (!Number.isFinite(barTs) || !Number.isFinite(generatedMs)) return false;
      return generatedMs - barTs <= 30 * 60 * 1000;
    }
  },
  {
    key: "higherTimeframes",
    tier: DATA_TIERS.CRITICAL,
    label: "1h/4h/1d 结构",
    weight: 1,
    present: (report) => ["1h", "4h", "1d"].every((key) => finite(report.timeframes?.[key]?.close))
  },
  {
    key: "orderBook",
    tier: DATA_TIERS.IMPORTANT,
    label: "Order Book 盘口",
    weight: 0.45,
    present: (report) => finite(report.derivatives?.orderBook?.bestBid) && finite(report.derivatives?.orderBook?.bestAsk)
  },
  {
    key: "funding",
    tier: DATA_TIERS.IMPORTANT,
    label: "Funding 费率",
    weight: 0.4,
    present: (report) => finite(report.derivatives?.fundingRatePct)
  },
  {
    key: "openInterest",
    tier: DATA_TIERS.AUXILIARY,
    label: "Open Interest",
    weight: 0.25,
    present: (report) => finite(report.derivatives?.oiUsd)
  },
  {
    key: "elitePositioning",
    tier: DATA_TIERS.AUXILIARY,
    label: "精英多空比",
    weight: 0.2,
    present: (report) => finite(report.derivatives?.eliteAccountRatio) && finite(report.derivatives?.elitePositionRatio)
  },
  {
    key: "markBasis",
    tier: DATA_TIERS.AUXILIARY,
    label: "Mark Price / Basis",
    weight: 0.2,
    present: (report) => finite(report.derivatives?.markPrice) && finite(report.derivatives?.basisPct)
  },
  {
    key: "pressureComponents",
    tier: DATA_TIERS.AUXILIARY,
    label: "衍生品拥挤度分项",
    weight: 0.2,
    present: (report) => Number(report.derivatives?.pressureComponentsAvailable ?? 0) >= 3
  }
]);

export const DATA_QUALITY_CHECKS = Object.freeze(CHECKS.map(({ key, tier, label, weight }) => ({ key, tier, label, weight })));

// 缺失来源判定：回放时点没有档案 vs 实时接口失败。绝不因为「历史没有」就用当前值回填。
function resolveProvenance(key, report, market) {
  // 回放里 report.replay 可能要等策略跑完才被填上，因此也要看行情快照自己的
  // point-in-time 标记，否则「历史天然无档案」会被误标成「实时接口失败」。
  const replay = report.replay ?? market?.replay ?? null;
  const replayUnavailable = replay?.unavailableSources;
  if (Array.isArray(replayUnavailable) && replayUnavailable.length) {
    return PROVENANCE.HISTORICAL_UNAVAILABLE;
  }
  if (replay?.pointInTime || replay?.visibleAt !== undefined) return PROVENANCE.HISTORICAL_UNAVAILABLE;
  const warnings = market?.collectionWarnings;
  if (Array.isArray(warnings) && warnings.some((item) => String(item).startsWith(`${key}:`))) {
    return PROVENANCE.LIVE_FAILURE;
  }
  return PROVENANCE.LIVE_FAILURE;
}

/**
 * 对当轮报告做分级数据质量评估。纯函数，不改动 report。
 *
 * @param {object} report 冻结 V1.2 分析引擎的输出
 * @param {object} market 原始行情快照（用于区分实时失败与历史缺失）
 * @param {object} options policy 与降级预算
 */
export function classifyDataQuality(report, market = {}, {
  policy = DATA_POLICIES.FROZEN_V12_STRICT,
  degradationBudget = 1
} = {}) {
  const missing = [];
  const present = [];
  for (const check of CHECKS) {
    let ok = false;
    try {
      ok = Boolean(check.present(report));
    } catch {
      ok = false;
    }
    const entry = { key: check.key, tier: check.tier, label: check.label, weight: check.weight };
    if (ok) present.push(entry);
    else missing.push({ ...entry, provenance: resolveProvenance(check.key, report, market) });
  }

  const missingCritical = missing.filter((item) => item.tier === DATA_TIERS.CRITICAL);
  const missingImportant = missing.filter((item) => item.tier === DATA_TIERS.IMPORTANT);
  const missingAuxiliary = missing.filter((item) => item.tier === DATA_TIERS.AUXILIARY);
  const degradationScore = Number(missing
    .filter((item) => item.tier !== DATA_TIERS.CRITICAL)
    .reduce((sum, item) => sum + item.weight, 0)
    .toFixed(6));

  const hardBlockReasons = [];
  for (const item of missingCritical) hardBlockReasons.push(`核心数据缺失：${item.label}`);

  let status;
  if (missingCritical.length) {
    status = DATA_STATUS.BLOCKED;
  } else if (policy === DATA_POLICIES.FROZEN_V12_STRICT) {
    // 严格政策下，只要 V1.2 原本会拦截的任何一项缺失，就保持 BLOCKED，
    // 这样冻结 Champion 的行为在升级后仍然逐字节可复现。
    status = missing.length ? DATA_STATUS.BLOCKED : DATA_STATUS.OK;
    if (missing.length) {
      for (const item of missing) hardBlockReasons.push(`冻结 V1.2 严格数据门禁：${item.label}不可用`);
    }
  } else if (degradationScore >= degradationBudget) {
    status = DATA_STATUS.BLOCKED;
    hardBlockReasons.push(`剩余证据不足以安全判断方向（降级权重 ${degradationScore} ≥ ${degradationBudget}）`);
  } else {
    status = missing.length ? DATA_STATUS.DEGRADED : DATA_STATUS.OK;
  }

  // 降级时收缩风险预算并提高入场质量门槛，而不是直接一票否决。
  const riskMultiplier = status === DATA_STATUS.BLOCKED
    ? 0
    : Number(Math.max(0.25, 1 - degradationScore * 0.6).toFixed(6));
  const entryScoreBonus = status === DATA_STATUS.DEGRADED
    ? Number((degradationScore * 8).toFixed(4))
    : 0;

  return {
    policy,
    status,
    degradationScore,
    degradationBudget,
    riskMultiplier,
    entryScoreBonus,
    missing,
    present,
    missingKeys: missing.map((item) => item.key),
    missingByTier: {
      CRITICAL: missingCritical.map((item) => item.key),
      IMPORTANT: missingImportant.map((item) => item.key),
      AUXILIARY: missingAuxiliary.map((item) => item.key)
    },
    historicallyUnavailableKeys: missing
      .filter((item) => item.provenance === PROVENANCE.HISTORICAL_UNAVAILABLE)
      .map((item) => item.key),
    liveFailureKeys: missing
      .filter((item) => item.provenance === PROVENANCE.LIVE_FAILURE)
      .map((item) => item.key),
    hardBlockReasons,
    unavailableNeverSynthesized: true
  };
}

export function formatDataQuality(quality) {
  const missing = quality.missing.length
    ? quality.missing.map((item) => `${item.label}(${item.tier === DATA_TIERS.CRITICAL ? "核心" : item.tier === DATA_TIERS.IMPORTANT ? "重要" : "辅助"}/${item.provenance === PROVENANCE.HISTORICAL_UNAVAILABLE ? "历史无档案" : "实时失败"})`).join("、")
    : "无";
  return `${quality.status}｜缺失：${missing}｜降级权重 ${quality.degradationScore}｜风险系数 ${quality.riskMultiplier}`;
}
