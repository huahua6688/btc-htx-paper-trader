import { ema, rsi } from "./indicators.mjs";
import { BAR_MS, hashObject, mean, quantile, round, standardDeviation } from "./research-utils.mjs";

export const SIMILARITY_HORIZONS = Object.freeze({
  "1h": 4,
  "4h": 16,
  "12h": 48,
  "24h": 96,
  "3d": 288,
  "7d": 672
});

const FEATURE_NAMES = Object.freeze([
  "return1h", "return4h", "return24h", "return7d", "volatility24h",
  "ema20Gap", "ema50Gap", "rsi14", "volumeRatio24h"
]);

function pct(current, prior) { return prior ? current / prior - 1 : 0; }

function rollingVolatility(closes, index, size) {
  const returns = [];
  for (let cursor = Math.max(1, index - size + 1); cursor <= index; cursor += 1) returns.push(pct(closes[cursor], closes[cursor - 1]));
  return standardDeviation(returns);
}

function marketRegime(features) {
  if (features.return7d > 0.05 && features.ema20Gap > 0.01) return "BULL_TREND";
  if (features.return7d < -0.05 && features.ema20Gap < -0.01) return "BEAR_TREND";
  if (features.volatility24h >= 0.012) return "HIGH_VOLATILITY";
  return "RANGE_TRANSITION";
}

function futureOutcome(candles, index, bars) {
  const entry = candles[index].close;
  const path = candles.slice(index + 1, index + bars + 1);
  if (path.length < bars) return null;
  const terminal = path.at(-1).close / entry - 1;
  const mfe = Math.max(...path.map((row) => row.high / entry - 1));
  const mae = Math.min(...path.map((row) => row.low / entry - 1));
  return { return: terminal, mfe, mae };
}

function recentGapQuality(candles, index, lookback = 672) {
  const start = Math.max(1, index - lookback + 1);
  let expected = 0;
  let missing = 0;
  for (let cursor = start; cursor <= index; cursor += 1) {
    expected += 1;
    const deltaBars = Math.round((candles[cursor].timestamp - candles[cursor - 1].timestamp) / BAR_MS);
    if (deltaBars > 1) missing += deltaBars - 1;
  }
  return expected + missing > 0 ? expected / (expected + missing) : 0;
}

function rsiSeries(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

export function buildHistoricalFeatureMatrix(dataset, {
  sampleStrideBars = 4,
  maximumHorizonBars = SIMILARITY_HORIZONS["7d"]
} = {}) {
  const candles = dataset.candles;
  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volumeBtc);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14Line = rsiSeries(closes, 14);
  const rows = [];
  const warmup = Math.max(672, maximumHorizonBars);
  for (let index = warmup; index < candles.length - maximumHorizonBars; index += sampleStrideBars) {
    const close = closes[index];
    const averageVolume = mean(volumes.slice(index - 96, index)) ?? volumes[index];
    const features = {
      return1h: pct(close, closes[index - 4]),
      return4h: pct(close, closes[index - 16]),
      return24h: pct(close, closes[index - 96]),
      return7d: pct(close, closes[index - 672]),
      volatility24h: rollingVolatility(closes, index, 96),
      ema20Gap: pct(close, ema20[index]),
      ema50Gap: pct(close, ema50[index]),
      rsi14: (rsi14Line[index] - 50) / 50,
      volumeRatio24h: averageVolume ? volumes[index] / averageVolume - 1 : 0
    };
    const outcomes = Object.fromEntries(Object.entries(SIMILARITY_HORIZONS).map(([label, bars]) => [label, futureOutcome(candles, index, bars)]));
    rows.push({
      index,
      timestamp: candles[index].timestamp + BAR_MS,
      price: close,
      features,
      regime: marketRegime(features),
      dataQuality: recentGapQuality(candles, index),
      outcomes
    });
  }
  return {
    schemaVersion: 1,
    datasetManifestHash: dataset.manifest.manifestHash,
    featureNames: FEATURE_NAMES,
    sampleStrideBars,
    maximumHorizonBars,
    rows,
    matrixHash: hashObject({ manifest: dataset.manifest.manifestHash, featureNames: FEATURE_NAMES, sampleStrideBars, rows })
  };
}

function queryFeatures(dataset, index) {
  const candles = dataset.candles;
  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volumeBtc);
  const close = closes[index];
  const ema20Line = ema(closes.slice(0, index + 1), 20);
  const ema50Line = ema(closes.slice(0, index + 1), 50);
  const averageVolume = mean(volumes.slice(index - 96, index)) ?? volumes[index];
  const features = {
    return1h: pct(close, closes[index - 4]), return4h: pct(close, closes[index - 16]),
    return24h: pct(close, closes[index - 96]), return7d: pct(close, closes[index - 672]),
    volatility24h: rollingVolatility(closes, index, 96),
    ema20Gap: pct(close, ema20Line.at(-1)), ema50Gap: pct(close, ema50Line.at(-1)),
    rsi14: (rsi(closes.slice(0, index + 1), 14) - 50) / 50,
    volumeRatio24h: averageVolume ? volumes[index] / averageVolume - 1 : 0
  };
  return { timestamp: candles[index].timestamp + BAR_MS, price: close, features, regime: marketRegime(features), dataQuality: recentGapQuality(candles, index) };
}

