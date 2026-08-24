import { PAPER_CONFIG } from "./config.mjs";
import { buildMultiScaleContext } from "./indicator-profiles.mjs";
import {
  closedMarketView,
  coreDataQuality,
  entryGeometry,
  RESEARCH_CHALLENGER_V2_PARAMETERS,
  tradableEdge
} from "./research-challenger-v2.mjs";
import { hashObject, round } from "./research-utils.mjs";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

export const MULTI_VENUE_CHALLENGER_V3_0_PARAMETERS = Object.freeze({
  ...RESEARCH_CHALLENGER_V2_PARAMETERS,
  version: "multi-venue-challenger-v3.0.0",
  minimumOpportunityScore: 61,
  minimumIndependentDirectionDimensions: 2,
  minimumDirectionalGap: 7,
  minimumNetTradableEdgePct: 0.18,
  minimumNetRr: 2,
  positionManagementProfile: "SWING_RUNNER_V1",
  breakEvenTargetFraction: 0.60,
  minimumBreakEvenR: 1.35,
  trailingTargetFraction: 0.78,
  minimumTrailingR: 1.75,
  minimumHoldBarsBeforeSignalExit: 8,
  oppositeSignalBarsForExit: 3,
  multiVenueResearchWeightEnabled: true,
  researchOnly: true
});

export const MULTI_VENUE_CHALLENGER_V3_1_PARAMETERS = Object.freeze({
  ...MULTI_VENUE_CHALLENGER_V3_0_PARAMETERS,
  version: "multi-venue-challenger-v3.1.0-target-aligned",
  plannedTargetNetRr: 2.15,
  breakEvenTargetFraction: 0.70,
  minimumBreakEvenR: 1.45,
  trailingTargetFraction: 0.90,
  minimumTrailingR: 1.90
});

// V3.1 was measured on the declared development range and was worse than V3.0
// (PF 0.4718 vs 0.4916).  Keep the rejected experiment reproducible, but do not
// silently make it the default candidate.
export const MULTI_VENUE_CHALLENGER_PARAMETERS = MULTI_VENUE_CHALLENGER_V3_0_PARAMETERS;

function middleRsi(frame) {
  const values = Object.values(frame?.rsi ?? {});
  return values[1] ?? values[0] ?? { value: 50, change: 0 };
}

function lastClosedCandle(frame) {
  return frame?.candles?.at(-1) ?? null;
}

function bucket(key, support, opposition, reasons = [], warnings = [], available = true) {
  return {
    key,
    support: round(clamp(support, 0, 30), 4),
    opposition: round(clamp(opposition, 0, 30), 4),
    reasons,
    warnings,
    available
  };
}

function longTrendEvidence(frames) {
  const h1 = frames["1h"];
  const h4 = frames["4h"];
  const d1 = frames["1d"];
  let support = 0;
  let opposition = 0;
  const reasons = [];
  const warnings = [];
  if (h4.ema.alignment > 0) { support += 9; reasons.push("4h EMA 多头排列"); }
  if (h1.ema.alignment > 0) { support += 6; reasons.push("1h EMA 多头排列"); }
  if (d1.ema.alignment > 0) { support += 4; reasons.push("日线 EMA 多头排列"); }
  if (h4.structure.direction > 0) { support += 6; reasons.push("4h 高低点结构抬升"); }
  if (h1.ema.mediumSlopePct > 0) support += clamp(h1.ema.mediumSlopePct * 2.5, 0, 4);
  if (h4.ema.alignment < 0) { opposition += 9; warnings.push("4h EMA 空头排列"); }
  if (h1.ema.alignment < 0) opposition += 6;
  if (d1.ema.alignment < 0) opposition += 4;
  if (h4.structure.direction < 0) opposition += 6;
  return bucket("trendStructure", support, opposition, reasons, warnings);
}

function shortTrendEvidence(frames) {
  const h1 = frames["1h"];
  const h4 = frames["4h"];
  const d1 = frames["1d"];
  let support = 0;
  let opposition = 0;
  const reasons = [];
  const warnings = [];
  if (h4.ema.alignment < 0) { support += 9; reasons.push("4h EMA 空头排列"); }
  if (h1.ema.alignment < 0) { support += 6; reasons.push("1h EMA 空头排列"); }
  if (d1.ema.alignment < 0) { support += 4; reasons.push("日线 EMA 空头排列"); }
  if (h4.structure.direction < 0) { support += 6; reasons.push("4h 高低点结构下移"); }
  if (h1.ema.mediumSlopePct < 0) support += clamp(-h1.ema.mediumSlopePct * 2.5, 0, 4);
  if (h4.ema.alignment > 0) { opposition += 9; warnings.push("4h EMA 多头排列"); }
  if (h1.ema.alignment > 0) opposition += 6;
  if (d1.ema.alignment > 0) opposition += 4;
  if (h4.structure.direction > 0) opposition += 6;
  return bucket("trendStructure", support, opposition, reasons, warnings);
}

