import { atr, clamp, ema, macd, mean, percentChange, percentileRank, rsi } from "./indicators.mjs";

const TIMEFRAME_WEIGHTS = Object.freeze({ "15m": 0.15, "1h": 0.25, "4h": 0.4, "1d": 0.2 });

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
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
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
    rsi14: round(rsi14, 1),
    atr14: round(atr14, 1),
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

function buildDerivativeRead(data, timeframes, now) {
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

  let squeezeRisk = "none";
  if (fundingPercentile >= 90 && accountRatio > 1.5 && liquidations.longShare > 0.6) squeezeRisk = "long_squeeze";
  if (fundingPercentile <= 10 && accountRatio < 0.7 && liquidations.longShare < 0.4) squeezeRisk = "short_squeeze";

  return {
    directionalScore: round(clamp(directionalRaw * 2.5, -100, 100), 1),
    pressureScore: round(pressureScore, 1),
    pressureLabel: pressureScore >= 76 ? "extreme" : pressureScore >= 56 ? "crowded" : pressureScore >= 31 ? "balanced" : "low",
    squeezeRisk,
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

function buildLevels(decision, currentPrice, tf1h, tf15m) {
  const atr1h = tf1h.atr14;
  const atr15m = tf15m.atr14;
  const recent1h = tf1h.candles.slice(-12);
  const recent15m = tf15m.candles.slice(-16);
  const longTrigger = Math.max(...recent15m.map((item) => item.high)) + atr15m * 0.1;
  const shortTrigger = Math.min(...recent15m.map((item) => item.low)) - atr15m * 0.1;

  if (decision === "WAIT") {
    const pullbackCenter = tf1h.ema20;
    return {
      entryZone: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      waitTriggers: {
        longPullbackZone: [round(pullbackCenter - atr1h * 0.25, 1), round(pullbackCenter + atr1h * 0.25, 1)],
        longBreakoutAbove: round(longTrigger, 1),
        shortBreakdownBelow: round(shortTrigger, 1)
      }
    };
  }

  if (decision === "LONG") {
    const entryLow = currentPrice - atr1h * 0.35;
    const entryHigh = currentPrice + atr1h * 0.05;
    const entryMid = (entryLow + entryHigh) / 2;
    const recentLow = Math.min(...recent1h.map((item) => item.low));
    const stopLoss = Math.min(recentLow - atr1h * 0.1, entryMid - atr1h * 1.2);
    const risk = entryMid - stopLoss;
    return {
      entryZone: [round(entryLow, 1), round(entryHigh, 1)],
      stopLoss: round(stopLoss, 1),
      takeProfit: [round(entryMid + risk * 1.8, 1), round(entryMid + risk * 2.5, 1)],
      riskReward: [1.8, 2.5],
      waitTriggers: null
    };
  }

  const entryLow = currentPrice - atr1h * 0.05;
  const entryHigh = currentPrice + atr1h * 0.35;
  const entryMid = (entryLow + entryHigh) / 2;
  const recentHigh = Math.max(...recent1h.map((item) => item.high));
  const stopLoss = Math.max(recentHigh + atr1h * 0.1, entryMid + atr1h * 1.2);
  const risk = stopLoss - entryMid;
  return {
    entryZone: [round(entryLow, 1), round(entryHigh, 1)],
    stopLoss: round(stopLoss, 1),
    takeProfit: [round(entryMid - risk * 1.8, 1), round(entryMid - risk * 2.5, 1)],
    riskReward: [1.8, 2.5],
    waitTriggers: null
  };
}

export function analyzeSnapshot(data) {
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
  const derivatives = buildDerivativeRead(data, timeframes, now);
  const finalScore = clamp(technicalScore * 0.75 + derivatives.directionalScore * 0.25, -100, 100);
  const candidateDecision = finalScore >= 24 ? "LONG" : finalScore <= -24 ? "SHORT" : "WAIT";
  const riskGates = [];
  if (candidateDecision === "LONG" && timeframes["4h"].rsi14 >= 78) riskGates.push("4h RSI 过热，禁止追多");
  if (candidateDecision === "LONG" && timeframes["1d"].rsi14 >= 78) riskGates.push("日线 RSI 过热，禁止追多");
  if (candidateDecision === "LONG" && derivatives.squeezeRisk === "long_squeeze") riskGates.push("衍生品提示 long_squeeze 风险");
  if (candidateDecision === "LONG" && derivatives.pressureScore >= 70) riskGates.push("衍生品拥挤度过高，等待去杠杆或回踩确认");
  if (candidateDecision === "SHORT" && timeframes["4h"].rsi14 <= 22) riskGates.push("4h RSI 超卖，禁止追空");
  if (candidateDecision === "SHORT" && timeframes["1d"].rsi14 <= 22) riskGates.push("日线 RSI 超卖，禁止追空");
  if (candidateDecision === "SHORT" && derivatives.squeezeRisk === "short_squeeze") riskGates.push("衍生品提示 short_squeeze 风险");
  if (candidateDecision === "SHORT" && derivatives.pressureScore >= 70) riskGates.push("衍生品拥挤度过高，等待去杠杆或反弹确认");
  const decision = riskGates.length ? "WAIT" : candidateDecision;

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
  const levels = buildLevels(decision, currentPrice, timeframes["1h"], timeframes["15m"]);

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
    version: "V1",
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
    plan: levels,
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
      rsi14: value.rsi14,
      atr14: value.atr14,
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
        "本结果是单次快照；再次运行才会刷新"
      ]
    },
    safety: {
      apiKeyUsed: false,
      privateEndpointUsed: false,
      exchangeWriteEnabled: false,
      tradingModulePresent: false,
      paperTradingOnly: true
    },
    disclaimer: "机械规则研究输出，不构成投资建议；V1 只在本地 SQLite 中模拟交易，不具备任何真实交易能力。"
  };
}
