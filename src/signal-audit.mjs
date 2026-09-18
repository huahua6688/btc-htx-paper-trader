// 信号信息量审计（Signal Information Audit）
//
// 这个模块回答的问题，和本项目其余部分都不同。
//
// 其余部分问的是：「这套交易规则回测赚不赚钱」。这个问法有个结构性缺陷 ——
// 在一个参数空间里搜索、按回测收益挑 winner，**无论数据里有没有规律，都一定
// 会挑出一个好看的 winner**。V1.2 当年就是这么被挑出来的，现在实盘在亏；
// V2/V3 零成本下仍为负；V4 的正收益落在选择偏差的噪音带里。
// 换言之，「回测好看」这件事本身几乎不携带信息。
//
// 这里问的是前一个问题：**原始数据里到底有没有可预测的信息。**
// 不设入场、不设止损、不算仓位、不做资金管理 —— 只测：
//   特征 X 在 t 时刻的取值，和 t 之后 k 根 K 线的收益，有没有关系？
//   关系有多大？扣掉真实交易成本之后还剩不剩？
//
// 这么做的好处是自由度极少：没有阈值、没有出场规则、没有仓位曲线可以调。
// 结果因此是可证伪的 —— 如果连这里都测不出东西，那不是「参数没调好」，
// 而是这个时间尺度、这个成本水平下没有可交易的方向性信息，再做 V5/V6 也一样。
//
// 三个必须一起看的量，缺一个结论就是错的：
//   1. IC（Spearman 秩相关）—— 关系的方向与强度。
//   2. p 值 —— 但**不用教科书 t 检验**。重叠的前向收益有极强自相关，
//      标准 t 统计量会在纯噪音上宣布显著。这里用循环平移（circular shift）
//      构造零假设分布：平移破坏「特征↔收益」的对应关系，同时保留两条序列
//      各自的自相关结构。这是唯一诚实的零分布。
//   3. 成本后的分位收益 —— IC 可以统计显著却经济上毫无价值。
//      一个 0.05% 的分位价差，在 0.14% 的来回成本面前是负的。
//
// 另外两条防自欺的设计：
//   - 多重检验：F 个特征 × H 个周期 = N 次检验，最好的一次当然好看。
//     这里用 Westfall–Young max-T：所有检验共用同一批平移量，取每批的
//     max|IC| 作为族系零分布。这正面回答「最好那个是真的还是 best-of-N 运气」。
//   - 负对照：ADX、ATR%、成交量比这些**本身没有方向**的特征也进检验。
//     如果它们也「显著」，那是方法坏了，不是市场有规律。

import { PAPER_CONFIG } from "./config.mjs";
import { round } from "./research-utils.mjs";

const BAR_MS = 15 * 60 * 1000;
const SETTLEMENT_BARS = (8 * 60) / 15; // 资金费 8 小时一次 = 32 根 15m K 线

export const AUDIT_HORIZONS = Object.freeze({ "1h": 4, "4h": 16, "12h": 48, "24h": 96 });

// warmup 取足够大的定值，而不是按特征逐个算最小值：
// 各特征起算点不同会让样本区间随特征变化，检验之间就不可比了。
export const AUDIT_WARMUP_BARS = 200;

/**
 * 特征清单。`directional: false` 的是**负对照** —— 它们按定义不含方向信息，
 * 如果检验判它们显著，说明方法本身有问题，不能拿去解读其余结果。
 */