function longMomentumEvidence(frames) {
  const m15 = frames["15m"].macd;
  const m1 = frames["1h"].macd;
  const rsi = middleRsi(frames["1h"]);
  let support = 0;
  let opposition = 0;
  const reasons = [];
  const warnings = [];
  if (m1.histogram > 0) { support += 6; reasons.push("1h MACD 柱为正"); }
  if (m1.change > 0) { support += 5; reasons.push("1h 动量边际改善"); }
  if (m15.change > 0) support += 3;
  if (rsi.value >= 42 && rsi.value <= 68) support += 4;
  if (rsi.value <= 35 && rsi.change > 0) { support += 5; reasons.push("1h RSI 超卖后回升"); }
  if (m1.histogram < 0) opposition += 6;
  if (m1.change < 0) opposition += 5;
  if (rsi.value >= 72 && rsi.change <= 0) { opposition += 6; warnings.push("1h RSI 高位转弱"); }
  return bucket("momentumProcess", support, opposition, reasons, warnings);
}

function shortMomentumEvidence(frames) {
  const m15 = frames["15m"].macd;
  const m1 = frames["1h"].macd;
  const rsi = middleRsi(frames["1h"]);
  let support = 0;
  let opposition = 0;
  const reasons = [];
  const warnings = [];
  if (m1.histogram < 0) { support += 6; reasons.push("1h MACD 柱为负"); }
  if (m1.change < 0) { support += 5; reasons.push("1h 动量边际走弱"); }
  if (m15.change < 0) support += 3;
  if (rsi.value >= 32 && rsi.value <= 58) support += 4;
  if (rsi.value >= 65 && rsi.change < 0) { support += 5; reasons.push("1h RSI 超买后回落"); }
  if (m1.histogram > 0) opposition += 6;
  if (m1.change > 0) opposition += 5;
  if (rsi.value <= 28 && rsi.change >= 0) { opposition += 6; warnings.push("1h RSI 低位转强"); }
  return bucket("momentumProcess", support, opposition, reasons, warnings);
}

function participationEvidence(frames, side) {
  const h1 = frames["1h"];
  const candle = lastClosedCandle(h1);
  if (!candle) return bucket("participation", 0, 0, [], ["1h 成交参与不可用"], false);
  const direction = Math.sign(candle.close - candle.open);
  const desired = side === "LONG" ? 1 : -1;
  const volumeRatio = Number(h1.volume.ratio20 ?? 0);
  const magnitude = clamp((volumeRatio - 0.75) * 10, 0, 10);
  const support = direction === desired ? magnitude : 0;
  const opposition = direction === -desired ? magnitude : 0;
  return bucket(
    "participation",
    support,
    opposition,
    support >= 3 ? [`1h ${side === "LONG" ? "上涨" : "下跌"}K线有成交参与`] : [],
    opposition >= 3 ? ["成交参与偏向反方向"] : []
  );
}

function derivativesEvidence(market, side) {
  const context = market.multiVenue?.funding;
  const direction = side === "LONG" ? 1 : -1;
  const multiRate = finite(context?.medianFundingRate) ? Number(context.medianFundingRate) : null;
  const htxRate = finite(market.fundingCurrent?.data?.funding_rate) ? Number(market.fundingCurrent.data.funding_rate) : null;
  const rate = multiRate ?? htxRate;
  if (!finite(rate)) return bucket("derivativesContext", 0, 0, [], ["Funding 历史不可用，未填充"], false);
  const venueCount = Number(context?.venueCount ?? (htxRate !== null ? 1 : 0));
  const signedCrowding = direction * rate;
  const magnitude = clamp(Math.abs(rate) / 0.0001 * 5, 0, 11);
  const support = signedCrowding < -0.000025 ? magnitude : 0;
  let opposition = signedCrowding > 0.000025 ? magnitude : 0;
  const dispersion = Number(context?.dispersionFundingRate ?? 0);
  if (finite(dispersion) && dispersion > 0.0002) opposition += 2;
  return bucket(
    "derivativesContext",
    support,
    opposition,
    support >= 3 ? [`${venueCount} 个可见场所 Funding 显示反向拥挤`] : [],
    opposition >= 3 ? [`${venueCount} 个可见场所 Funding 对该方向成本/拥挤不利`] : [],
    true
  );
}

