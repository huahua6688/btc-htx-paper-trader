import { adx, atr, clamp, ema, macd, mean, percentChange, percentileRank, rsi } from "./indicators.mjs";
import { hashObject, round } from "./research-utils.mjs";

const HOUR = 60 * 60 * 1000;

export const INDICATOR_PROFILES = Object.freeze({
  SHORT_SWING: Object.freeze({
    key: "SHORT_SWING", label: "短波段", horizon: "hours-3d",
    weights: { "15m": 0.34, "1h": 0.42, "4h": 0.20, "1d": 0.04 },
    ema: [9, 21, 55], rsi: [7, 14, 28], macd: [8, 21, 5], atr: 14,
    structureBars: { "15m": 48, "1h": 48, "4h": 24 }, holdingHours: 12
  }),
  STANDARD_SWING: Object.freeze({
    key: "STANDARD_SWING", label: "标准波段", horizon: "1d-14d",
    weights: { "15m": 0.16, "1h": 0.36, "4h": 0.36, "1d": 0.12 },
    ema: [12, 26, 60], rsi: [9, 14, 28], macd: [12, 26, 9], atr: 14,
    structureBars: { "15m": 64, "1h": 72, "4h": 42 }, holdingHours: 36
  }),
  LONG_SWING: Object.freeze({
    key: "LONG_SWING", label: "长波段", horizon: "3d-30d",
    weights: { "15m": 0.06, "1h": 0.20, "4h": 0.42, "1d": 0.32 },
    ema: [20, 50, 100], rsi: [14, 21, 35], macd: [18, 39, 12], atr: 21,
    structureBars: { "15m": 96, "1h": 120, "4h": 84 }, holdingHours: 96
  })
});

export const INDICATOR_PROFILE_VERSION = "indicator-profiles-v2.0.0";