export const AUDIT_FEATURES = Object.freeze([
  { name: "emaSpreadPct", directional: true, note: "(EMA12-EMA48)/close，趋势方向" },
  { name: "macdHistAtr", directional: true, note: "MACD 柱 / ATR，动量方向" },
  { name: "rsi14Centered", directional: true, note: "RSI14-50，动量方向" },
  { name: "breakout20Atr", directional: true, note: "(close - 前20根最高)/ATR，V4 真正在交易的量" },
  { name: "momentum4Pct", directional: true, note: "近 1 小时收益，短期动量" },
  { name: "momentum96Pct", directional: true, note: "近 24 小时收益，日内动量" },
  { name: "fundingBp", directional: true, note: "最近一次已结算资金费率（基点）" },
  { name: "fundingCum9Bp", directional: true, note: "近 9 次结算（3 天）累计资金费率" },
  { name: "adx14", directional: false, note: "负对照：趋势强度，无方向" },
  { name: "atrPct", directional: false, note: "负对照：波动率，无方向" },
  { name: "volumeRatio96", directional: false, note: "负对照：成交量比，无方向" }
]);

// ---------------------------------------------------------------------------
// 序列版指标
//
// indicators.mjs 的实现是「传整段、返回最后一个值」，在每根 K 线上调用一次
// 就是 O(n^2) —— 7 万根 K 线跑不动。这里给出一次成型的序列版。
//
// 序列版必须与 indicators.mjs 的定义**逐值相同**，否则审计测的就不是策略在用
// 的那个指标。test/signal-audit.test.mjs 有断言把两者钉在一起。
// ---------------------------------------------------------------------------

export function emaSeries(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = new Array(values.length);
  result[0] = Number(values[0]);
  for (let index = 1; index < values.length; index += 1) {
    result[index] = Number(values[index]) * alpha + result[index - 1] * (1 - alpha);
  }
  return result;
}

/** Wilder 平滑，前 period 个差分做种子；warmup 之前为 null，不返回一个假的 0。 */
export function rsiSeries(values, period = 14) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

/** 与 indicators.atr 一致：真实波幅序列走 EMA（种子为 ranges[0]），不是 Wilder。 */
export function atrSeries(candles, period = 14) {
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  const smoothed = emaSeries(ranges, period);
  // indicators.atr 在 length <= period 时返回 null，即 length === period + 1（末位下标
  // 为 period）时才出第一个值。这里的掩码必须与那个边界逐位对齐，差一位就会让
  // 序列版和策略在用的 ATR 在起点附近不是同一个东西。
  return smoothed.map((value, index) => (index < period ? null : value));
}

export function macdHistogramSeries(values, fast = 12, slow = 26, signal = 9) {
  const result = new Array(values.length).fill(null);
  if (values.length < slow + signal) return result;
  const fastLine = emaSeries(values, fast);
  const slowLine = emaSeries(values, slow);
  const line = values.map((_, index) => fastLine[index] - slowLine[index]);
  const signalLine = emaSeries(line, signal);
  for (let index = slow + signal - 1; index < values.length; index += 1) {
    result[index] = line[index] - signalLine[index];
  }
  return result;
}

/** 与 indicators.adx 同一套 Wilder 平滑与 DX 递推。 */
export function adxSeries(candles, period = 14) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < period * 2 + 1) return result;
  const trueRanges = [];
  const plusMoves = [];
  const minusMoves = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
    plusMoves.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusMoves.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let smoothedTr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedPlus = plusMoves.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedMinus = minusMoves.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dxValues = [];
  for (let index = period - 1; index < trueRanges.length; index += 1) {
    if (index >= period) {
      smoothedTr = smoothedTr - smoothedTr / period + trueRanges[index];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusMoves[index];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusMoves[index];
    }
    const plusDi = smoothedTr ? smoothedPlus / smoothedTr * 100 : 0;
    const minusDi = smoothedTr ? smoothedMinus / smoothedTr * 100 : 0;
    const denominator = plusDi + minusDi;
    dxValues.push(denominator ? Math.abs(plusDi - minusDi) / denominator * 100 : 0);
  }
  if (dxValues.length < period) return result;
  let value = dxValues.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  // dxValues[j] 对应 candles[j + period]（trueRanges 比 candles 少一位，DX 从 period-1 起算）。
  result[period + period - 1] = value;
  for (let index = period; index < dxValues.length; index += 1) {
    value = (value * (period - 1) + dxValues[index]) / period;
    result[index + period] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 秩与相关
// ---------------------------------------------------------------------------

/** 平均秩：并列取平均，否则并列值会按数组顺序被人为排开。 */
export function averageRanks(values) {
  const length = values.length;
  const order = Array.from({ length }, (_, index) => index)
    .sort((a, b) => values[a] - values[b]);
  const ranks = new Float64Array(length);
  let index = 0;
  while (index < length) {
    let end = index;
    while (end + 1 < length && values[order[end + 1]] === values[order[index]]) end += 1;
    const shared = (index + end) / 2 + 1;
    for (let cursor = index; cursor <= end; cursor += 1) ranks[order[cursor]] = shared;
    index = end + 1;
  }
  return ranks;
}

function momentsOf(values) {
  const length = values.length;
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += values[index];
  const mean = sum / length;
  let variance = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = values[index] - mean;
    variance += delta * delta;
  }
  return { mean, sd: Math.sqrt(variance / length) };
}

