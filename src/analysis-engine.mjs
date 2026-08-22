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

export function deriveMarketContext(timeframes, finalScore) {
  const tf4h = timeframes["4h"];
  const bullish = tf4h.ema20 > tf4h.ema50 && tf4h.close > tf4h.ema20 && tf4h.ema20SlopePct > 0;
  const bearish = tf4h.ema20 < tf4h.ema50 && tf4h.close < tf4h.ema20 && tf4h.ema20SlopePct < 0;
  const trendSide = bullish ? "LONG" : bearish ? "SHORT" : "WAIT";
  const bias = trendSide === "LONG" && finalScore > -24
    ? "LONG"
    : trendSide === "SHORT" && finalScore < 24
      ? "SHORT"
      : "WAIT";
  const marketRegime = trendSide !== "WAIT" && tf4h.adx14 >= 20
    ? "TRENDING"
    : tf4h.adx14 < 18
      ? "RANGE"
      : "TRANSITION";
  return { bias, marketRegime, trendSide };
}

function assessMarketRisk(side, timeframes, derivatives, config) {
  if (!['LONG', 'SHORT'].includes(side)) return {
    riskPct: 0,
    riskTier: "NONE",
    hardBlocks: [],
    softWarnings: []
  };
  const hardBlocks = [];
  const softWarnings = [];
  const long = side === "LONG";
  const overheated4h = long ? timeframes["4h"].rsi14 >= 78 : timeframes["4h"].rsi14 <= 22;
  const overheated1d = long ? timeframes["1d"].rsi14 >= 78 : timeframes["1d"].rsi14 <= 22;
  if (overheated4h) softWarnings.push(`4h RSI ${long ? "过热" : "超卖"}，风险降至 0.5%`);
  if (overheated1d) softWarnings.push(`日线 RSI ${long ? "过热" : "超卖"}，风险降至 0.5%`);

  const pressure = Number(derivatives.pressureScore);
  if (Number.isFinite(pressure) && pressure >= config.crowdedPressureMin) {
    softWarnings.push(`衍生品拥挤度 ${pressure}，风险降至 0.5%`);
  }
  if (derivatives.pressureComponentsAvailable < 3) {
    softWarnings.push("衍生品压力有效分项不足 3 个，风险降至 0.5%");
  }
  if (derivatives.rawSqueezeRisk !== "none" && !derivatives.squeezeEvidenceSufficient) {
    softWarnings.push("出现挤压方向提示，但公开清算样本不足，仅作降级警告");
  }
  const matchingSqueeze = derivatives.squeezeRisk === (long ? "long_squeeze" : "short_squeeze");
  if (Number.isFinite(pressure) && pressure >= config.extremePressureMin && matchingSqueeze) {
    hardBlocks.push("极端衍生品拥挤与同方向 squeeze 同时出现，禁止新仓");
  }
  const reduced = softWarnings.length > 0;
  return {
    riskPct: reduced ? config.reducedRiskPerTradePct : config.maxRiskPerTradePct,
    riskTier: reduced ? "REDUCED" : "NORMAL",
    hardBlocks,
    softWarnings
  };
}

function buildSetupProposal(side, timeframes, currentPrice, generatedAt, risk, config) {
  if (!['LONG', 'SHORT'].includes(side) || risk.hardBlocks.length) return null;
  const long = side === "LONG";
  const tf1h = timeframes["1h"];
  const tf15m = timeframes["15m"];
  const latest1h = tf1h.candles.at(-1);
  const live15m = tf15m.candles.at(-1);
  const confirmed15m = completedBar(tf15m);
  const prior15m = tf15m.candles.slice(-10, -2);
  const atr1h = tf1h.atr14;
  const atr15m = tf15m.atr14;
  const pullbackZone = [tf1h.ema20 - atr1h * 0.35, tf1h.ema20 + atr1h * 0.35];
  const touchedPullback = latest1h.low <= pullbackZone[1] && latest1h.high >= pullbackZone[0];
  const distanceFromMean = Math.abs(currentPrice - tf1h.ema20) / atr1h;
  const type = touchedPullback || distanceFromMean <= 0.8 ? "TREND_PULLBACK" : "BREAKOUT_CONTINUATION";
  const priorHigh = Math.max(...prior15m.map((item) => item.high));
  const priorLow = Math.min(...prior15m.map((item) => item.low));
  const triggerPrice = long
    ? priorHigh + atr15m * (type === "TREND_PULLBACK" ? 0.03 : 0.08)
    : priorLow - atr15m * (type === "TREND_PULLBACK" ? 0.03 : 0.08);
  const recentStructure = type === "TREND_PULLBACK" ? tf1h.candles.slice(-5) : tf15m.candles.slice(-10, -1);
  const structureStop = long
    ? Math.min(...recentStructure.map((item) => item.low)) - (type === "TREND_PULLBACK" ? atr1h : atr15m) * 0.1
    : Math.max(...recentStructure.map((item) => item.high)) + (type === "TREND_PULLBACK" ? atr1h : atr15m) * 0.1;
  const minimumStop = long ? triggerPrice - atr1h * 0.8 : triggerPrice + atr1h * 0.8;
  const stopLoss = long ? Math.min(structureStop, minimumStop) : Math.max(structureStop, minimumStop);
  const riskDistance = Math.abs(triggerPrice - stopLoss);
  const takeProfit = long
    ? [triggerPrice + riskDistance * 2.2, triggerPrice + riskDistance * 2.8]
    : [triggerPrice - riskDistance * 2.2, triggerPrice - riskDistance * 2.8];
  const entryZone = type === "TREND_PULLBACK"
    ? pullbackZone
    : [triggerPrice - atr15m * 0.12, triggerPrice + atr15m * 0.12];
  const bullishConfirmation = confirmed15m.close >= triggerPrice && confirmed15m.close > confirmed15m.open;
  const bearishConfirmation = confirmed15m.close <= triggerPrice && confirmed15m.close < confirmed15m.open;
  const directionConfirmed = long ? bullishConfirmation : bearishConfirmation;
  const volumeConfirmed = type !== "BREAKOUT_CONTINUATION"
    || Number(confirmed15m.volumeRatio) >= config.breakoutVolumeRatio;
  const armImmediately = type === "BREAKOUT_CONTINUATION"
    || (live15m.low <= pullbackZone[1] && live15m.high >= pullbackZone[0]);

  return {
    side,
    type,
    createdAt: generatedAt,
    expiresAt: new Date(new Date(generatedAt).getTime() + config.setupExpiryMs).toISOString(),
    basisBarTs: confirmed15m.timestamp,
    entryZone: entryZone.map((value) => round(value, 1)),
    triggerPrice: round(triggerPrice, 1),
    invalidationPrice: round(stopLoss, 1),
    stopLoss: round(stopLoss, 1),
    takeProfit: takeProfit.map((value) => round(value, 1)),
    riskReward: [2.2, 2.8],
    riskPct: risk.riskPct,
    riskTier: risk.riskTier,
    armImmediately,
    triggeredNow: armImmediately && directionConfirmed && volumeConfirmed,
    reasons: [
      `4h ${side === "LONG" ? "多头" : "空头"}方向有效`,
      type === "TREND_PULLBACK" ? "1h 进入趋势回踩结构" : "等待 15m 突破延续",
      `15m 触发价 ${round(triggerPrice, 1)}`
    ],
    warnings: risk.softWarnings
  };
}