function sideRead(side, buckets) {
  const available = buckets.filter((item) => item.available);
  const support = available.reduce((sum, item) => sum + item.support, 0);
  const opposition = available.reduce((sum, item) => sum + item.opposition, 0);
  const independentSupportCount = available.filter((item) => item.support >= 3.5).length;
  const independentOppositionCount = available.filter((item) => item.opposition >= 3.5).length;
  const availabilityPenalty = (4 - available.length) * 2;
  const score = clamp(28 + support - opposition * 0.72 - availabilityPenalty, 0, 100);
  return {
    side,
    opportunityScore: round(score, 2),
    rawSupport: round(support, 4),
    rawOpposition: round(opposition, 4),
    independentSupportCount,
    independentOppositionCount,
    availableDimensionCount: available.length,
    supportiveDimensions: available.filter((item) => item.support >= 3.5).map((item) => item.key),
    opposingDimensions: available.filter((item) => item.opposition >= 3.5).map((item) => item.key),
    reasons: available.flatMap((item) => item.reasons),
    warnings: available.flatMap((item) => item.warnings),
    buckets
  };
}

export function buildIndependentSideReads(context, market) {
  const longBuckets = [
    longTrendEvidence(context.frames),
    longMomentumEvidence(context.frames),
    participationEvidence(context.frames, "LONG"),
    derivativesEvidence(market, "LONG")
  ];
  const shortBuckets = [
    shortTrendEvidence(context.frames),
    shortMomentumEvidence(context.frames),
    participationEvidence(context.frames, "SHORT"),
    derivativesEvidence(market, "SHORT")
  ];
  return { LONG: sideRead("LONG", longBuckets), SHORT: sideRead("SHORT", shortBuckets) };
}

function eligible(read, parameters) {
  return read.opportunityScore >= parameters.minimumOpportunityScore
    && read.independentSupportCount >= parameters.minimumIndependentDirectionDimensions
    && read.independentSupportCount > read.independentOppositionCount;
}

function managementContract(targetR, parameters) {
  const usableTargetR = finite(targetR) ? Number(targetR) : parameters.minimumNetRr;
  return {
    profile: parameters.positionManagementProfile,
    targetR: round(usableTargetR, 4),
    breakEvenTriggerR: round(Math.max(parameters.minimumBreakEvenR, usableTargetR * parameters.breakEvenTargetFraction), 4),
    trailingTriggerR: round(Math.max(parameters.minimumTrailingR, usableTargetR * parameters.trailingTargetFraction), 4),
    minimumHoldBarsBeforeSignalExit: parameters.minimumHoldBarsBeforeSignalExit,
    oppositeSignalBarsForExit: parameters.oppositeSignalBarsForExit,
    hardStopAlwaysActive: true,
    hardTargetAlwaysActive: true,
    rationale: "2R+ 入场目标使用 runner 管理；不再在 1R 机械保本、1.5R 机械跟踪"
  };
}

function opportunity(read, selectedSide) {
  return {
    side: read.side,
    score: read.opportunityScore,
    opportunityScore: read.opportunityScore,
    scoreMeaning: "独立证据 Opportunity Score；不是胜率，LONG/SHORT 不互为补数",
    directionalScore: read.opportunityScore,
    timingScore: read.side === selectedSide ? 65 : 35,
    independentSupportCount: read.independentSupportCount,
    independentOppositionCount: read.independentOppositionCount,
    supportingReasons: read.reasons.slice(0, 6),
    opposingReasons: read.warnings.slice(0, 6)
  };
}