/**
 * 把 x 循环左移 shift 位后与 y 的相关系数。shift=0 即观测值。
 *
 * 平移只是 x 的一个置换，均值与标准差不变，所以每次平移只需一遍乘加 ——
 * 这让上万次零分布采样在 7 万根 K 线上可行。
 */
export function shiftedCorrelation(x, y, shift, moments) {
  const length = x.length;
  const offset = ((shift % length) + length) % length;
  let sum = 0;
  for (let index = 0, cursor = offset; cursor < length; index += 1, cursor += 1) {
    sum += x[cursor] * y[index];
  }
  for (let index = length - offset, cursor = 0; index < length; index += 1, cursor += 1) {
    sum += x[cursor] * y[index];
  }
  const denominator = moments.x.sd * moments.y.sd;
  if (!(denominator > 0)) return 0;
  return (sum / length - moments.x.mean * moments.y.mean) / denominator;
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length) throw new Error("Spearman 要求两条序列等长");
  if (xs.length < 3) throw new Error("样本不足，无法计算秩相关");
  const rankX = averageRanks(xs);
  const rankY = averageRanks(ys);
  return shiftedCorrelation(rankX, rankY, 0, { x: momentsOf(rankX), y: momentsOf(rankY) });
}

/** 可复现的 PRNG：零分布必须能逐字节重跑，否则报告里的 p 值无法复核。 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 特征矩阵
// ---------------------------------------------------------------------------

function lastVisibleFundingIndex(funding, timestamp) {
  let low = 0;
  let high = funding.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (funding[middle].timestamp <= timestamp) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/**
 * 逐根 K 线的特征值。严格 point-in-time：第 i 根只用 candles[0..i] 与
 * 在 candles[i] 开盘时刻之前已经结算的资金费，不碰任何未来信息。
 */
