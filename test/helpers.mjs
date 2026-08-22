export function paperReport(overrides = {}) {
  const generatedAt = overrides.generatedAt ?? "2026-08-21T01:00:00.000Z";
  const completedBarTs = new Date(generatedAt).getTime() - 15 * 60 * 1000;
  const base = {
    version: "V1.2",
    mode: "READ_ONLY_PUBLIC_DATA_PAPER_ONLY",
    symbol: "BTC-USDT",
    generatedAt,
    decision: "LONG",
    candidateDecision: "LONG",
    riskGates: [],
    confidencePct: 75,
    finalScore: 40,
    currentPrice: 100,
    latest15mBar: {
      timestamp: completedBarTs,
      open: 99,
      high: 101,
      low: 98,
      close: 100
    },
    completed15mBar: {
      timestamp: completedBarTs,
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volumeRatio: 1.2
    },
    plan: {
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: [111, 114],
      riskReward: [2.2, 2.8]
    },
    entryAssessment: {
      enterNow: true,
      method: "DIRECT_NOW",
      methodLabel: "当前综合条件允许直接入场",
      reasons: ["多周期趋势与短线时机同向", "衍生品没有否定当前方向"],
      missingConditions: [],
      riskPct: 0.01
    },
    opportunities: {
      LONG: { side: "LONG", score: 75, directionalScore: 76, timingScore: 74, supportingReasons: ["多周期趋势偏多"], opposingReasons: ["Funding 为正"] },
      SHORT: { side: "SHORT", score: 35, directionalScore: 34, timingScore: 36, supportingReasons: ["Funding 为正"], opposingReasons: ["多周期趋势偏多"] }
    },
    scores: { technical: 50, derivativesDirectional: 30, derivativesPressure: 20, longOpportunity: 75, shortOpportunity: 35, scoreGap: 40 },
    derivatives: { fundingRatePct: 0.01, oiUsd: 1_000_000, pressureScore: 20 },
    strategy: {
      version: "V1.2",
      marketRegime: "TRENDING",
      bias: "LONG",
      state: "ENTER_NOW",
      riskPct: 0.01,
      riskTier: "NORMAL",
      hardBlocks: [],
      softWarnings: [],
      entryMethod: "DIRECT_NOW"
    },
    dataQuality: { validForEntry: true, failures: [] },
    bullishReasons: ["4h 趋势偏多", "短周期重新走强"],
    bearishReasons: ["Funding 为正"]
  };
  return {
    ...base,
    ...overrides,
    entryAssessment: overrides.entryAssessment ?? base.entryAssessment,
    opportunities: overrides.opportunities ?? base.opportunities,
    strategy: overrides.strategy ?? base.strategy
  };
}

export function directCandidate(overrides = {}) {
  return {
    symbol: "BTC-USDT",
    side: "LONG",
    openedAt: "2026-08-21T01:00:00.000Z",
    entryBarTs: new Date("2026-08-21T00:45:00.000Z").getTime(),
    entry: 100,
    stopLoss: 95,
    takeProfit: 111,
    rr: 2.1,
    quantityBtc: 0.01,
    riskCny: 1,
    notionalCny: 7.2,
    entryFeeCny: 0.1,
    openingReasons: ["测试模拟理由"],
    ...overrides
  };
}
