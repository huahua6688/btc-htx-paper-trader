export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

export function percentChange(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous !== 0
    ? ((current - previous) / previous) * 100
    : null;
}

export function ema(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [Number(values[0])];
  for (let index = 1; index < values.length; index += 1) {
    result.push(Number(values[index]) * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return ema(ranges, period).at(-1);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = values.map((_, index) => fastLine[index] - slowLine[index]);
  const signalLine = ema(line, signal);
  return {
    line: line.at(-1),
    signal: signalLine.at(-1),
    histogram: line.at(-1) - signalLine.at(-1)
  };
}

export function percentileRank(values, value) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length || !Number.isFinite(value)) return null;
  const belowOrEqual = valid.filter((item) => item <= value).length;
  return (belowOrEqual / valid.length) * 100;
}