function rows(payload) {
  return (payload?.data ?? []).map((item) => ({
    timestamp: Number(item.id) * 1000,
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close),
    volume: Number(item.amount ?? item.vol ?? 0)
  })).filter((item) => [item.timestamp, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function changeAtHours(candles, hours) {
  const latest = candles.at(-1);
  if (!latest) return null;
  const cutoff = latest.timestamp - hours * HOUR;
  const prior = candles.findLast((item) => item.timestamp <= cutoff) ?? candles[0];
  return round(percentChange(latest.close, prior?.close), 4);
}

function persistence(values) {
  if (values.length < 2) return 0;
  const sign = Math.sign(values.at(-1));
  if (!sign) return 0;
  let count = 0;
  for (let index = values.length - 1; index >= 0 && Math.sign(values[index]) === sign; index -= 1) count += 1;
  return count * sign;
}

function macdSeries(closes, fast, slow, signal) {
  const fastLine = ema(closes, fast);
  const slowLine = ema(closes, slow);
  const line = closes.map((_, index) => fastLine[index] - slowLine[index]);
  const signalLine = ema(line, signal);
  return line.map((value, index) => value - signalLine[index]);
}

function rsiSeries(closes, period, samples = 8) {
  const start = Math.max(period + 1, closes.length - samples);
  const output = [];
  for (let length = start; length <= closes.length; length += 1) output.push(rsi(closes.slice(0, length), period));
  return output.filter(Number.isFinite);
}

function swingStructure(candles) {
  const slice = candles.slice(-48);
  if (slice.length < 8) return { direction: 0, higherHighs: false, higherLows: false, lowerHighs: false, lowerLows: false };
  const half = Math.floor(slice.length / 2);
  const first = slice.slice(0, half);
  const second = slice.slice(half);
  const firstHigh = Math.max(...first.map((item) => item.high));
  const secondHigh = Math.max(...second.map((item) => item.high));
  const firstLow = Math.min(...first.map((item) => item.low));
  const secondLow = Math.min(...second.map((item) => item.low));
  const higherHighs = secondHigh > firstHigh;
  const higherLows = secondLow > firstLow;
  const lowerHighs = secondHigh < firstHigh;
  const lowerLows = secondLow < firstLow;
  return { direction: higherHighs && higherLows ? 1 : lowerHighs && lowerLows ? -1 : 0, higherHighs, higherLows, lowerHighs, lowerLows };
}

export function summarizeIndicatorProcess(payload, timeframe, profile) {
  const candles = rows(payload);
  const minimum = Math.max(profile.ema[2] + 2, profile.macd[1] + profile.macd[2] + 2, profile.rsi[2] + 10);
  if (candles.length < minimum) throw new Error(`${timeframe} completed candle history is too short for ${profile.key}`);
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  const [emaFastPeriod, emaMediumPeriod, emaSlowPeriod] = profile.ema;
  const emaFastLine = ema(closes, emaFastPeriod);
  const emaMediumLine = ema(closes, emaMediumPeriod);
  const emaSlowLine = ema(closes, emaSlowPeriod);
  const emaFast = emaFastLine.at(-1);
  const emaMedium = emaMediumLine.at(-1);
  const emaSlow = emaSlowLine.at(-1);
  const rsiTrajectories = Object.fromEntries(profile.rsi.map((period) => {
    const series = rsiSeries(closes, period, 10);
    return [period, {
      value: round(series.at(-1), 3),
      change: round(series.at(-1) - series.at(-4), 3),
      speedPerBar: round((series.at(-1) - series.at(-4)) / Math.max(1, Math.min(3, series.length - 1)), 3),
      persistenceBars: persistence(series.slice(1).map((value, index) => value - series[index]))
    }];
  }));
  const histogram = macdSeries(closes, ...profile.macd);
  const atrValue = atr(candles, profile.atr);
  const atrHistory = [];
  for (let length = Math.max(profile.atr + 2, candles.length - 100); length <= candles.length; length += 1) {
    atrHistory.push(atr(candles.slice(0, length), profile.atr));
  }
  const currentVolume = volumes.at(-1);
  const priorVolume = mean(volumes.slice(-21, -1));
  const structure = swingStructure(candles);
  return {
    timeframe,
    candleCount: candles.length,
    close: round(closes.at(-1), 4),
    ema: {
      periods: profile.ema,
      fast: round(emaFast, 4), medium: round(emaMedium, 4), slow: round(emaSlow, 4),
      alignment: emaFast > emaMedium && emaMedium > emaSlow ? 1 : emaFast < emaMedium && emaMedium < emaSlow ? -1 : 0,
      fastSlopePct: round(percentChange(emaFast, emaFastLine.at(-5)), 5),
      mediumSlopePct: round(percentChange(emaMedium, emaMediumLine.at(-7)), 5)
    },
    rsi: rsiTrajectories,
    macd: {
      periods: profile.macd,
      histogram: round(histogram.at(-1), 6),
      change: round(histogram.at(-1) - histogram.at(-4), 6),
      expanding: Math.abs(histogram.at(-1)) > Math.abs(histogram.at(-4)),
      persistenceBars: persistence(histogram)
    },
    atr: {
      period: profile.atr, value: round(atrValue, 6),
      pctOfPrice: round(atrValue / closes.at(-1) * 100, 6),
      percentile100: round(percentileRank(atrHistory, atrValue), 2)
    },
    adx: round(adx(candles, profile.atr), 3),
    volume: {
      ratio20: round(priorVolume > 0 ? currentVolume / priorVolume : null, 4),
      change20Pct: round(percentChange(currentVolume, priorVolume), 4)
    },
    structure,
    naturalReturnsPct: {
      hours4: changeAtHours(candles, 4), hours12: changeAtHours(candles, 12),
      day1: changeAtHours(candles, 24), day3: changeAtHours(candles, 72),
      day7: changeAtHours(candles, 168), day14: changeAtHours(candles, 336), day30: changeAtHours(candles, 720)
    },
    candles
  };
}

export function classifyMarketRegime(frames) {
  const h1 = frames["1h"];
  const h4 = frames["4h"];
  const d1 = frames["1d"];
  const directionVotes = h1.ema.alignment + h4.ema.alignment * 2 + d1.ema.alignment * 2
    + h1.structure.direction + h4.structure.direction * 2;
  const trendStrength = mean([h1.adx, h4.adx, d1.adx].filter(Number.isFinite)) ?? 0;
  const volatilityPercentile = mean([h1.atr.percentile100, h4.atr.percentile100].filter(Number.isFinite)) ?? 50;
  const natural = h4.naturalReturnsPct;
  const multiWindowAgreement = [natural.day1, natural.day3, natural.day7, natural.day14]
    .filter(Number.isFinite).reduce((sum, value) => sum + Math.sign(value), 0);
  const trendDirection = Math.sign(directionVotes);
  const conflicting = trendDirection !== 0 && multiWindowAgreement !== 0 && trendDirection !== Math.sign(multiWindowAgreement);
  const extremeMove = Math.abs(Number(natural.day3 ?? 0)) > Math.max(12, Number(h4.atr.pctOfPrice) * 8);
  let primary;
  if (extremeMove || volatilityPercentile >= 97) primary = "EXTREME";
  else if (conflicting || Math.abs(directionVotes) <= 2 && trendStrength >= 18) primary = "TRANSITION";
  else if (trendStrength < 17 && Math.abs(directionVotes) <= 3) primary = "RANGE";
  else if (trendDirection > 0) primary = trendStrength >= 27 ? "STRONG_UPTREND" : "WEAK_UPTREND";
  else if (trendDirection < 0) primary = trendStrength >= 27 ? "STRONG_DOWNTREND" : "WEAK_DOWNTREND";
  else primary = "TRANSITION";
  const volatility = volatilityPercentile >= 75 ? "HIGH_VOLATILITY" : volatilityPercentile <= 25 ? "LOW_VOLATILITY" : "NORMAL_VOLATILITY";
  return {
    primary, volatility, trendDirection, directionVotes, trendStrength: round(trendStrength, 3),
    volatilityPercentile: round(volatilityPercentile, 2), multiWindowAgreement, conflicting, extremeMove,
    classifierVersion: "multi-factor-regime-v2.0.0"
  };
}

export function resolveIndicatorProfile(requested, regime = null) {
  const normalized = String(requested ?? "AUTO").toUpperCase();
  if (normalized !== "AUTO") {
    const selected = INDICATOR_PROFILES[normalized];
    if (!selected) throw new Error(`Unknown indicator profile: ${requested}`);
    return { requested: normalized, selected: selected.key, reason: "USER_SELECTED", profile: selected };
  }
  const primary = regime?.primary ?? "TRANSITION";
  const key = ["STRONG_UPTREND", "STRONG_DOWNTREND"].includes(primary) ? "STANDARD_SWING"
    : primary === "RANGE" ? "SHORT_SWING"
      : ["WEAK_UPTREND", "WEAK_DOWNTREND"].includes(primary) ? "STANDARD_SWING" : "SHORT_SWING";
  return { requested: "AUTO", selected: key, reason: `REGIME_${primary}`, profile: INDICATOR_PROFILES[key] };
}

export function buildMultiScaleContext(market, requestedProfile = "AUTO") {
  // AUTO starts from the standard profile to classify the regime, then recomputes
  // with the selected profile. This is deterministic and uses only visible rows.
  const standard = INDICATOR_PROFILES.STANDARD_SWING;
  const baseFrames = Object.fromEntries([["15m", market.kline15m], ["1h", market.kline1h], ["4h", market.kline4h], ["1d", market.kline1d]]
    .map(([key, payload]) => [key, summarizeIndicatorProcess(payload, key, standard)]));
  const baseRegime = classifyMarketRegime(baseFrames);
  const selection = resolveIndicatorProfile(requestedProfile, baseRegime);
  const frames = selection.selected === "STANDARD_SWING" ? baseFrames
    : Object.fromEntries([["15m", market.kline15m], ["1h", market.kline1h], ["4h", market.kline4h], ["1d", market.kline1d]]
      .map(([key, payload]) => [key, summarizeIndicatorProcess(payload, key, selection.profile)]));
  const regime = classifyMarketRegime(frames);
  return {
    profile: { requested: selection.requested, selected: selection.selected, reason: selection.reason, version: INDICATOR_PROFILE_VERSION, hash: hashObject(selection.profile) },
    regime,
    frames
  };
}

