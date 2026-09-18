import test from "node:test";
import assert from "node:assert/strict";
import { adx, atr, macd, rsi, ema } from "../src/indicators.mjs";
import {
  AUDIT_FEATURES,
  AUDIT_WARMUP_BARS,
  adxSeries,
  atrSeries,
  auditSignalEdge,
  averageRanks,
  benjaminiHochberg,
  binomialTailAtLeast,
  bucketEdge,
  buildAuditFeatures,
  emaSeries,
  macdHistogramSeries,
  mulberry32,
  rsiSeries,
  shiftedCorrelation,
  spearman
} from "../src/signal-audit.mjs";

const BAR_MS = 15 * 60 * 1000;
const START = Date.UTC(2024, 8, 1, 0, 0, 0);

/** 可复现的合成 K 线：phi 为逐根收益的 AR(1) 系数，0 表示随机游走（无优势）。 */
function syntheticCandles(count, { seed = 7, phi = 0, volatility = 0.002 } = {}) {
  const random = mulberry32(seed);
  const gaussian = () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const candles = [];
  let price = 60_000;
  let previousReturn = 0;
  for (let index = 0; index < count; index += 1) {
    const step = phi * previousReturn + volatility * gaussian();
    previousReturn = step;
    const open = price;
    price = price * (1 + step);
    const high = Math.max(open, price) * (1 + Math.abs(gaussian()) * volatility * 0.3);
    const low = Math.min(open, price) * (1 - Math.abs(gaussian()) * volatility * 0.3);
    candles.push({
      timestamp: START + index * BAR_MS,
      open, high, low, close: price,
      volumeBtc: 10 + random() * 5
    });
  }
  return candles;
}

function syntheticFunding(candles) {
  const rows = [];
  const step = 32 * BAR_MS;
  for (let ts = candles[0].timestamp; ts <= candles.at(-1).timestamp; ts += step) {
    rows.push({ timestamp: ts, fundingRate: 0.0001 });
  }
  return rows;
}

test("序列版指标与 indicators.mjs 逐值相同 —— 否则审计测的不是策略在用的指标", () => {
  const candles = syntheticCandles(400, { seed: 11 });
  const closes = candles.map((item) => item.close);

  assert.deepEqual(emaSeries(closes, 12), ema(closes, 12));

  // 对每一个前缀都比一次：只比最后一位会放过起点附近的错位。
  for (const length of [40, 120, 399, 400]) {
    const prefixCandles = candles.slice(0, length);
    const prefixCloses = closes.slice(0, length);
    assert.equal(rsiSeries(prefixCloses, 14).at(-1), rsi(prefixCloses, 14), `RSI@${length}`);
    assert.equal(atrSeries(prefixCandles, 14).at(-1), atr(prefixCandles, 14), `ATR@${length}`);
    assert.equal(adxSeries(prefixCandles, 14).at(-1), adx(prefixCandles, 14), `ADX@${length}`);
    assert.equal(macdHistogramSeries(prefixCloses).at(-1), macd(prefixCloses)?.histogram ?? null, `MACD@${length}`);
  }
});

test("ATR/RSI 的 warmup 边界与 indicators.mjs 对齐，不差一位", () => {
  const candles = syntheticCandles(16, { seed: 3 });
  const closes = candles.map((item) => item.close);
  // indicators 在 length <= period 时返回 null，length === period + 1 时出第一个值。
  assert.equal(atr(candles.slice(0, 14), 14), null);
  assert.equal(atrSeries(candles.slice(0, 14), 14).at(-1), null);
  assert.ok(Number.isFinite(atr(candles.slice(0, 15), 14)));
  assert.ok(Number.isFinite(atrSeries(candles.slice(0, 15), 14).at(-1)));
  assert.equal(rsi(closes.slice(0, 14), 14), null);
  assert.equal(rsiSeries(closes.slice(0, 14), 14).at(-1), null);
  assert.ok(Number.isFinite(rsi(closes.slice(0, 15), 14)));
  assert.ok(Number.isFinite(rsiSeries(closes.slice(0, 15), 14).at(-1)));
});

test("平均秩把并列值取平均，而不是按数组顺序排开", () => {
  assert.deepEqual([...averageRanks([10, 20, 30])], [1, 2, 3]);
  assert.deepEqual([...averageRanks([5, 5, 9])], [1.5, 1.5, 3]);
  assert.deepEqual([...averageRanks([9, 5, 5, 1])], [4, 2.5, 2.5, 1]);
});

test("秩相关在单调、反单调与已知输入上取到正确值", () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]) + 1) < 1e-12);
  // 秩 x=[1..5]，秩 y=[1,3,2,5,4]：d^2 之和 = 4，rho = 1 - 6*4/(5*24) = 0.8
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]) - 0.8) < 1e-12);
});