export function buildAuditFeatures(candles, fundingRecords = []) {
  const closes = candles.map((candle) => Number(candle.close));
  const funding = fundingRecords
    .map((item) => ({ timestamp: Number(item.timestamp), rate: Number(item.fundingRate) }))
    .filter((item) => Number.isFinite(item.timestamp) && Number.isFinite(item.rate))
    .sort((a, b) => a.timestamp - b.timestamp);

  const ema12 = emaSeries(closes, 12);
  const ema48 = emaSeries(closes, 48);
  const macdHist = macdHistogramSeries(closes);
  const rsi14 = rsiSeries(closes, 14);
  const atr14 = atrSeries(candles, 14);
  const adx14 = adxSeries(candles, 14);

  const columns = Object.fromEntries(AUDIT_FEATURES.map((item) => [item.name, new Array(candles.length).fill(null)]));
  let volumeWindowSum = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const close = closes[index];
    const atr = atr14[index];
    const volume = Number(candles[index].volumeBtc ?? 0);
    // 窗口是「前 96 根」，不含当根：先加入 index-1，再剔除滑出的 index-97，
    // 顺序反过来会让窗口少一根。
    if (index >= 1) volumeWindowSum += Number(candles[index - 1].volumeBtc ?? 0);
    if (index >= 97) volumeWindowSum -= Number(candles[index - 97].volumeBtc ?? 0);

    if (index < AUDIT_WARMUP_BARS) continue;
    if (!(Number.isFinite(atr) && atr > 0)) continue;

    columns.emaSpreadPct[index] = (ema12[index] - ema48[index]) / close * 100;
    columns.macdHistAtr[index] = Number.isFinite(macdHist[index]) ? macdHist[index] / atr : null;
    columns.rsi14Centered[index] = Number.isFinite(rsi14[index]) ? rsi14[index] - 50 : null;
    columns.adx14[index] = Number.isFinite(adx14[index]) ? adx14[index] : null;
    columns.atrPct[index] = atr / close * 100;

    let priorHigh = -Infinity;
    for (let cursor = index - 20; cursor < index; cursor += 1) {
      priorHigh = Math.max(priorHigh, Number(candles[cursor].high));
    }
    columns.breakout20Atr[index] = (close - priorHigh) / atr;
    columns.momentum4Pct[index] = (close / closes[index - 4] - 1) * 100;
    columns.momentum96Pct[index] = (close / closes[index - 96] - 1) * 100;

    const averageVolume = volumeWindowSum / 96;
    columns.volumeRatio96[index] = averageVolume > 0 ? volume / averageVolume : null;

    const fundingIndex = lastVisibleFundingIndex(funding, candles[index].timestamp);
    if (fundingIndex >= 0) {
      columns.fundingBp[index] = funding[fundingIndex].rate * 10_000;
      let cumulative = 0;
      for (let cursor = Math.max(0, fundingIndex - 8); cursor <= fundingIndex; cursor += 1) {
        cumulative += funding[cursor].rate;
      }
      columns.fundingCum9Bp[index] = cumulative * 10_000;
    }
  }

  return { columns, funding };
}

// ---------------------------------------------------------------------------
// 分位收益（经济检验）
// ---------------------------------------------------------------------------

/**
 * 按特征值等分成 buckets 组，报出每组的前向收益均值。
 *
 * 这里刻意**不给标准误与 t 值**：前向窗口互相重叠，样本远不独立，
 * 算出来的标准误会小得离谱。显著性一律以循环平移零分布为准。
 */