function buildLevels(decision, setup) {
  if (!setup) return {
    entryZone: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    waitTriggers: null
  };
  return {
    entryZone: setup.entryZone,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskReward: setup.riskReward,
    waitTriggers: decision === "WAIT" ? {
      side: setup.side,
      type: setup.type,
      entryZone: setup.entryZone,
      triggerPrice: setup.triggerPrice,
      invalidationPrice: setup.invalidationPrice,
      expiresAt: setup.expiresAt
    } : null
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
  const finalScore = clamp(technicalScore * 0.75 + derivatives.directionalScore * 0.25, -100, 100);
  const context = deriveMarketContext(timeframes, finalScore);
  const candidateDecision = context.bias;
  const marketRisk = assessMarketRisk(candidateDecision, timeframes, derivatives, config);
  const setupProposal = buildSetupProposal(candidateDecision, timeframes, currentPrice, new Date(now).toISOString(), marketRisk, config);
  const riskGates = marketRisk.hardBlocks;
  const decision = setupProposal?.triggeredNow && !riskGates.length ? candidateDecision : "WAIT";

  const weightedPositive = Object.entries(timeframes).reduce((sum, [key, value]) => sum + (value.score > 0 ? TIMEFRAME_WEIGHTS[key] : 0), 0);
  const weightedNegative = Object.entries(timeframes).reduce((sum, [key, value]) => sum + (value.score < 0 ? TIMEFRAME_WEIGHTS[key] : 0), 0);
  const agreement = Math.max(weightedPositive, weightedNegative);
  const confidence = decision === "WAIT"
    ? riskGates.length
      ? clamp(68 + riskGates.length * 3 + derivatives.pressureScore * 0.05, 68, 86)
      : clamp(58 + (24 - Math.abs(finalScore)) * 0.8 + (1 - agreement) * 12, 55, 82)
    : clamp(52 + Math.abs(finalScore) * 0.45 + agreement * 8, 55, 90);

  const allSignals = [
    ...Object.values(timeframes).flatMap((item) => item.signals),
    ...derivatives.signals
  ];
  const bullishReasons = allSignals.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((item) => item.label);
  const bearishReasons = allSignals.filter((item) => item.score < 0).sort((a, b) => a.score - b.score).slice(0, 6).map((item) => item.label);
  const levels = buildLevels(decision, setupProposal);

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
    version: "V1.1",
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
    completed15mBar: completedBar(timeframes["15m"]),
    plan: levels,
    strategy: {
      version: "V1.1",
      marketRegime: context.marketRegime,
      trendSide: context.trendSide,
      bias: context.bias,
      state: riskGates.length ? "BLOCKED" : setupProposal?.triggeredNow ? "TRIGGERED" : setupProposal ? "WATCHING" : "SCANNING",
      riskPct: marketRisk.riskPct,
      riskTier: marketRisk.riskTier,
      hardBlocks: marketRisk.hardBlocks,
      softWarnings: marketRisk.softWarnings,
      setupProposal
    },
    scores: {
      technical: round(technicalScore, 1),
      derivativesDirectional: derivatives.directionalScore,
      derivativesPressure: derivatives.pressureScore
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
    bullishReasons,
    bearishReasons,
    dataCoverage: {
      available: publicCapabilities,
      limitations: [
        "清算仅为 HTX 最近公开事件样本，不是完整热力图或全市场总额",
        "仅有 HTX 精英交易者比率，没有等价的全体散户比率",
        "HTX 未提供独立 Taker 主动买卖量接口",
        "衍生品压力缺少 30 日清算均值，清算方向仅作为带样本质量标记的辅助证据",
        "V1.1 会把有效结构保存为待触发计划，由后续 monitor 周期继续检查"
      ]
    },
    safety: {
      apiKeyUsed: false,
      privateEndpointUsed: false,
      exchangeWriteEnabled: false,
      tradingModulePresent: false,
      paperTradingOnly: true
    },
    disclaimer: "机械规则研究输出，不构成投资建议；V1.1 只在本地 SQLite 中模拟交易，不具备任何真实交易能力。"
  };
}
