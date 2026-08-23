export const MARKET_CONTEXT_LAYERS = Object.freeze({
  LONG_TERM: Object.freeze({
    label: "LONG-TERM",
    purpose: "长期估值、周期与风险背景",
    allowedEffects: ["BACKGROUND", "RISK_MULTIPLIER"],
    forbiddenEffects: ["INTRADAY_DIRECTION", "ENTRY_TRIGGER", "EXIT_TRIGGER"]
  }),
  MEDIUM_TERM: Object.freeze({
    label: "MEDIUM-TERM",
    purpose: "波段方向与市场状态",
    allowedEffects: ["SWING_BIAS", "RISK_MULTIPLIER"],
    forbiddenEffects: ["EXECUTION_TRIGGER"]
  }),
  SHORT_TERM: Object.freeze({
    label: "SHORT-TERM",
    purpose: "分钟/小时级机会和入场时机",
    allowedEffects: ["DIRECTION", "ENTRY_TIMING", "POSITION_MANAGEMENT"],
    forbiddenEffects: []
  }),
  EXECUTION: Object.freeze({
    label: "EXECUTION",
    purpose: "成交质量、流动性、滑点与执行风险",
    allowedEffects: ["ENTRY_QUALITY", "SLIPPAGE", "EXECUTION_VETO"],
    forbiddenEffects: ["STANDALONE_DIRECTION"]
  })
});

const enabled = ({ key, name, source, layer, weight, regimes, horizon, note }) => Object.freeze({
  key,
  name,
  source,
  layer,
  currentWeight: weight,
  applicableRegimes: regimes,
  historicalCoverageStart: null,
  historicalCoverageEnd: null,
  predictionHorizon: horizon,
  oosIncrementalContribution: null,
  recentValidity: "V1.2_INHERITED_PRODUCTION_FEATURE",
  status: "enabled",
  evidence: {
    policy: "INHERITED_V1_2_FROZEN_CORE",
    note: `${note}。本轮架构升级不改变该特征原有生产逻辑或权重。`
  }
});

const research = ({ key, name, source = "NOT_CONNECTED", layer, horizon, note }) => Object.freeze({
  key,
  name,
  source,
  layer,
  currentWeight: 0,
  applicableRegimes: ["RESEARCH_PENDING"],
  historicalCoverageStart: null,
  historicalCoverageEnd: null,
  predictionHorizon: horizon,
  oosIncrementalContribution: null,
  recentValidity: "NO_VALIDATED_DATASET_OR_OOS_EVIDENCE",
  status: "research-only",
  evidence: {
    policy: "NEW_FEATURE_REQUIRES_STRICT_OOS_WALK_FORWARD_INCREMENTAL_TEST",
    note
  }
});

export const FEATURE_REGISTRY_SEEDS = Object.freeze([
  enabled({ key: "htx_15m_technical", name: "15分钟技术结构", source: "HTX_PUBLIC_KLINE", layer: "SHORT_TERM", weight: 0.25, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "15m-4h", note: "EMA、RSI、MACD、量能等综合，不允许单指标一票决定" }),
  enabled({ key: "htx_1h_technical", name: "1小时技术结构", source: "HTX_PUBLIC_KLINE", layer: "SHORT_TERM", weight: 0.35, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "1h-12h", note: "V1.2 动态方向与时机核心" }),
  enabled({ key: "htx_4h_technical", name: "4小时技术结构", source: "HTX_PUBLIC_KLINE", layer: "MEDIUM_TERM", weight: 0.3, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "4h-3d", note: "主要参与波段方向" }),
  enabled({ key: "htx_1d_technical", name: "日线技术背景", source: "HTX_PUBLIC_KLINE", layer: "MEDIUM_TERM", weight: 0.1, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "1d-2w", note: "仅作为现有中期背景的一部分" }),
  enabled({ key: "htx_derivatives_pressure", name: "HTX Funding/OI/多空持仓/清算/Basis 综合", source: "HTX_PUBLIC_DERIVATIVES", layer: "SHORT_TERM", weight: 1, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "1h-24h", note: "衍生品为综合辅助证据，单项不机械否决方向" }),
  enabled({ key: "htx_order_book_top20", name: "HTX Order Book 前20档", source: "HTX_PUBLIC_ORDER_BOOK", layer: "EXECUTION", weight: 1, regimes: ["TRENDING", "RANGING", "MIXED"], horizon: "minutes", note: "仅参与当前 V1.2 执行质量，不作为独立方向触发器" }),
  research({ key: "btc_rainbow_valuation", name: "Bitcoin Rainbow Chart 类长期估值", layer: "LONG_TERM", horizon: "months-years", note: "模型定义、参数版本和完整历史尚未锁定；不得用当前数据回填历史" }),
  research({ key: "btc_200_week_ma", name: "BTC 200周均线", layer: "LONG_TERM", horizon: "months-years", note: "需要可复现周线历史、缺失审计和严格增量检验" }),
  research({ key: "btc_realized_price_mvrv", name: "Realized Price / MVRV", layer: "LONG_TERM", horizon: "weeks-months", note: "需要授权或公开可复现链上历史，未接入前不参与评分" }),
  research({ key: "btc_onchain_context", name: "链上市场背景", layer: "MEDIUM_TERM", horizon: "days-weeks", note: "指标定义与数据源尚未选择，禁止挑选性回填" }),
  research({ key: "btc_options_context", name: "BTC 期权波动率/偏度/期限结构", layer: "MEDIUM_TERM", horizon: "hours-weeks", note: "需要可靠期权历史和时间对齐后再验证" }),
  research({ key: "cross_exchange_derivatives", name: "跨交易所 Funding/OI/Basis", layer: "SHORT_TERM", horizon: "hours-days", note: "需要逐源时间戳、历史覆盖和缺失率审计，未验证前权重为0" }),
  research({ key: "cross_market_liquidity", name: "跨市场流动性背景", layer: "MEDIUM_TERM", horizon: "days-weeks", note: "需要无前视偏差的发布时间与修订记录" }),
  research({ key: "macro_market_context", name: "宏观市场背景", layer: "LONG_TERM", horizon: "weeks-months", note: "宏观发布时间、修订值与可交易时点必须严格对齐；长期层不得触发分钟级交易" })
]);

