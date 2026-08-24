import { CORE_MARKET_TASK_KEYS, MARKET_TASKS } from "./market-data.mjs";
import { MARKET_CONTEXT_LAYERS } from "./feature-registry.mjs";

const TASK_CONTEXT = Object.freeze({
  ticker: ["HTX_PUBLIC_FUTURES", "SHORT_TERM"],
  kline15m: ["HTX_PUBLIC_FUTURES", "SHORT_TERM"],
  kline1h: ["HTX_PUBLIC_FUTURES", "SHORT_TERM"],
  kline4h: ["HTX_PUBLIC_FUTURES", "MEDIUM_TERM"],
  kline1d: ["HTX_PUBLIC_FUTURES", "MEDIUM_TERM"],
  depth: ["HTX_PUBLIC_FUTURES", "EXECUTION"],
  fundingCurrent: ["HTX_PUBLIC_FUNDING", "SHORT_TERM"],
  fundingHistory: ["HTX_PUBLIC_FUNDING", "SHORT_TERM"],
  oiCurrent: ["HTX_PUBLIC_OI", "SHORT_TERM"],
  oiHistory: ["HTX_PUBLIC_OI", "MEDIUM_TERM"],
  eliteAccount: ["HTX_PUBLIC_ELITE_POSITIONING", "MEDIUM_TERM"],
  elitePosition: ["HTX_PUBLIC_ELITE_POSITIONING", "MEDIUM_TERM"],
  liquidations: ["HTX_PUBLIC_LIQUIDATIONS", "EXECUTION"],
  markPrice: ["HTX_PUBLIC_MARK_PRICE", "EXECUTION"],
  premium: ["HTX_PUBLIC_MARK_PRICE", "SHORT_TERM"],
  basis: ["HTX_PUBLIC_MARK_PRICE", "SHORT_TERM"],
  contractElements: ["HTX_PUBLIC_CONTRACT_METADATA", "EXECUTION"]
});

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const millis = number < 10_000_000_000 ? number * 1000 : number;
  return millis >= Date.UTC(2009, 0, 1) && millis <= Date.now() + 24 * 60 * 60 * 1000 ? millis : null;
}

// 每个 HTX 公开响应里真正代表时间的字段。以前的实现递归地把任何叫 `id` 的数字
// 都当成时间戳，于是请求号/订单号也会被算进覆盖范围。这里改成按 schema 显式声明：
// 只有在这些路径下的字段才可能是时间戳。
const TIMESTAMP_SCHEMA = Object.freeze({
  ticker: [["ts"], ["tick", "ts"], ["tick", "id"]],
  kline15m: [["ts"], ["data", "*", "id"]],
  kline1h: [["ts"], ["data", "*", "id"]],
  kline4h: [["ts"], ["data", "*", "id"]],
  kline1d: [["ts"], ["data", "*", "id"]],
  depth: [["ts"], ["tick", "ts"]],
  fundingCurrent: [["ts"], ["data", "funding_time"], ["data", "next_funding_time"]],
  fundingHistory: [["ts"], ["data", "data", "*", "funding_time"]],
  oiCurrent: [["ts"], ["data", "*", "ts"]],
  oiHistory: [["ts"], ["data", "tick", "*", "ts"]],
  eliteAccount: [["ts"], ["data", "list", "*", "ts"]],
  elitePosition: [["ts"], ["data", "list", "*", "ts"]],
  liquidations: [["ts"], ["data", "*", "created_at"], ["data", "data", "*", "created_at"]],
  markPrice: [["ts"], ["data", "*", "id"]],
  premium: [["ts"], ["data", "*", "id"]],
  basis: [["ts"], ["data", "*", "id"]],
  contractElements: [["ts"]]
});

function readSchemaPath(value, path, output) {
  if (value === null || value === undefined) return;
  if (!path.length) {
    const millis = timestampMs(value);
    if (millis !== null) output.push(millis);
    return;
  }
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return;
    for (const item of value) readSchemaPath(item, rest, output);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  readSchemaPath(value[head], rest, output);
}

