export function paperReport(overrides = {}) {
  const generatedAt = overrides.generatedAt ?? "2026-08-21T01:00:00.000Z";
  return {
    version: "V1",
    mode: "READ_ONLY_PUBLIC_DATA_PAPER_ONLY",
    symbol: "BTC-USDT",
    generatedAt,
    decision: "LONG",
    candidateDecision: "LONG",
    riskGates: [],
    confidencePct: 75,
    finalScore: 45,
    currentPrice: 100,
    latest15mBar: {
      timestamp: new Date(generatedAt).getTime() - 15 * 60 * 1000,
      open: 99,
      high: 101,
      low: 98,
      close: 100
    },
    plan: {
      entryZone: [99, 101],
      stopLoss: 95,
      takeProfit: [109, 111],
      riskReward: [1.8, 2.5],
      waitTriggers: null
    },
    scores: { technical: 50, derivativesDirectional: 30, derivativesPressure: 20 },
    derivatives: { fundingRatePct: 0.01, oiUsd: 1_000_000, pressureScore: 20 },
    bullishReasons: ["4h 趋势偏多", "回踩后量能恢复"],
    bearishReasons: ["Funding 为正"],
    ...overrides
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