test("循环平移：0 位与整圈等于观测值，中间位置改变结果", () => {
  const x = averageRanks([3, 1, 4, 1, 5, 9, 2, 6]);
  const y = averageRanks([2, 7, 1, 8, 2, 8, 1, 8]);
  const moments = {
    x: { mean: mean(x), sd: sd(x) },
    y: { mean: mean(y), sd: sd(y) }
  };
  const observed = shiftedCorrelation(x, y, 0, moments);
  assert.ok(Math.abs(observed - spearman([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8, 1, 8])) < 1e-12);
  assert.ok(Math.abs(shiftedCorrelation(x, y, x.length, moments) - observed) < 1e-12);
  assert.ok(Math.abs(shiftedCorrelation(x, y, 3, moments) - observed) > 1e-9);
});

test("分位收益按特征值分组，组均值算得出已知答案", () => {
  // 特征 1..20，前向收益 = 特征值。2 组：低 10 个均值 5.5，高 10 个均值 15.5。
  const featureValues = Array.from({ length: 200 }, (_, index) => index + 1);
  const returns = featureValues.map((value) => value);
  const rows = bucketEdge(featureValues, returns, { buckets: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 100);
  assert.equal(rows[0].meanForwardReturnPct, 50.5);
  assert.equal(rows[1].meanForwardReturnPct, 150.5);
  assert.equal(rows[1].positiveRatePct, 100);
});

test("Benjamini–Hochberg 在已知输入上给出已知调整值且单调不减", () => {
  const adjusted = benjaminiHochberg([0.01, 0.02, 0.03, 0.9]);
  // 4 次检验：0.01*4/1=0.04, 0.02*4/2=0.04, 0.03*4/3=0.04, 0.9*4/4=0.9
  assert.deepEqual(adjusted.map((value) => Number(value.toFixed(6))), [0.04, 0.04, 0.04, 0.9]);
  assert.ok(adjusted[0] <= adjusted[3]);
});

// 这是整个模块最重要的一条测试。
//
// 「在一条随机游走上判成没有优势」不是一条好断言 —— alpha=0.05 的检验本来就该在
// 5% 的路径上误报，挑一个种子来断言「必须是 0」，等于把一个 95% 成立的性质写成
// 必然，换个种子就红。真正要钉住的是**零分布的校准**：纯噪音下 p 值必须近似均匀。
// 如果零分布偏窄，这个工具就会在噪音上宣布优势 —— 那正是这个项目一路踩的坑。
const CALIBRATION_FEATURES = AUDIT_FEATURES.filter((item) => ["emaSpreadPct", "momentum4Pct", "adx14", "atrPct"].includes(item.name));

test("零分布必须校准：纯噪音下 p 值近似均匀，族系误报率接近名义水平", () => {
  const paths = 12;
  const pValues = [];
  let flaggedPaths = 0;
  for (let index = 0; index < paths; index += 1) {
    const candles = syntheticCandles(2500, { seed: 1000 + index * 37, phi: 0 });
    const report = auditSignalEdge({ candles, funding: [] }, {
      nullSamples: 500, seed: 9, features: CALIBRATION_FEATURES
    });
    assert.notEqual(report.verdict, "UNDERPOWERED_NULL_SAMPLING", "校准本身不能在采样不足的前提下做");
    if (report.verdict !== "NO_DETECTABLE_EDGE") flaggedPaths += 1;
    for (const item of report.tests) pValues.push(item.pValue);
  }
  // 名义 5%：12 条路径期望 0.6 条误报。>3 条说明零分布偏窄，不是运气。
  assert.ok(flaggedPaths <= 3, `${paths} 条纯噪音路径中有 ${flaggedPaths} 条被判出优势，零分布偏窄`);
  const belowAlpha = pValues.filter((value) => value < 0.05).length / pValues.length;
  assert.ok(belowAlpha <= 0.2, `纯噪音下 p<0.05 的比例为 ${(belowAlpha * 100).toFixed(1)}%，应接近 5%`);
  const sorted = pValues.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median > 0.25 && median < 0.75, `纯噪音下 p 值中位数应接近 0.5，实得 ${median}`);
});

test("采样次数不足以分辨族系 p 值时必须报 UNDERPOWERED，不能输出「没有优势」", () => {
  const candles = syntheticCandles(2500, { seed: 1000, phi: 0 });
  // 族系 p 的下限是 1/(采样次数+1)，不是 (检验数+1)/(采样次数+1) —— 后者是原始 p
  // 顶到分辨率时族系 p 的上界。15 次采样时下限 = 1/16 = 0.0625，低不过 alpha。
  const report = auditSignalEdge({ candles, funding: [] }, {
    nullSamples: 15, seed: 9, features: CALIBRATION_FEATURES
  });
  assert.equal(report.verdict, "UNDERPOWERED_NULL_SAMPLING");
  assert.equal(report.method.underpowered, true);
  assert.ok(report.method.smallestResolvableFamilywisePValue >= 0.05);

  // 采样次数够时不能再触发这个守卫，否则守卫会把工具变成永远说「测不了」。
  const powered = auditSignalEdge({ candles, funding: [] }, {
    nullSamples: 500, seed: 9, features: CALIBRATION_FEATURES
  });
  assert.equal(powered.method.underpowered, false);
  assert.notEqual(powered.verdict, "UNDERPOWERED_NULL_SAMPLING");
});

