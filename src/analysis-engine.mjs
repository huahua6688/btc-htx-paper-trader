import { adx, atr, clamp, ema, macd, mean, percentChange, percentileRank, rsi } from "./indicators.mjs";
import { PAPER_CONFIG } from "./config.mjs";

const TIMEFRAME_WEIGHTS = Object.freeze({ "15m": 0.25, "1h": 0.35, "4h": 0.3, "1d": 0.1 });

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function candlesFrom(payload) {
  return (payload?.data ?? []).map((item) => ({
    timestamp: Number(item.id) * 1000,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: Number(item.amount ?? item.vol ?? 0)
  })).filter((item) => [item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function addSignal(signals, score, label) {
  signals.push({ score, label });
  return score;
}

export function summarizeTimeframe(payload, label) {
  const candles = candlesFrom(payload);
  if (candles.length < 60) throw new Error(`${label} K-line history is too short`);
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  const close = closes.at(-1);
  const ema20Line = ema(closes, 20);
  const ema50Line = ema(closes, 50);
  const ema20 = ema20Line.at(-1);
  const ema50 = ema50Line.at(-1);
  const ema20SlopePct = percentChange(ema20, ema20Line.at(-6));
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const adx14 = adx(candles, 14);
  const macdValue = macd(closes);
  const momentum20 = percentChange(close, closes.at(-21));
  const priorVolumes = volumes.slice(-21, -1);
  const volumeRatio = priorVolumes.length ? volumes.at(-1) / mean(priorVolumes) : null;
  const signals = [];
  let score = 0;

  score += addSignal(signals, ema20 > ema50 ? 18 : -18, `${label} EMA20 ${ema20 > ema50 ? "高于" : "低于"} EMA50`);
  score += addSignal(signals, close > ema20 ? 12 : -12, `${label} 收盘价 ${close > ema20 ? "站上" : "跌破"} EMA20`);

  if (rsi14 >= 70) score += addSignal(signals, -8, `${label} RSI ${round(rsi14, 1)}，短线过热`);
  else if (rsi14 >= 55) score += addSignal(signals, 10, `${label} RSI ${round(rsi14, 1)}，动能偏多`);
  else if (rsi14 <= 30) score += addSignal(signals, 2, `${label} RSI ${round(rsi14, 1)}，超卖但仍需确认止跌`);
  else if (rsi14 < 45) score += addSignal(signals, -10, `${label} RSI ${round(rsi14, 1)}，动能偏空`);

  if (macdValue) score += addSignal(signals, macdValue.histogram >= 0 ? 12 : -12, `${label} MACD 柱 ${macdValue.histogram >= 0 ? "为正" : "为负"}`);
  if (Number.isFinite(momentum20)) {
    const momentumScore = clamp(momentum20 * 1.8, -15, 15);
    score += addSignal(signals, momentumScore, `${label} 20 根 K 线涨跌 ${round(momentum20)}%`);
  }
  if (Number.isFinite(volumeRatio) && volumeRatio >= 1.2) {
    const candleDirection = close >= candles.at(-1).open ? 1 : -1;
    score += addSignal(signals, candleDirection * 6, `${label} 当前量能为 20 根均量的 ${round(volumeRatio, 1)} 倍`);
  }

  return {
    label,
    score: round(clamp(score, -100, 100), 1),
    close: round(close, 1),
    ema20: round(ema20, 1),
    ema50: round(ema50, 1),
    ema20SlopePct: round(ema20SlopePct, 3),
    rsi14: round(rsi14, 1),
    atr14: round(atr14, 1),
    adx14: round(adx14, 1),
    macdHistogram: round(macdValue?.histogram, 2),
    momentum20Pct: round(momentum20, 2),
    volumeRatio: round(volumeRatio, 2),
    signals,
    candles
  };
}

function latestListItem(payload) {
  return [...(payload?.data?.list ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts)).at(-1) ?? null;
}

function ratioFrom(item) {
  const buy = number(item?.buy_ratio);
  const sell = number(item?.sell_ratio);
  return buy !== null && sell ? buy / sell : null;
}

function analyzeOrderBook(payload) {
  const bids = (payload?.tick?.bids ?? []).slice(0, 20);
  const asks = (payload?.tick?.asks ?? []).slice(0, 20);
  const bidVolume = bids.reduce((sum, [, volume]) => sum + Number(volume), 0);
  const askVolume = asks.reduce((sum, [, volume]) => sum + Number(volume), 0);
  const total = bidVolume + askVolume;
  const imbalance = total ? (bidVolume - askVolume) / total : 0;
  const bestBid = number(bids[0]?.[0]);
  const bestAsk = number(asks[0]?.[0]);
  const midpoint = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  return {
    bestBid,
    bestAsk,
    spreadPct: midpoint ? ((bestAsk - bestBid) / midpoint) * 100 : null,
    top20Imbalance: imbalance
  };
}

function analyzeLiquidations(payload, now) {
  const events = (payload?.data ?? []).filter((item) => Number(item.created_at) >= now - 24 * 60 * 60 * 1000);
  let longUsd = 0;
  let shortUsd = 0;
  for (const item of events) {
    const turnover = number(item.trade_turnover) ?? (number(item.amount) ?? 0) * (number(item.price) ?? 0);
    if (item.direction === "sell") longUsd += turnover;
    if (item.direction === "buy") shortUsd += turnover;
  }
  const totalUsd = longUsd + shortUsd;
  return {
    eventCount: events.length,
    totalUsd,
    longUsd,
    shortUsd,
    longShare: totalUsd ? longUsd / totalUsd : null,
    coverage: "HTX 最近事件接口返回样本；不是完整热力图或全市场清算总额"
  };
}

function buildDerivativeRead(data, timeframes, now, config) {
  const fundingCurrent = number(data.fundingCurrent?.data?.funding_rate);
  const fundingHistory = (data.fundingHistory?.data?.data ?? []).map((item) => number(item.funding_rate)).filter(Number.isFinite);
  const fundingPercentile = percentileRank(fundingHistory, fundingCurrent);

  const oiCurrentItem = data.oiCurrent?.data?.[0] ?? null;
  const oiHistory = [...(data.oiHistory?.data?.tick ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts));
  const oiLatest = number(oiHistory.at(-1)?.value) ?? number(oiCurrentItem?.value);
  const oiPrevious = number(oiHistory.at(0)?.value);
  const oiDelta24 = percentChange(oiLatest, oiPrevious);
  const priceDelta24 = percentChange(timeframes["1h"].close, timeframes["1h"].candles.at(-25)?.close);

  const accountRatio = ratioFrom(latestListItem(data.eliteAccount));
  const positionRatio = ratioFrom(latestListItem(data.elitePosition));
  const eliteDivergence = accountRatio && positionRatio ? Math.abs(accountRatio - positionRatio) / accountRatio : null;
  const orderBook = analyzeOrderBook(data.depth);
  const liquidations = analyzeLiquidations(data.liquidations, now);

  const basisRows = data.basis?.data ?? [];
  const basisRates = basisRows.map((item) => number(item.basis_rate)).filter(Number.isFinite);
  const basisRate = basisRates.at(-1) ?? null;
  const basisPercentile = percentileRank(basisRates, basisRate);
  const markPrice = number(data.markPrice?.data?.at(-1)?.close);
  const premiumRate = number(data.premium?.data?.at(-1)?.close);

  const signals = [];
  let directionalRaw = 0;

  if (fundingCurrent !== null) {
    let fundingScore = 0;
    if (fundingCurrent > 0.0005) fundingScore = -10;
    else if (fundingCurrent > 0.0001) fundingScore = 3;
    else if (fundingCurrent < -0.0005) fundingScore = 10;
    else if (fundingCurrent < -0.0001) fundingScore = -3;
    directionalRaw += addSignal(signals, fundingScore, `Funding ${round(fundingCurrent * 100, 4)}%（历史分位 ${round(fundingPercentile, 0)}）`);
  }

  if (Number.isFinite(oiDelta24) && Number.isFinite(priceDelta24)) {
    let oiDirection = 0;
    if (oiDelta24 > 1) oiDirection = clamp(Math.sign(priceDelta24) * Math.abs(oiDelta24) * 1.2, -15, 15);
    else if (oiDelta24 < -1) oiDirection = Math.sign(priceDelta24) * 4;
    directionalRaw += addSignal(signals, oiDirection, `OI 约 24h ${round(oiDelta24)}%，同期价格 ${round(priceDelta24)}%`);
  }

  if (accountRatio && positionRatio) {
    const accountBias = Math.log2(accountRatio);
    const positionBias = Math.log2(positionRatio);
    const eliteScore = clamp(accountBias * 5 + positionBias * 10, -18, 18);
    directionalRaw += addSignal(signals, eliteScore, `精英账户比 ${round(accountRatio, 2)}，仓位比 ${round(positionRatio, 2)}`);
  }

  const bookScore = clamp(orderBook.top20Imbalance * 20, -12, 12);
  directionalRaw += addSignal(signals, bookScore, `Order Book 前 20 档不平衡 ${round(orderBook.top20Imbalance * 100, 1)}%`);

  if (basisRate !== null) {
    const basisScore = clamp(basisRate * 100 * 15, -6, 6);
    directionalRaw += addSignal(signals, basisScore, `Basis ${round(basisRate * 100, 4)}%`);
  }

  if (liquidations.totalUsd > 0) {
    const liquidationScore = clamp(((liquidations.shortUsd - liquidations.longUsd) / liquidations.totalUsd) * 5, -5, 5);
    directionalRaw += addSignal(signals, liquidationScore, `最近样本内多头清算占比 ${round(liquidations.longShare * 100, 1)}%`);
  }

  const pressureParts = [];
  if (fundingPercentile !== null) pressureParts.push({ weight: 0.25, score: Math.abs(fundingPercentile - 50) * 2 });
  if (oiDelta24 !== null) pressureParts.push({ weight: 0.2, score: clamp(50 + oiDelta24 * 2.67, 0, 100) });
  if (eliteDivergence !== null) pressureParts.push({ weight: 0.2, score: clamp(eliteDivergence * 200, 0, 100) });
  if (basisPercentile !== null) pressureParts.push({ weight: 0.2, score: Math.abs(basisPercentile - 50) * 2 });
  const pressureWeight = pressureParts.reduce((sum, item) => sum + item.weight, 0);
  const pressureScore = pressureWeight
    ? pressureParts.reduce((sum, item) => sum + item.score * item.weight, 0) / pressureWeight
    : null;

  let rawSqueezeRisk = "none";
  if (Number.isFinite(fundingPercentile) && fundingPercentile >= 90 && accountRatio > 1.5 && liquidations.longShare > 0.6) rawSqueezeRisk = "long_squeeze";
  if (Number.isFinite(fundingPercentile) && fundingPercentile <= 10 && accountRatio < 0.7 && liquidations.longShare < 0.4) rawSqueezeRisk = "short_squeeze";
  const squeezeEvidenceSufficient = liquidations.eventCount >= config.minimumLiquidationEvidenceCount
    && liquidations.totalUsd > 0;
  const squeezeRisk = squeezeEvidenceSufficient ? rawSqueezeRisk : "none";
  const pressureComponentsAvailable = pressureParts.length;

  return {
    directionalScore: round(clamp(directionalRaw * 2.5, -100, 100), 1),
    pressureScore: round(pressureScore, 1),
    pressureLabel: pressureScore >= 76 ? "extreme" : pressureScore >= 56 ? "crowded" : pressureScore >= 31 ? "balanced" : "low",
    squeezeRisk,
    rawSqueezeRisk,
    squeezeEvidenceSufficient,
    pressureComponentsAvailable,
    fundingRatePct: round(fundingCurrent * 100, 5),
    fundingPercentile: round(fundingPercentile, 0),
    oiUsd: round(oiLatest, 0),
    oiDelta24Pct: round(oiDelta24, 2),
    eliteAccountRatio: round(accountRatio, 3),
    elitePositionRatio: round(positionRatio, 3),
    eliteDivergencePct: round(eliteDivergence * 100, 1),
    markPrice: round(markPrice, 1),
    premiumPct: round(premiumRate * 100, 4),
    basisPct: round(basisRate * 100, 4),
    orderBook: {
      bestBid: round(orderBook.bestBid, 1),
      bestAsk: round(orderBook.bestAsk, 1),
      spreadPct: round(orderBook.spreadPct, 5),
      top20ImbalancePct: round(orderBook.top20Imbalance * 100, 1)
    },
    liquidations: {
      eventCount: liquidations.eventCount,
      sampleTotalUsd: round(liquidations.totalUsd, 0),
      longSharePct: round(liquidations.longShare * 100, 1),
      coverage: liquidations.coverage
    },
    signals
  };
}

function completedBar(timeframe) {
  const candles = timeframe.candles;
  const bar = candles.at(-2);
  const priorVolumes = candles.slice(-22, -2).map((item) => item.volume);
  const volumeAverage = mean(priorVolumes);
  return {
    timestamp: bar.timestamp,
    open: round(bar.open, 1),
    high: round(bar.high, 1),
    low: round(bar.low, 1),
    close: round(bar.close, 1),
    volumeRatio: round(volumeAverage ? bar.volume / volumeAverage : null, 2)
  };
}

export function deriveMarketRegime(timeframes) {
  const tf4h = timeframes["4h"];
  if (tf4h.adx14 >= 22 && Math.abs(tf4h.score) >= 15) return "TRENDING";
  if (tf4h.adx14 < 18) return "RANGE";
  return "TRANSITION";
}

function dataQualityFailures(timeframes, derivatives, now) {
  const failures = [];
  const availableNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const latest15mTs = Number(timeframes["15m"].candles.at(-1)?.timestamp);
  if (!Number.isFinite(latest15mTs) || now - latest15mTs > 30 * 60 * 1000) failures.push("15分钟K线已过期");
  if (!availableNumber(derivatives.orderBook?.bestBid) || !availableNumber(derivatives.orderBook?.bestAsk)) {
    failures.push("Order Book 不完整");
  }
  if (!availableNumber(derivatives.fundingRatePct)) failures.push("Funding 数据不可用");
  if (!availableNumber(derivatives.oiUsd)) failures.push("Open Interest 数据不可用");
  if (!availableNumber(derivatives.eliteAccountRatio) || !availableNumber(derivatives.elitePositionRatio)) {
    failures.push("精英多空持仓数据不可用");
  }
  if (!availableNumber(derivatives.markPrice) || !availableNumber(derivatives.basisPct)) {
    failures.push("Mark Price / Basis 数据不可用");
  }
  if (derivatives.pressureComponentsAvailable < 3) failures.push("衍生品拥挤度有效分项不足");
  return failures;
}

function timingRead(side, timeframes, derivatives, currentPrice, confirmed15m, config) {
  const direction = side === "LONG" ? 1 : -1;
  const support = [];
  const against = [];
  let raw = 0;
  const add = (value, label) => {
    raw += value;
    (value >= 0 ? support : against).push({ weight: Math.abs(value), label });
  };
  const tf15m = timeframes["15m"];
  const tf1h = timeframes["1h"];
  add(direction * (tf15m.close >= tf15m.ema20 ? 10 : -10), `15m 价格${tf15m.close >= tf15m.ema20 ? "站上" : "跌破"} EMA20`);
  add(direction * (tf15m.ema20SlopePct >= 0 ? 8 : -8), `15m EMA20 斜率${tf15m.ema20SlopePct >= 0 ? "向上" : "向下"}`);
  add(direction * (tf15m.macdHistogram >= 0 ? 10 : -10), `15m MACD 柱${tf15m.macdHistogram >= 0 ? "为正" : "为负"}`);
  add(direction * (tf1h.close >= tf1h.ema20 ? 8 : -8), `1h 价格${tf1h.close >= tf1h.ema20 ? "站上" : "跌破"} EMA20`);
  add(direction * (tf1h.ema20SlopePct >= 0 ? 8 : -8), `1h EMA20 斜率${tf1h.ema20SlopePct >= 0 ? "向上" : "向下"}`);
  add(direction * (tf1h.macdHistogram >= 0 ? 8 : -8), `1h MACD 柱${tf1h.macdHistogram >= 0 ? "为正" : "为负"}`);

  const candleDirection = confirmed15m.close >= confirmed15m.open ? 1 : -1;
  add(direction * candleDirection * 6, `最近完成的15m K线${candleDirection > 0 ? "收阳" : "收阴"}`);
  if (Number(confirmed15m.volumeRatio) >= 1.15) {
    add(direction * candleDirection * 7, `15m 成交量为近期均量的 ${confirmed15m.volumeRatio} 倍`);
  }
  const bookContribution = clamp(direction * Number(derivatives.orderBook.top20ImbalancePct) / 4, -8, 8);
  add(bookContribution, `Order Book 前20档不平衡 ${derivatives.orderBook.top20ImbalancePct}%`);

  const prior15m = tf15m.candles.slice(-22, -2);
  const priorHigh = Math.max(...prior15m.map((item) => item.high));
  const priorLow = Math.min(...prior15m.map((item) => item.low));
  const breakoutNow = side === "LONG" ? confirmed15m.close > priorHigh : confirmed15m.close < priorLow;
  if (breakoutNow) {
    const value = Number(confirmed15m.volumeRatio) >= config.breakoutVolumeRatio ? 9 : 3;
    add(value, `${side === "LONG" ? "向上" : "向下"}突破近期15m区间${value === 9 ? "并有量能配合" : "但量能一般"}`);
  }

  const latest1h = tf1h.candles.at(-1);
  const touchedMean = latest1h.low <= tf1h.ema20 + tf1h.atr14 * 0.25
    && latest1h.high >= tf1h.ema20 - tf1h.atr14 * 0.25;
  const recoveryNow = touchedMean && (side === "LONG"
    ? confirmed15m.close > tf15m.ema20 && candleDirection > 0
    : confirmed15m.close < tf15m.ema20 && candleDirection < 0);
  if (recoveryNow) add(7, `价格靠近1h均线后出现${side === "LONG" ? "转强" : "转弱"}迹象`);

  const directedDistance = direction * (currentPrice - tf1h.ema20) / tf1h.atr14;
  if (directedDistance > 1.5) add(-10, `价格沿${side === "LONG" ? "多" : "空"}方向离1h EMA20过远`);
  else if (directedDistance >= 0 && directedDistance <= 0.7) add(4, "价格与1h均线距离合理");
  else if (directedDistance < -1.2) add(-8, `当前价格明显逆向偏离1h均线`);

  return {
    score: round(clamp(50 + raw, 0, 100), 1),
    support: support.sort((a, b) => b.weight - a.weight),
    against: against.sort((a, b) => b.weight - a.weight),
    breakoutNow,
    recoveryNow,
    directedDistance: round(directedDistance, 2)
  };
}

function evaluateOpportunity(side, timeframes, derivatives, currentPrice, confirmed15m, allSignals, config) {
  const direction = side === "LONG" ? 1 : -1;
  const technicalSigned = Object.entries(timeframes)
    .reduce((sum, [key, value]) => sum + value.score * TIMEFRAME_WEIGHTS[key], 0);
  const technicalScore = clamp(50 + direction * technicalSigned / 2, 0, 100);
  const derivativesScore = clamp(50 + direction * derivatives.directionalScore / 2, 0, 100);
  const directionalScore = technicalScore * 0.75 + derivativesScore * 0.25;
  const timing = timingRead(side, timeframes, derivatives, currentPrice, confirmed15m, config);
  let adjustment = Number(derivatives.pressureScore) >= config.extremePressureMin
    ? -6
    : Number(derivatives.pressureScore) >= config.crowdedPressureMin
      ? -3
      : 0;
  const matchingSqueeze = derivatives.squeezeRisk === (side === "LONG" ? "long_squeeze" : "short_squeeze");
  const oppositeSqueeze = derivatives.squeezeRisk === (side === "LONG" ? "short_squeeze" : "long_squeeze");
  if (matchingSqueeze) adjustment -= 6;
  if (oppositeSqueeze) adjustment += 3;
  const score = clamp(directionalScore * 0.6 + timing.score * 0.4 + adjustment, 0, 100);

  const directionalSupport = allSignals
    .map((item) => ({ weight: direction * item.score, label: item.label }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const directionalAgainst = allSignals
    .map((item) => ({ weight: direction * item.score, label: item.label }))
    .filter((item) => item.weight < 0)
    .map((item) => ({ ...item, weight: Math.abs(item.weight) }))
    .sort((a, b) => b.weight - a.weight);
  return {
    side,
    score: round(score, 1),
    directionalScore: round(directionalScore, 1),
    timingScore: timing.score,
    supportingReasons: [...timing.support, ...directionalSupport]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((item) => item.label),
    opposingReasons: [...timing.against, ...directionalAgainst]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((item) => item.label),
    breakoutNow: timing.breakoutNow,
    recoveryNow: timing.recoveryNow,
    directedDistance: timing.directedDistance
  };
}

function assessRisk(side, opportunity, timeframes, derivatives, config) {
  if (!['LONG', 'SHORT'].includes(side)) return { riskPct: 0, riskTier: "NONE", warnings: [] };
  const long = side === "LONG";
  const warnings = [];
  const highTimeframeExtreme = long
    ? timeframes["4h"].rsi14 >= 78 && timeframes["1d"].rsi14 >= 78
    : timeframes["4h"].rsi14 <= 22 && timeframes["1d"].rsi14 <= 22;
  if (highTimeframeExtreme) warnings.push("4h与日线动量同时处于极端区域");
  if (Number(derivatives.pressureScore) >= config.crowdedPressureMin) warnings.push(`衍生品拥挤度为 ${derivatives.pressureScore}`);
  if (derivatives.squeezeRisk === (long ? "long_squeeze" : "short_squeeze")) warnings.push("衍生品出现同方向挤压风险组合");
  if (opportunity.timingScore < 65) warnings.push("短周期入场质量一般");
  if (opportunity.score < 75) warnings.push("综合机会尚未达到A级质量");
  const reduced = warnings.length > 0;
  return {
    riskPct: reduced ? config.reducedRiskPerTradePct : config.maxRiskPerTradePct,
    riskTier: reduced ? "REDUCED" : "NORMAL",
    warnings
  };
}

function chooseEntryMethod(candidate, opportunity, timeframes, confirmed15m, enterNow) {
  if (candidate === "WAIT") return { code: "NO_CLEAR_EDGE", label: "当前多空优势不清晰" };
  if (enterNow) {
    if (opportunity.breakoutNow) return { code: "BREAKOUT_NOW", label: "当前突破质量允许直接入场" };
    if (opportunity.recoveryNow) return { code: "RECOVERY_NOW", label: "当前回落后的重新走强/走弱允许入场" };
    return { code: "DIRECT_NOW", label: "当前综合条件允许直接入场" };
  }
  if (opportunity.directedDistance > 1.3) return { code: "PREFER_PULLBACK", label: "方向成立，但稍微回落后的价格更合理" };
  const prior15m = timeframes["15m"].candles.slice(-22, -2);
  const high = Math.max(...prior15m.map((item) => item.high));
  const low = Math.min(...prior15m.map((item) => item.low));
  const rangePosition = high > low ? (confirmed15m.close - low) / (high - low) : 0.5;
  const nearEdge = candidate === "LONG" ? rangePosition >= 0.8 : rangePosition <= 0.2;
  if (nearEdge && Number(confirmed15m.volumeRatio) < 1.05) {
    return { code: "PREFER_BREAKOUT_CONFIRMATION", label: "方向成立，但等待有效突破更合适" };
  }
  if (opportunity.timingScore < 58) {
    return { code: "PREFER_STRENGTH_CONFIRMATION", label: `方向成立，但等待短周期重新${candidate === "LONG" ? "走强" : "走弱"}更合适` };
  }
  return { code: "WAIT_BETTER_ALIGNMENT", label: "方向有优势，但当前入场质量仍不够好" };
}

function buildImmediatePlan(side, currentPrice, timeframes) {
  if (!['LONG', 'SHORT'].includes(side)) return null;
  const long = side === "LONG";
  const tf15m = timeframes["15m"];
  const tf1h = timeframes["1h"];
  const recent15m = tf15m.candles.slice(-10, -1);
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
    entryPrice: round(currentPrice, 1),
    stopLoss: round(stopLoss, 1),
    takeProfit: takeProfit.map((value) => round(value, 1)),
    riskReward: [2.2, 2.8]
  };
}

export function analyzeSnapshot(data, config = PAPER_CONFIG) {
  const now = Number(data.ticker?.ts) || Date.now();
  const currentPrice = number(data.ticker?.tick?.close);
  if (!currentPrice) throw new Error("Ticker price is unavailable");

  const timeframes = {
    "15m": summarizeTimeframe(data.kline15m, "15m"),
    "1h": summarizeTimeframe(data.kline1h, "1h"),
    "4h": summarizeTimeframe(data.kline4h, "4h"),
    "1d": summarizeTimeframe(data.kline1d, "1d")
  };
  const technicalScore = Object.entries(timeframes)
    .reduce((sum, [key, value]) => sum + value.score * TIMEFRAME_WEIGHTS[key], 0);
  const derivatives = buildDerivativeRead(data, timeframes, now, config);
  const confirmed15m = completedBar(timeframes["15m"]);
  const allSignals = [
    ...Object.values(timeframes).flatMap((item) => item.signals),
    ...derivatives.signals
  ];
  const longOpportunity = evaluateOpportunity("LONG", timeframes, derivatives, currentPrice, confirmed15m, allSignals, config);
  const shortOpportunity = evaluateOpportunity("SHORT", timeframes, derivatives, currentPrice, confirmed15m, allSignals, config);
  const winner = longOpportunity.score >= shortOpportunity.score ? longOpportunity : shortOpportunity;
  const scoreGap = Math.abs(longOpportunity.score - shortOpportunity.score);
  const dataFailures = dataQualityFailures(timeframes, derivatives, now);
  const candidateDecision = winner.score >= config.minimumBiasScore && scoreGap >= config.minimumDirectionalGap
    ? winner.side
    : "WAIT";
  const enterNow = dataFailures.length === 0
    && candidateDecision !== "WAIT"
    && winner.score >= config.minimumImmediateEntryScore;
  const marketRisk = assessRisk(candidateDecision, winner, timeframes, derivatives, config);
  const method = chooseEntryMethod(candidateDecision, winner, timeframes, confirmed15m, enterNow);
  const levels = enterNow ? buildImmediatePlan(candidateDecision, currentPrice, timeframes) : null;
  const decision = enterNow && levels ? candidateDecision : "WAIT";
  const riskGates = dataFailures;
  const missingConditions = dataFailures.length
    ? dataFailures
    : candidateDecision === "WAIT"
      ? [
          `多头机会 ${longOpportunity.score}，空头机会 ${shortOpportunity.score}`,
          `领先方向分差 ${round(scoreGap, 1)}，当前优势不够清晰`,
          "等待下一轮市场数据形成更明确的综合优势"
        ]
      : decision === "WAIT"
        ? [
            method.label,
            `当前${candidateDecision === "LONG" ? "做多" : "做空"}机会质量 ${winner.score}，尚未达到立即入场质量`,
            ...winner.opposingReasons.slice(0, 2)
          ]
        : [];
  const decisionReasons = decision !== "WAIT"
    ? winner.supportingReasons.slice(0, 5)
    : candidateDecision !== "WAIT"
      ? [method.label, ...winner.supportingReasons.slice(0, 3)]
      : [
          `多头综合分 ${longOpportunity.score}`,
          `空头综合分 ${shortOpportunity.score}`,
          "当前多空证据没有形成足够清晰的入场优势"
        ];
  const confidence = decision !== "WAIT"
    ? clamp(55 + (winner.score - config.minimumBiasScore) + scoreGap * 0.5, 55, 90)
    : clamp(55 + Math.max(0, config.minimumImmediateEntryScore - winner.score) * 0.5, 55, 85);
  const finalScore = longOpportunity.score - shortOpportunity.score;
  const marketRegime = deriveMarketRegime(timeframes);

  const publicCapabilities = [
    "15m/1h/4h/1d K线与成交量",
    "Order Book",
    "Funding（当前+历史）",
    "OI（当前+历史）",
    "精英账户/仓位多空比",
    "最近清算事件样本",
    "Mark Price / Premium / Basis"
  ];

  return {
    version: "V1.2",
    mode: "READ_ONLY_PUBLIC_DATA_PAPER_ONLY",
    symbol: "BTC-USDT",
    generatedAt: new Date(now).toISOString(),
    decision,
    candidateDecision,
    riskGates,
    confidencePct: round(confidence, 0),
    finalScore: round(finalScore, 1),
    currentPrice: round(currentPrice, 1),
    latest15mBar: {
      timestamp: timeframes["15m"].candles.at(-1).timestamp,
      open: round(timeframes["15m"].candles.at(-1).open, 1),
      high: round(timeframes["15m"].candles.at(-1).high, 1),
      low: round(timeframes["15m"].candles.at(-1).low, 1),
      close: round(timeframes["15m"].candles.at(-1).close, 1)
    },
    completed15mBar: confirmed15m,
    plan: levels ?? {
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null
    },
    entryAssessment: {
      enterNow: decision !== "WAIT",
      method: method.code,
      methodLabel: method.label,
      reasons: decisionReasons,
      missingConditions,
      riskPct: decision !== "WAIT" ? marketRisk.riskPct : 0
    },
    opportunities: {
      LONG: longOpportunity,
      SHORT: shortOpportunity
    },
    strategy: {
      version: "V1.2",
      marketRegime,
      bias: candidateDecision,
      state: decision === "WAIT" ? "WAIT" : "ENTER_NOW",
      riskPct: decision !== "WAIT" ? marketRisk.riskPct : 0,
      riskTier: marketRisk.riskTier,
      hardBlocks: dataFailures,
      softWarnings: marketRisk.warnings,
      entryMethod: method.code
    },
    scores: {
      technical: round(technicalScore, 1),
      derivativesDirectional: derivatives.directionalScore,
      derivativesPressure: derivatives.pressureScore,
      longOpportunity: longOpportunity.score,
      shortOpportunity: shortOpportunity.score,
      scoreGap: round(scoreGap, 1)
    },
    timeframes: Object.fromEntries(Object.entries(timeframes).map(([key, value]) => [key, {
      score: value.score,
      close: value.close,
      ema20: value.ema20,
      ema50: value.ema50,
      ema20SlopePct: value.ema20SlopePct,
      rsi14: value.rsi14,
      atr14: value.atr14,
      adx14: value.adx14,
      macdHistogram: value.macdHistogram,
      momentum20Pct: value.momentum20Pct,
      volumeRatio: value.volumeRatio
    }])),
    derivatives,
    bullishReasons: longOpportunity.supportingReasons,
    bearishReasons: shortOpportunity.supportingReasons,
    dataQuality: {
      validForEntry: dataFailures.length === 0,
      failures: dataFailures
    },
    dataCoverage: {
      available: publicCapabilities,
      limitations: [
        "清算仅为 HTX 最近公开事件样本，不是完整热力图或全市场总额",
        "仅有 HTX 精英交易者比率，没有等价的全体散户比率",
        "HTX 未提供独立 Taker 主动买卖量接口",
        "衍生品压力缺少 30 日清算均值，清算方向仅作为带样本质量标记的辅助证据",
        "每轮都使用最新数据重新比较多空与入场质量，不沿用上一轮固定方向或价格"
      ]
    },
    safety: {
      apiKeyUsed: false,
      privateEndpointUsed: false,
      exchangeWriteEnabled: false,
      tradingModulePresent: false,
      paperTradingOnly: true
    },
    disclaimer: "机械规则研究输出，不构成投资建议；V1.2 只在本地 SQLite 中模拟交易，不具备任何真实交易能力。"
  };
}