export function collectProviderTimestamps(payload, sourceKey) {
  const output = [];
  for (const path of TIMESTAMP_SCHEMA[sourceKey] ?? [["ts"]]) readSchemaPath(payload, path, output);
  return output;
}

function coverage(payload, sourceKey) {
  const timestamps = collectProviderTimestamps(payload, sourceKey).sort((a, b) => a - b);
  if (!timestamps.length) return { start: null, end: null, providerUpdatedAt: null };
  return {
    start: new Date(timestamps[0]).toISOString(),
    end: new Date(timestamps.at(-1)).toISOString(),
    providerUpdatedAt: new Date(timestamps.at(-1)).toISOString()
  };
}

function hasPayload(payload) {
  if (payload === null || payload === undefined) return false;
  if (payload.status === "error") return false;
  return true;
}

export function buildDataSourceObservations(db, market, collectedAt) {
  return MARKET_TASKS.map(([sourceKey, skill, subcommand, params]) => {
    const [provider, layer] = TASK_CONTEXT[sourceKey];
    const missing = !hasPayload(market[sourceKey]);
    const prior = db.getDataSourceStats(sourceKey);
    const currentCoverage = missing
      ? { start: null, end: null, providerUpdatedAt: null }
      : coverage(market[sourceKey], sourceKey);
    return {
      sourceKey,
      provider,
      layer,
      collectedAt,
      providerUpdatedAt: currentCoverage.providerUpdatedAt,
      historicalCoverageStart: currentCoverage.start,
      historicalCoverageEnd: currentCoverage.end,
      missing,
      rollingMissingRate: (prior.missing + (missing ? 1 : 0)) / (prior.total + 1),
      qualityStatus: missing
        ? CORE_MARKET_TASK_KEYS.has(sourceKey) ? "MISSING_CORE" : "MISSING_SECONDARY"
        : "AVAILABLE",
      details: {
        skill,
        subcommand,
        publicOnly: true,
        parameters: params,
        priorSamples: prior.total,
        coverageClaim: currentCoverage.start ? "OBSERVED_RESPONSE_RANGE" : "NO_PROVIDER_HISTORY_RANGE_IN_RESPONSE"
      }
    };
  });
}

export function coreMarketDataFreshForTrading(report, market, { maxKlineAgeMs = 30 * 60 * 1000, maxTickerAgeMs = 5 * 60 * 1000 } = {}) {
  const generatedMs = new Date(report.generatedAt).getTime();
  const latestBarMs = Number(report.latest15mBar?.timestamp);
  if (!Number.isFinite(generatedMs) || !Number.isFinite(Number(report.currentPrice)) || Number(report.currentPrice) <= 0) return false;
  if (!Number.isFinite(latestBarMs) || generatedMs - latestBarMs > maxKlineAgeMs || latestBarMs > generatedMs + 60_000) return false;
  if (Object.hasOwn(market, "ticker")) {
    if (!hasPayload(market.ticker) || !Number.isFinite(Number(market.ticker?.tick?.close))) return false;
    const tickerMs = timestampMs(market.ticker?.ts ?? market.ticker?.tick?.ts);
    if (tickerMs !== null && generatedMs - tickerMs > maxTickerAgeMs) return false;
  }
  return true;
}

function timeframeFactor(report, timeframe, featureKey) {
  const item = report.timeframes?.[timeframe];
  if (!item) return null;
  const score = Number(item.score);
  const direction = score > 0 ? "偏多" : score < 0 ? "偏空" : "中性";
  return {
    featureKey,
    label: `${timeframe} 技术结构${direction}，方向强度 ${Math.abs(score)}/100`,
    observedAt: report.generatedAt,
    actuallyInfluencesDecision: true
  };
}