test("二项尾概率在已知输入上算得对", () => {
  assert.equal(binomialTailAtLeast(0, 12, 0.05), 1);
  assert.equal(binomialTailAtLeast(13, 12, 0.05), 0);
  // P(X>=1 | n=12, p=0.05) = 1 - 0.95^12 = 0.4596
  assert.ok(Math.abs(binomialTailAtLeast(1, 12, 0.05) - (1 - 0.95 ** 12)) < 1e-12);
  // P(X>=2 | n=2, p=0.5) = 0.25
  assert.ok(Math.abs(binomialTailAtLeast(2, 2, 0.5) - 0.25) < 1e-12);
});

test("单个负对照被标记不算方法坏了 —— 那正是名义水平允许的误报", () => {
  const candles = syntheticCandles(4000, { seed: 101, phi: 0 });
  // seed 101 上 adx14 恰好抽到一个小概率值。12 个负对照里出现 1 个，
  // 零假设下的概率是 46%，这是巧合，不是证据。
  const report = auditSignalEdge({ candles, funding: syntheticFunding(candles) }, { nullSamples: 1000, seed: 5 });
  assert.ok(report.negativeControls.flaggedSignificant <= 2);
  assert.ok(report.negativeControls.probabilityAtLeastThisManyUnderNull > 0.05);
  assert.match(report.negativeControls.interpretation, /名义水平之内/);
  // 但落在 alpha 附近的判定必须被点名，不能冒充一个干脆的结论。
  assert.ok(Array.isArray(report.precision.borderlineTests));
});

test("注入真实动量优势后必须被检出 —— 否则这就是一台只会说「没有」的机器", () => {
  const candles = syntheticCandles(6000, { seed: 202, phi: 0.35 });
  const report = auditSignalEdge({ candles, funding: syntheticFunding(candles) }, { nullSamples: 1000, seed: 5 });
  const momentum = report.tests.find((item) => item.feature === "momentum4Pct" && item.horizon === "1h");
  assert.ok(momentum, "1h 上的 momentum4Pct 检验必须存在");
  assert.ok(momentum.ic > 0.1, `注入 AR(1) phi=0.35 后 IC 应显著为正，实得 ${momentum.ic}`);
  assert.ok(momentum.familywisePValue < 0.05);
  assert.notEqual(report.verdict, "NO_DETECTABLE_EDGE");
  assert.notEqual(report.verdict, "UNDERPOWERED_NULL_SAMPLING");
  // 多重检验修正不能把注入的真信号抹平，而且认出来的必须正是被注入的那一个。
  assert.equal(report.familywise.bestFeature, "momentum4Pct");
  assert.equal(report.familywise.bestHorizon, "1h");
  assert.ok(report.familywise.familywisePValue < 0.05);
  // 刻意不断言 |bestIc| > nullBestIcP95：慢特征的原始 IC 噪音带天生就宽，
  // 拿原始 IC 做族系判据会把这个真信号判成「没有」—— 这正是不用 max-T 的原因。
});

test("成本把统计上的优势和可交易的优势分开", () => {
  const candles = syntheticCandles(6000, { seed: 202, phi: 0.35 });
  // 成本抬到极高：任何分位的净优势都必须变负，verdict 不允许还留在可交易。
  const report = auditSignalEdge({ candles, funding: syntheticFunding(candles) }, {
    nullSamples: 1000, seed: 5, feeRatePerSide: 0.05, slippageRate: 0.05
  });
  assert.equal(report.tests.every((item) => item.economics.tradable === false), true);
  assert.equal(report.verdict, "STATISTICAL_ONLY_NOT_TRADABLE");
  assert.ok(report.statisticalOnly.length > 0);
});

test("特征严格 point-in-time：加长未来 K 线不改变已算出的历史特征值", () => {
  const candles = syntheticCandles(1200, { seed: 77 });
  const funding = syntheticFunding(candles);
  const short = buildAuditFeatures(candles.slice(0, 800), funding.filter((row) => row.timestamp <= candles[799].timestamp));
  const long = buildAuditFeatures(candles, funding);
  for (const name of Object.keys(short.columns)) {
    for (let index = AUDIT_WARMUP_BARS; index < 800; index += 1) {
      const a = short.columns[name][index];
      const b = long.columns[name][index];
      if (a === null && b === null) continue;
      assert.ok(Math.abs(a - b) < 1e-9, `${name}@${index} 随未来数据变化了：${a} vs ${b}`);
    }
  }
});

test("数据不足时报错，不返回一个看起来能用的空结论", () => {
  assert.throws(() => auditSignalEdge({ candles: syntheticCandles(300) }), /K 线不足/);
});

function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function sd(values) {
  const m = mean(values);
  let variance = 0;
  for (const value of values) variance += (value - m) ** 2;
  return Math.sqrt(variance / values.length);
}