function weightedStatistics(matches, horizon) {
  const usable = matches.filter((item) => item.row.outcomes[horizon]);
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) return null;
  const weighted = (selector) => usable.reduce((sum, item) => sum + selector(item.row.outcomes[horizon]) * item.weight, 0) / totalWeight;
  const returns = usable.map((item) => item.row.outcomes[horizon].return);
  return {
    samples: usable.length,
    effectiveWeight: round(totalWeight, 4),
    meanReturnPct: round(weighted((outcome) => outcome.return) * 100, 4),
    medianReturnPct: round(quantile(returns, 0.5) * 100, 4),
    p10ReturnPct: round(quantile(returns, 0.1) * 100, 4),
    p90ReturnPct: round(quantile(returns, 0.9) * 100, 4),
    upProbabilityPct: round(usable.filter((item) => item.row.outcomes[horizon].return > 0).reduce((sum, item) => sum + item.weight, 0) / totalWeight * 100, 2),
    downProbabilityPct: round(usable.filter((item) => item.row.outcomes[horizon].return < 0).reduce((sum, item) => sum + item.weight, 0) / totalWeight * 100, 2),
    meanMfePct: round(weighted((outcome) => outcome.mfe) * 100, 4),
    meanMaePct: round(weighted((outcome) => outcome.mae) * 100, 4)
  };
}

export function queryHistoricalSimilarity(dataset, matrix, {
  at = dataset.candles.at(-1).timestamp + BAR_MS,
  neighbors = 80,
  minimumSamples = 30,
  embargoBars = SIMILARITY_HORIZONS["7d"]
} = {}) {
  const queryMs = new Date(at).getTime();
  const queryIndex = dataset.candles.findLastIndex((row) => row.timestamp + BAR_MS <= queryMs);
  if (queryIndex < 672) return { status: "insufficient evidence", reason: "query lacks 7d feature warmup", samples: 0 };
  const query = queryFeatures(dataset, queryIndex);
  const latestAllowedLabelEnd = query.timestamp - embargoBars * BAR_MS;
  const candidates = matrix.rows.filter((row) => row.timestamp + matrix.maximumHorizonBars * BAR_MS <= latestAllowedLabelEnd);
  if (candidates.length < minimumSamples) {
    return { status: "insufficient evidence", reason: `only ${candidates.length} purged historical samples; minimum is ${minimumSamples}`, samples: candidates.length, query };
  }
  const scales = Object.fromEntries(FEATURE_NAMES.map((name) => [name, standardDeviation(candidates.map((row) => row.features[name])) || 1]));
  const distances = candidates.map((row) => {
    const distance = Math.sqrt(FEATURE_NAMES.reduce((sum, name) => sum + ((row.features[name] - query.features[name]) / scales[name]) ** 2, 0) / FEATURE_NAMES.length);
    const regimeWeight = row.regime === query.regime ? 1 : 0.45;
    const ageDays = (query.timestamp - row.timestamp) / (24 * 60 * 60 * 1000);
    const recencyWeight = Math.exp(-Math.max(0, ageDays) / 730);
    const weight = Math.exp(-distance) * regimeWeight * recencyWeight * row.dataQuality;
    return { row, distance, weight };
  }).sort((a, b) => a.distance - b.distance).slice(0, neighbors);
  if (distances.length < minimumSamples || distances.reduce((sum, item) => sum + item.weight, 0) < minimumSamples * 0.05) {
    return { status: "insufficient evidence", reason: "nearest-neighbor effective sample weight is too small", samples: distances.length, query };
  }
  return {
    status: "ok",
    query,
    samplePolicy: {
      neighbors,
      minimumSamples,
      embargoBars,
      purgedFutureOverlap: true,
      weights: ["feature distance", "same market regime", "time recency", "data quality"]
    },
    samples: distances.length,
    nearest: distances.slice(0, 10).map((item) => ({
      timestamp: new Date(item.row.timestamp).toISOString(), price: item.row.price,
      regime: item.row.regime, distance: round(item.distance, 4), weight: round(item.weight, 6), dataQuality: round(item.row.dataQuality, 4)
    })),
    horizons: Object.fromEntries(Object.keys(SIMILARITY_HORIZONS).map((horizon) => [horizon, weightedStatistics(distances, horizon)])),
    disclaimer: "All forward outcomes are used only after the historical decision timestamp for research; they are not inputs to that timestamp's strategy decision."
  };
}

export const SIMILARITY_FEATURES = FEATURE_NAMES;