export function analyzeMultiVenueChallenger(market, parameters = MULTI_VENUE_CHALLENGER_PARAMETERS, config = PAPER_CONFIG, options = {}) {
  const now = Number(market.ticker?.ts);
  const currentPrice = Number(market.ticker?.tick?.close);
  if (!(now > 0) || !(currentPrice > 0)) throw new Error("Multi-venue Challenger requires point-in-time market time and price");
  const visibleMarket = closedMarketView(market);
  const context = buildMultiScaleContext(visibleMarket, options.indicatorProfile ?? parameters.indicatorProfile);
  const reads = buildIndependentSideReads(context, visibleMarket);
  const longEligible = eligible(reads.LONG, parameters);
  const shortEligible = eligible(reads.SHORT, parameters);
  const gap = Math.abs(reads.LONG.opportunityScore - reads.SHORT.opportunityScore);
  let candidateDecision = "WAIT";
  if (longEligible && !shortEligible) candidateDecision = "LONG";
  else if (shortEligible && !longEligible) candidateDecision = "SHORT";
  else if ((longEligible || shortEligible) && gap >= parameters.minimumDirectionalGap) {
    candidateDecision = reads.LONG.opportunityScore > reads.SHORT.opportunityScore ? "LONG" : "SHORT";
  }
  const selected = candidateDecision === "WAIT" ? null : reads[candidateDecision];
  const dataQuality = coreDataQuality(visibleMarket, context);
  let geometry = selected ? entryGeometry(candidateDecision, context, visibleMarket, parameters) : null;
  const edge = geometry ? tradableEdge(candidateDecision, geometry, context, visibleMarket, config, parameters, options.similarity) : null;
  const riskDistance = Number(geometry?.riskDistance ?? 0);
  let rawRr = riskDistance > 0 ? Number(geometry.remainingSpace) / riskDistance : null;
  const costPct = edge ? edge.feesPct + edge.slippagePct + edge.fundingPct + edge.executionCostPct + edge.uncertaintyBufferPct : 0;
  const costDistance = currentPrice * costPct / 100;
  let netRr = riskDistance + costDistance > 0
    ? Math.max(0, Number(geometry?.remainingSpace ?? 0) - costDistance) / (riskDistance + costDistance)
    : null;
  if (geometry && finite(parameters.plannedTargetNetRr) && finite(netRr)
    && netRr > Number(parameters.plannedTargetNetRr)) {
    const direction = candidateDecision === "LONG" ? 1 : -1;
    const alignedRewardDistance = Number(parameters.plannedTargetNetRr) * (riskDistance + costDistance) + costDistance;
    if (alignedRewardDistance > 0 && alignedRewardDistance < geometry.remainingSpace) {
      geometry = {
        ...geometry,
        originalStructureTakeProfit: geometry.takeProfit,
        originalStructureRemainingSpace: geometry.remainingSpace,
        takeProfit: currentPrice + direction * alignedRewardDistance,
        remainingSpace: alignedRewardDistance,
        targetSource: `NET_RR_ALIGNED_WITHIN_${geometry.targetSource}`,
        plannedTargetNetRr: Number(parameters.plannedTargetNetRr)
      };
      rawRr = alignedRewardDistance / riskDistance;
      netRr = Number(parameters.plannedTargetNetRr);
    }
  }
  const entryAllowed = Boolean(selected && dataQuality.validForEntry && geometry.enterable
    && edge.netTradableEdgePct >= parameters.minimumNetTradableEdgePct && netRr >= parameters.minimumNetRr);
  const decision = entryAllowed ? candidateDecision : "WAIT";
  const missingConditions = [];
  if (!dataQuality.validForEntry) missingConditions.push(...dataQuality.failures);
  if (!selected) missingConditions.push("LONG/SHORT 独立证据、支持维度或方向差尚未同时达标");
  if (geometry && !geometry.enterable) missingConditions.push(geometry.method === "WAIT_PRICE_EXTENDED" ? "价格过度延伸，拒绝追价" : "等待更好的入场几何");
  if (edge && edge.netTradableEdgePct < parameters.minimumNetTradableEdgePct) missingConditions.push(`净可交易优势 ${edge.netTradableEdgePct}% 低于 ${parameters.minimumNetTradableEdgePct}%`);
  if (finite(netRr) && netRr < parameters.minimumNetRr) missingConditions.push(`成本后净 RR ${round(netRr, 3)} 低于 ${parameters.minimumNetRr}`);
  const contract = managementContract(netRr ?? rawRr, parameters);
  const riskPct = entryAllowed
    ? (selected.opportunityScore >= 76 ? config.maxRiskPerTradePct : config.reducedRiskPerTradePct)
    : 0;
  const timeframes = Object.fromEntries(Object.entries(context.frames).map(([key, frame]) => [key, {
    score: null,
    close: frame.close,
    ema20: frame.ema.medium,
    ema50: frame.ema.slow,
    ema20SlopePct: frame.ema.mediumSlopePct,
    rsi14: middleRsi(frame).value,
    atr14: frame.atr.value,
    adx14: frame.adx,
    macdHistogram: frame.macd.histogram,
    momentum20Pct: frame.naturalReturnsPct.day1,
    volumeRatio: frame.volume.ratio20
  }]));
  return {
    version: parameters.version,
    strategyHash: hashObject(parameters),
    mode: "MULTI_VENUE_CHALLENGER_V3_SHADOW_PAPER_ONLY",
    symbol: "BTC-USDT",
    generatedAt: new Date(now).toISOString(),
    currentPrice: round(currentPrice, 2),
    decision,
    candidateDecision,
    directionState: selected ? `${selected.opportunityScore >= 76 ? "STRONG" : "LEAN"}_${selected.side}` : "NEUTRAL",
    confidencePct: 0,
    scoreTerminology: "INDEPENDENT_OPPORTUNITY_SCORE_NOT_PROBABILITY",
    finalScore: round(reads.LONG.opportunityScore - reads.SHORT.opportunityScore, 2),
    riskGates: dataQuality.failures,
    plan: entryAllowed ? {
      entryPrice: round(currentPrice, 2),
      stopLoss: round(geometry.stopLoss, 2),
      takeProfit: [round(geometry.takeProfit, 2)],
      riskReward: [round(rawRr, 4)],
      netRiskReward: [round(netRr, 4)],
      targetSource: geometry.targetSource,
      managementContract: contract
    } : {
      entryPrice: null, stopLoss: null, takeProfit: null, riskReward: null, netRiskReward: null,
      targetSource: geometry?.targetSource ?? null, managementContract: contract
    },
    entryAssessment: {
      enterNow: entryAllowed,
      method: geometry?.method ?? "NO_DIRECTION",
      methodLabel: geometry?.method ?? "独立多空证据未达标",
      reasons: [...(selected?.reasons ?? []), edge ? `净可交易优势 ${edge.netTradableEdgePct}%` : null].filter(Boolean).slice(0, 6),
      missingConditions,
      riskPct
    },
    opportunities: {
      LONG: opportunity(reads.LONG, candidateDecision),
      SHORT: opportunity(reads.SHORT, candidateDecision)
    },
    scores: {
      longOpportunity: reads.LONG.opportunityScore,
      shortOpportunity: reads.SHORT.opportunityScore,
      scoreGap: round(gap, 2),
      independent: true,
      constantSumInvariant: false,
      sides: reads
    },
    strategy: {
      version: parameters.version,
      marketRegime: context.regime.primary,
      volatilityRegime: context.regime.volatility,
      indicatorProfile: context.profile.selected,
      bias: candidateDecision,
      state: entryAllowed ? "ENTER_NOW" : "WAIT",
      riskPct,
      riskTier: selected?.opportunityScore >= 76 ? "NORMAL" : "REDUCED",
      hardBlocks: dataQuality.failures,
      softWarnings: missingConditions,
      entryMethod: geometry?.method ?? "NO_DIRECTION",
      positionManagementProfile: parameters.positionManagementProfile,
      managementContract: contract,
      crossVenueProductionWeight: market.multiVenue?.funding?.venueCount >= 2 ? "RESEARCH_CANDIDATE" : 0,
      directionEntryRiskSeparated: true,
      frozenChampionModified: false
    },
    entryGeometry: geometry,
    tradableEdge: edge ? { estimates: { [candidateDecision]: edge }, selected: edge, minimumNetTradableEdgePct: parameters.minimumNetTradableEdgePct } : null,
    timeframes,
    multiScaleContext: { profile: context.profile, regime: context.regime },
    derivatives: {
      fundingRatePct: finite(visibleMarket.fundingCurrent?.data?.funding_rate) ? Number(visibleMarket.fundingCurrent.data.funding_rate) * 100 : null,
      fundingSource: visibleMarket.fundingCurrent?.data?.source ?? "UNAVAILABLE_NOT_FILLED",
      oiUsd: finite(visibleMarket.oiCurrent?.data?.[0]?.value) ? Number(visibleMarket.oiCurrent.data[0].value) : null,
      pressureScore: null,
      multiVenueFunding: visibleMarket.multiVenue?.funding ?? null
    },
    bullishReasons: reads.LONG.reasons,
    bearishReasons: reads.SHORT.reasons,
    dataQuality,
    historicalCompatibility: {
      compatible: Boolean(market.replay),
      usesOnlyPointInTimeFeatures: Boolean(market.replay),
      allowedSources: ["HTX closed OHLCV", "timestamp-visible HTX Funding", "timestamp-visible multi-venue realized Funding"],
      futureDataFilled: false
    },
    safety: { apiKeyUsed: false, privateEndpointUsed: false, exchangeWriteEnabled: false, paperTradingOnly: true }
  };
}