function derivativeFactors(report) {
  const factors = [];
  const derivatives = report.derivatives ?? {};
  if (Number.isFinite(Number(derivatives.directionalScore))) {
    const score = Number(derivatives.directionalScore);
    const direction = score > 0 ? "偏多" : score < 0 ? "偏空" : "中性";
    factors.push({
      featureKey: "htx_derivatives_pressure",
      label: `HTX 衍生品${direction}，方向强度 ${Math.abs(score)}/100；拥挤压力 ${derivatives.pressureScore ?? "—"}/100`,
      observedAt: report.generatedAt,
      actuallyInfluencesDecision: true
    });
  }
  const bookSignal = (derivatives.signals ?? []).find((item) => String(item.label).includes("Order Book"));
  if (bookSignal) factors.push({
    featureKey: "htx_order_book_top20",
    label: bookSignal.label,
    observedAt: report.generatedAt,
    actuallyInfluencesDecision: true
  });
  return factors;
}

export function attachMultiLayerMarketContext(db, report, market) {
  const registry = db.getFeatureRegistry();
  const enabledKeys = new Set(registry.filter((item) => item.status === "enabled" && Number(item.current_weight) > 0).map((item) => item.feature_key));
  const possibleFactors = [
    ["MEDIUM_TERM", timeframeFactor(report, "4h", "htx_4h_technical")],
    ["MEDIUM_TERM", timeframeFactor(report, "1d", "htx_1d_technical")],
    ["SHORT_TERM", timeframeFactor(report, "15m", "htx_15m_technical")],
    ["SHORT_TERM", timeframeFactor(report, "1h", "htx_1h_technical")],
    ...derivativeFactors(report).map((item) => [item.featureKey === "htx_order_book_top20" ? "EXECUTION" : "SHORT_TERM", item])
  ];
  const layers = Object.fromEntries(Object.entries(MARKET_CONTEXT_LAYERS).map(([key, definition]) => [key, {
    ...definition,
    activeFactors: possibleFactors.filter(([layer, factor]) => layer === key && factor && enabledKeys.has(factor.featureKey)).map(([, factor]) => factor),
    researchOnlyCount: registry.filter((item) => item.time_layer === key && item.status === "research-only").length
  }]));
  const observations = buildDataSourceObservations(db, market, report.generatedAt);
  const activeProductionFactors = Object.values(layers).flatMap((layer) => layer.activeFactors);
  return {
    report: {
      ...report,
      // `confidencePct` 是一个未经概率校准的分数，叫“置信度”会被误读成胜率。
      // 对外统一使用 signalQualityScore；confidencePct 作为 SQLite/旧 API 的兼容别名保留。
      signalQualityScore: report.confidencePct,
      multiLayerContext: {
        architecture: "MULTI_LAYER_MARKET_CONTEXT_V1",
        scoringImpact: "V1.2_FROZEN_CORE_ONLY",
        longTermMayTriggerIntradayTrade: false,
        layers,
        activeProductionFactors,
        researchOnlyFeatures: registry.filter((item) => item.status === "research-only").map((item) => ({
          featureKey: item.feature_key,
          name: item.display_name,
          layer: item.time_layer,
          weight: item.current_weight,
          source: item.data_source,
          status: item.status,
          reason: item.recent_validity
        })),
        note: "详细分析只展示本轮真正影响 V1.2 判断的 enabled 因素；研究指标未通过门禁前权重为0。"
      },
      dataSourceQuality: observations.map((item) => ({
        sourceKey: item.sourceKey,
        provider: item.provider,
        layer: item.layer,
        collectedAt: item.collectedAt,
        providerUpdatedAt: item.providerUpdatedAt,
        historicalCoverageStart: item.historicalCoverageStart,
        historicalCoverageEnd: item.historicalCoverageEnd,
        missingRate: item.rollingMissingRate,
        qualityStatus: item.qualityStatus
      }))
    },
    observations
  };
}