export const FEATURE_VALIDATION_POLICY = Object.freeze({
  minimumHistoricalSamples: 1_000,
  minimumOutOfSampleTrades: 100,
  minimumWalkForwardWindows: 4,
  minimumPositiveWindows: 3,
  minimumNetSharpeDelta: 0.05,
  minimumNetProfitFactorDelta: 0,
  requireCostsIncluded: true,
  requireNoLookaheadAudit: true,
  requireMissingDataPolicy: true,
  requirePurging: true,
  minimumEmbargoBars: 1,
  requireVersionedDataManifest: true,
  requireFeatureCodeHash: true
});

export const SHADOW_VALIDATION_POLICY = Object.freeze({
  minimumCalendarDays: 30,
  minimumSignals: 100,
  maximumMissingRate: 0.05,
  requirePaperOnly: true,
  requireChampionUnaffected: true,
  requireCostsIncluded: true
});

export function validatePromotionEvidence(evidence, policy = FEATURE_VALIDATION_POLICY) {
  const reasons = [];
  if (Number(evidence?.historicalSamples) < policy.minimumHistoricalSamples) reasons.push(`历史样本少于 ${policy.minimumHistoricalSamples}`);
  if (Number(evidence?.outOfSampleTrades) < policy.minimumOutOfSampleTrades) reasons.push(`样本外交易少于 ${policy.minimumOutOfSampleTrades}`);
  if (Number(evidence?.walkForwardWindows) < policy.minimumWalkForwardWindows) reasons.push(`walk-forward 窗口少于 ${policy.minimumWalkForwardWindows}`);
  if (Number(evidence?.positiveWindows) < policy.minimumPositiveWindows) reasons.push(`正增益窗口少于 ${policy.minimumPositiveWindows}`);
  if (Number(evidence?.netSharpeDelta) < policy.minimumNetSharpeDelta) reasons.push("扣除成本后的风险调整增益不足");
  if (Number(evidence?.netProfitFactorDelta) < policy.minimumNetProfitFactorDelta) reasons.push("Profit Factor 增量为负");
  if (policy.requireCostsIncluded && evidence?.costsIncluded !== true) reasons.push("未证明已计入手续费、Funding 和滑点");
  if (policy.requireNoLookaheadAudit && evidence?.noLookaheadAudit !== true) reasons.push("未通过前视偏差审计");
  if (policy.requireMissingDataPolicy && evidence?.missingDataPolicyTested !== true) reasons.push("未测试缺失数据策略");
  if (policy.requirePurging && evidence?.purgingApplied !== true) reasons.push("未在重叠标签/预测期之间执行 Purging");
  if (Number(evidence?.embargoBars) < policy.minimumEmbargoBars) reasons.push("样本外边界缺少 Embargo");
  if (policy.requireVersionedDataManifest && !String(evidence?.dataManifestHash ?? "").trim()) reasons.push("缺少不可变数据清单哈希");
  if (policy.requireFeatureCodeHash && !String(evidence?.featureCodeHash ?? "").trim()) reasons.push("缺少特征代码版本哈希");
  if (!String(evidence?.candidateVersion ?? "").trim()) reasons.push("缺少候选版本号");
  if (!evidence?.trainEnd || !evidence?.testStart || new Date(evidence.trainEnd) >= new Date(evidence.testStart)) reasons.push("训练集与严格样本外区间未正确分离");
  return { passed: reasons.length === 0, reasons, policy };
}

export function validateShadowEvidence(evidence, policy = SHADOW_VALIDATION_POLICY) {
  const reasons = [];
  if (Number(evidence?.calendarDays) < policy.minimumCalendarDays) reasons.push(`Shadow Paper 少于 ${policy.minimumCalendarDays} 天`);
  if (Number(evidence?.signals) < policy.minimumSignals) reasons.push(`Shadow 信号少于 ${policy.minimumSignals}`);
  if (Number(evidence?.missingRate) > policy.maximumMissingRate) reasons.push("Shadow 数据缺失率过高");
  if (policy.requirePaperOnly && evidence?.paperOnly !== true) reasons.push("Shadow 验证不是严格 Paper-only");
  if (policy.requireChampionUnaffected && evidence?.championUnaffected !== true) reasons.push("Shadow 曾影响 Champion 决策");
  if (policy.requireCostsIncluded && evidence?.costsIncluded !== true) reasons.push("Shadow 绩效未计入全部交易成本");
  if (!(Number(evidence?.netRiskAdjustedContribution) > 0)) reasons.push("Shadow 成本后风险调整增量不为正");
  return { passed: reasons.length === 0, reasons, policy };
}

export function assertLayerEffectAllowed(layer, effect) {
  const definition = MARKET_CONTEXT_LAYERS[layer];
  if (!definition) throw new Error(`未知市场环境层：${layer}`);
  if (definition.forbiddenEffects.includes(effect)) throw new Error(`${layer} 层禁止作用于 ${effect}`);
  if (!definition.allowedEffects.includes(effect)) throw new Error(`${layer} 层未授权作用于 ${effect}`);
  return true;
}