export function bucketEdge(featureValues, forwardReturnsPct, { buckets = 10 } = {}) {
  const length = featureValues.length;
  if (length < buckets * 10) throw new Error("样本不足以做分位检验");
  const order = Array.from({ length }, (_, index) => index)
    .sort((a, b) => featureValues[a] - featureValues[b]);
  const result = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * length / buckets);
    const end = Math.floor((bucket + 1) * length / buckets);
    let sum = 0;
    let wins = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      const value = forwardReturnsPct[order[cursor]];
      sum += value;
      if (value > 0) wins += 1;
    }
    const count = end - start;
    result.push({
      bucket: bucket + 1,
      count,
      featureFrom: round(featureValues[order[start]], 6),
      featureTo: round(featureValues[order[end - 1]], 6),
      meanForwardReturnPct: round(sum / count, 6),
      positiveRatePct: round(wins / count * 100, 2)
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Benjamini–Hochberg
// ---------------------------------------------------------------------------

/**
 * 抽样分布里「不小于 value」的比例。smoothing=1 给观测值用（把观测值自己算进去，
 * p 因此永远大于 0）；零分布的每次抽样本身已在计数里，用 smoothing=0。
 */
export function rawPValue(draws, value, sampleCount, smoothing = 1) {
  let extreme = 0;
  for (let index = 0; index < sampleCount; index += 1) if (draws[index] >= value) extreme += 1;
  return (extreme + smoothing) / (sampleCount + 1);
}

/** P(X >= successes)，X ~ Binomial(trials, probability)。用来判断负对照的误报数是否超出名义水平。 */
export function binomialTailAtLeast(successes, trials, probability) {
  if (successes <= 0) return 1;
  if (successes > trials) return 0;
  let term = (1 - probability) ** trials;
  let cumulativeBelow = term;
  for (let k = 1; k < successes; k += 1) {
    term *= ((trials - k + 1) / k) * (probability / (1 - probability));
    cumulativeBelow += term;
  }
  return Math.min(1, Math.max(0, 1 - cumulativeBelow));
}

export function benjaminiHochberg(pValues) {
  const count = pValues.length;
  const order = Array.from({ length: count }, (_, index) => index)
    .sort((a, b) => pValues[a] - pValues[b]);
  const adjusted = new Array(count).fill(1);
  let running = 1;
  for (let rank = count - 1; rank >= 0; rank -= 1) {
    const index = order[rank];
    running = Math.min(running, pValues[index] * count / (rank + 1));
    adjusted[index] = Math.min(1, running);
  }
  return adjusted;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function auditSignalEdge(dataset, {
  horizons = AUDIT_HORIZONS,
  features = AUDIT_FEATURES,
  // 采样次数决定 p 值的最小可分辨值。族系 p 值的下限约为 (检验数+1)/(采样次数+1)，
  // 所以采样次数必须远大于 检验数/alpha ≈ 900，否则「显著」永远达不到。
  // 3000 次在 18.5 万根 K 线上约 1 分钟，留足了余量。
  nullSamples = 3000,
  seed = 20260918,
  buckets = 10,
  feeRatePerSide = PAPER_CONFIG.feeRatePerSide,
  slippageRate = PAPER_CONFIG.slippageRate,
  alpha = 0.05
} = {}) {
  const candles = dataset.candles ?? [];
  if (candles.length < AUDIT_WARMUP_BARS + 500) {
    throw new Error("K 线不足，无法审计：至少需要 warmup 之外 500 根");
  }
  const { columns, funding } = buildAuditFeatures(candles, dataset.funding ?? []);
  const closes = candles.map((candle) => Number(candle.close));

  const roundTripCostPct = 2 * (Number(feeRatePerSide) + Number(slippageRate)) * 100;
  const meanFundingRate = funding.length
    ? funding.reduce((sum, item) => sum + item.rate, 0) / funding.length
    : 0;

  // 所有检验共用同一批平移量：特征之间本来就相关，独立采样会高估检验族的
  // 有效宽度，把族系零分布做得比真实情况更宽松。
  const random = mulberry32(seed);
  const shiftFractions = Array.from({ length: nullSamples }, () => random());

  const tests = [];
  // 每个检验的完整零分布都要留着。族系修正不能只留一个 max —— 见下方 minP 的说明。
  const nullDraws = [];

  for (const [horizonName, horizonBars] of Object.entries(horizons)) {
    const lastUsable = candles.length - horizonBars - 1;
    // 多头持仓期间支付的平均资金费（费率为正时多头付钱）；空头相反。
    const fundingCostPct = meanFundingRate * (horizonBars / SETTLEMENT_BARS) * 100;

    for (const feature of features) {
      const column = columns[feature.name];
      const featureValues = [];
      const forwardReturns = [];
      for (let index = AUDIT_WARMUP_BARS; index <= lastUsable; index += 1) {
        const value = column[index];
        if (!Number.isFinite(value)) continue;
        featureValues.push(value);
        forwardReturns.push((closes[index + horizonBars] / closes[index] - 1) * 100);
      }
      if (featureValues.length < buckets * 10) continue;

      const rankX = averageRanks(featureValues);
      const rankY = averageRanks(forwardReturns);
      const moments = { x: momentsOf(rankX), y: momentsOf(rankY) };
      const ic = shiftedCorrelation(rankX, rankY, 0, moments);

      // 平移量必须大于前向窗口，否则平移后仍残留真实的时序对应关系。
      const length = featureValues.length;
      const minimumShift = horizonBars + 1;
      const draws = new Float64Array(nullSamples);
      for (let sample = 0; sample < nullSamples; sample += 1) {
        const span = length - 2 * minimumShift;
        const shift = minimumShift + Math.floor(shiftFractions[sample] * span);
        draws[sample] = Math.abs(shiftedCorrelation(rankX, rankY, shift, moments));
      }
      nullDraws.push(draws);
      // +1/+1 平滑：p 值永远不写成 0，那会宣称一个采样次数根本支撑不了的精度。
      const pValue = rawPValue(draws, Math.abs(ic), nullSamples);

      const bucketRows = bucketEdge(featureValues, forwardReturns, { buckets });
      const top = bucketRows.at(-1);
      const bottom = bucketRows[0];
      const longNetEdgePct = top.meanForwardReturnPct - roundTripCostPct - fundingCostPct;
      const shortNetEdgePct = -bottom.meanForwardReturnPct - roundTripCostPct + fundingCostPct;

      tests.push({
        feature: feature.name,
        directional: feature.directional,
        note: feature.note,
        horizon: horizonName,
        horizonBars,
        sampleSize: length,
        ic: round(ic, 6),
        pValue: round(pValue, 6),
        buckets: bucketRows,
        economics: {
          roundTripCostPct: round(roundTripCostPct, 4),
          averageFundingCostPct: round(fundingCostPct, 4),
          topBucketMeanPct: top.meanForwardReturnPct,
          bottomBucketMeanPct: bottom.meanForwardReturnPct,
          longNetEdgePct: round(longNetEdgePct, 6),
          shortNetEdgePct: round(shortNetEdgePct, 6),
          tradable: longNetEdgePct > 0 || shortNetEdgePct > 0
        }
      });
    }
  }

  if (!tests.length) throw new Error("没有任何特征凑齐可检验的样本");

  // 多重检验的判据是 Westfall–Young 的 **minP**，既不是 BH，也不是 max-T。
  //
  // 为什么不用 BH：BH 要求原始 p < alpha/N，而原始 p 的下限是 1/(采样次数+1)。
  // 检验一多，BH 的结果就被采样次数顶死在远大于 alpha 的地方，再真的优势也判不出来。
  //
  // 为什么不用比原始 IC 的 max-T：各特征的零分布宽度差一个数量级。
  // emaSpreadPct 这类极强自相关的慢特征，循环平移后仍然能靠巧合对上长段同向行情，
  // 它自己的噪音带就有 0.15；而 momentum4Pct 的噪音带只有 0.03。
  // 用一把尺子量所有检验，等于让慢特征的噪音把快特征的真信号整个盖掉 ——
  // 实测中这会把一个注入的真实优势判成「没有」。
  //
  // minP 的做法：每个检验先跟**自己的**零分布比，换算成各自的 p 值；
  // 然后在每一批平移里取所有检验的最小 p，构成族系零分布。
  // 尺度差异因此被归一掉，而共用同一批平移量又让特征之间的相关性自动计入。
  // BH 仍然照算并写进报告，作为一个更保守的旁证，但不参与判定。
  const minimumNullP = new Float64Array(nullSamples).fill(1);
  const nullPerTestP = nullDraws.map((draws) => {
    const perSample = new Float64Array(nullSamples);
    for (let sample = 0; sample < nullSamples; sample += 1) {
      // 这里的计数把该次抽样自己算进去，与观测值的 +1 平滑取同一个下限 1/(m+1)。
      perSample[sample] = rawPValue(draws, draws[sample], nullSamples, 0);
    }
    return perSample;
  });
  for (const perSample of nullPerTestP) {
    for (let sample = 0; sample < nullSamples; sample += 1) {
      if (perSample[sample] < minimumNullP[sample]) minimumNullP[sample] = perSample[sample];
    }
  }
  const fdr = benjaminiHochberg(tests.map((item) => item.pValue));
  tests.forEach((item, index) => {
    item.fdrAdjustedPValue = round(fdr[index], 6);
    let extreme = 0;
    for (let sample = 0; sample < nullSamples; sample += 1) {
      if (minimumNullP[sample] <= item.pValue) extreme += 1;
    }
    item.familywisePValue = round((extreme + 1) / (nullSamples + 1), 6);
  });

  // 这一段只作直观参照：如果什么特征都没有优势，最好的那次检验的原始 IC
  // 大概长什么样。判定不看它 —— 见上面为什么不用 max-T。
  const rowMaxima = new Float64Array(nullSamples);
  for (const draws of nullDraws) {
    for (let sample = 0; sample < nullSamples; sample += 1) {
      if (draws[sample] > rowMaxima[sample]) rowMaxima[sample] = draws[sample];
    }
  }
  const sortedMaxima = Array.from(rowMaxima).sort((a, b) => a - b);
  const nullBestIcQuantile = (q) => round(sortedMaxima[Math.min(sortedMaxima.length - 1, Math.floor(q * sortedMaxima.length))], 6);

  const bestObserved = tests.reduce((best, item) => (item.familywisePValue < best.familywisePValue
    || (item.familywisePValue === best.familywisePValue && Math.abs(item.ic) > Math.abs(best.ic))
    ? item
    : best), tests[0]);
  const significant = (item) => item.familywisePValue < alpha;
  const controls = tests.filter((item) => !item.directional);
  const controlFalsePositives = controls.filter(significant).length;
  const survivors = tests.filter((item) => item.directional && significant(item) && item.economics.tradable);
  const statisticalOnly = tests.filter((item) => item.directional && significant(item) && !item.economics.tradable);

  // 族系 p 值的下限是 1/(采样次数+1)，不是 (检验数+1)/(采样次数+1)。
  // 后者是「原始 p 已经顶到分辨率下限时」族系 p 的**上界**：那时最多只有
  // 「检验数」个批次能取到各自的最小 p。因为各检验高度相关，实际往往远低于它。
  // 如果连下限都 >= alpha，那么任何结果都判不显著 —— 此时输出「没有优势」是在
  // 撒谎，真相是这次采样根本没有能力回答问题。
  const smallestFamilywisePValue = 1 / (nullSamples + 1);
  const underpowered = smallestFamilywisePValue >= alpha;

  // 分辨率够，不代表精度够。族系 p 是一个用 nullSamples 次抽样估出来的比例，
  // 蒙特卡洛标准误约为 sqrt(p(1-p)/n)。落在 alpha 两倍标准误以内的判定，
  // 换一个随机种子就可能翻面 —— 必须明说，不能让它冒充一个干脆的结论。
  const monteCarloStandardError = (p) => Math.sqrt(Math.max(p * (1 - p), 0) / nullSamples);
  for (const item of tests) {
    const standardError = monteCarloStandardError(item.familywisePValue);
    item.familywisePValueStandardError = round(standardError, 6);
    item.borderline = Math.abs(item.familywisePValue - alpha) < 2 * standardError;
  }
  const borderline = tests.filter((item) => item.borderline);

  const verdict = underpowered
    ? "UNDERPOWERED_NULL_SAMPLING"
    : survivors.length
      ? "TRADABLE_CANDIDATE"
      : statisticalOnly.length
        ? "STATISTICAL_ONLY_NOT_TRADABLE"
        : "NO_DETECTABLE_EDGE";

  return {
    runType: "SIGNAL_INFORMATION_AUDIT",
    generatedAt: new Date().toISOString(),
    verdict,
    coverage: {
      from: new Date(candles[0].timestamp).toISOString(),
      to: new Date(candles.at(-1).timestamp).toISOString(),
      candles: candles.length,
      fundingSettlements: funding.length,
      warmupBars: AUDIT_WARMUP_BARS
    },
    method: {
      statistic: "Spearman rank IC",
      nullModel: "circular shift of the feature series (保留两条序列各自的自相关)",
      nullSamples,
      seed,
      minimumShiftRule: "平移量 > 前向窗口长度",
      multipleTesting: `判据为 Westfall–Young minP 族系检验 (alpha=${alpha})；Benjamini–Hochberg FDR 一并报出但不参与判定`,
      totalTests: tests.length,
      // p 值不可能小于这个数。看到它等于报告里的 p，说明是被采样次数顶住了，
      // 不是数据给出的精度。
      smallestResolvablePValue: round(1 / (nullSamples + 1), 6),
      // 族系 p 值同样低不过这个数；低不过 alpha 就意味着本次审计没有判定能力。
      smallestResolvableFamilywisePValue: round(smallestFamilywisePValue, 6),
      underpowered,
      costModel: `来回成本 ${round(roundTripCostPct, 4)}%（双边手续费 + 双边滑点），另按样本均值计入持仓期资金费`
    },
    familywise: {
      bestFeature: bestObserved.feature,
      bestHorizon: bestObserved.horizon,
      bestIc: bestObserved.ic,
      // 这两行是给人看的参照：如果没有任何特征有优势，「最好的那次检验」的原始 IC
      // 大概会长成这样。注意慢特征的噪音带天生就宽，所以不能拿它直接当判据 ——
      // 判据是下面那个按各自零分布归一后的 familywisePValue。
      nullBestIcMedian: nullBestIcQuantile(0.5),
      nullBestIcP95: nullBestIcQuantile(0.95),
      familywisePValue: bestObserved.familywisePValue
    },
    negativeControls: {
      tested: controls.length,
      flaggedSignificant: controlFalsePositives,
      // alpha=0.05 的检验，本来就该让 5% 的负对照「显著」。看到 1 个就喊方法坏了，
      // 只会制造假警报。要判的是「超出名义水平多少」：这里给的是在零假设下
      // 至少出现这么多个的概率，只有它本身小到不像巧合时才是坏消息。
      expectedUnderNull: round(controls.length * alpha, 3),
      probabilityAtLeastThisManyUnderNull: round(binomialTailAtLeast(controlFalsePositives, controls.length, alpha), 6),
      interpretation: binomialTailAtLeast(controlFalsePositives, controls.length, alpha) < alpha
        ? "负对照被判显著的数量超出名义水平 —— 方法有系统性偏差，本次其余结论不可用"
        : "负对照的误报数量在名义水平之内，方法未见系统性偏差"
    },
    precision: {
      // 判定落在 alpha 两倍蒙特卡洛标准误以内的检验：换个随机种子就可能翻面。
      borderlineTests: borderline.map((item) => ({
        feature: item.feature,
        horizon: item.horizon,
        familywisePValue: item.familywisePValue,
        standardError: item.familywisePValueStandardError
      })),
      note: borderline.length
        ? "有判定处在采样误差范围内，想要一个稳的结论请加大 --null-samples 重跑"
        : "没有判定落在采样误差的边界上"
    },
    survivors,
    statisticalOnly,
    tests,
    limitations: [
      "只测线性单调关系（秩相关）。真实优势若是条件性的（只在某种状态下成立），这里会被稀释成接近 0。",
      "前向收益按固定持有期计算，不含止损止盈。有止损的策略回报分布与此不同，这里给的是信号本身的信息量，不是某个策略的收益。",
      "分位收益的成本按平均资金费计入，不是逐笔路径精确值；短周期上这一项很小，24h 上不可忽略。",
      "循环平移零分布保留各自自相关，但无法保留两条序列间可能存在的共同外生驱动；这会让 p 值偏保守而非偏乐观。",
      "NO_DETECTABLE_EDGE 的含义是「这些特征、这个时间尺度、这个成本水平下测不到」，不等于「市场不可预测」。",
      "本项目为 Paper-only：本审计不构成下单建议。"
    ]
  };
}
