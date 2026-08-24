import { runPublicCommand } from "./htx-cli.mjs";

export const MARKET_TASKS = Object.freeze([
  ["spotTicker", "spot-market", "market-detail-merged", { symbol: "btcusdt" }],
  ["spotKline1h", "spot-market", "kline", { symbol: "btcusdt", period: "60min", size: 200 }],
  ["spotDepth", "spot-market", "depth", { symbol: "btcusdt", type: "step0", depth: 20 }],
  ["spotTrades", "spot-market", "history-trade", { symbol: "btcusdt", size: 100 }],
  ["ticker", "futures-market", "detail-merged", { contract_code: "BTC-USDT" }],
  ["kline15m", "futures-market", "kline", { contract_code: "BTC-USDT", period: "15min", size: 200 }],
  ["kline1h", "futures-market", "kline", { contract_code: "BTC-USDT", period: "60min", size: 200 }],
  ["kline4h", "futures-market", "kline", { contract_code: "BTC-USDT", period: "4hour", size: 200 }],
  ["kline1d", "futures-market", "kline", { contract_code: "BTC-USDT", period: "1day", size: 200 }],
  ["depth", "futures-market", "depth", { contract_code: "BTC-USDT", type: "step0" }],
  ["fundingCurrent", "funding-rate", "current", { contract_code: "BTC-USDT" }],
  ["fundingHistory", "funding-rate", "history", { contract_code: "BTC-USDT", page_index: 1, page_size: 30 }],
  ["oiCurrent", "oi-tracker", "current", { contract_code: "BTC-USDT" }],
  ["oiHistory", "oi-tracker", "history", { contract_code: "BTC-USDT", period: "60min", size: 25 }],
  ["eliteAccount", "elite-positioning", "account-ratio", { contract_code: "BTC-USDT", period: "60min" }],
  ["elitePosition", "elite-positioning", "position-ratio", { contract_code: "BTC-USDT", period: "60min" }],
  ["liquidations", "liquidation-stream", "recent", { contract: "BTC-USDT" }],
  ["markPrice", "mark-price", "mark-price-kline", { contract_code: "BTC-USDT", period: "60min", size: 24 }],
  ["premium", "mark-price", "premium-kline", { contract_code: "BTC-USDT", period: "60min", size: 24 }],
  ["basis", "mark-price", "basis", { contract_code: "BTC-USDT", period: "60min", basis_price_type: "close", size: 24 }],
  ["contractElements", "futures-market", "query-elements", { contract_code: "BTC-USDT" }]
]);

export const CORE_MARKET_TASK_KEYS = Object.freeze(new Set(["ticker", "kline15m", "kline1h", "kline4h", "kline1d"]));

// 核心行情失败会让整轮 monitor 变成 ERROR，因此对核心任务做有限次退避重试。
// 次要任务不重试：它们失败只降级，不值得为此拖长整轮采集时间。
export const CORE_RETRY = Object.freeze({ attempts: 3, baseDelayMs: 750, maxDelayMs: 4_000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWithCoreRetry(runner, key, skill, subcommand, params, { retry, delay, warnings }) {
  const attempts = CORE_MARKET_TASK_KEYS.has(key) ? Math.max(1, retry.attempts) : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runner(skill, subcommand, params);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      warnings.push(`${key}: 第 ${attempt} 次采集失败，退避后重试（${error.message}）`);
      await delay(Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs));
    }
  }
  throw lastError;
}

export async function collectMarketSnapshot({
  concurrency = 3,
  runner = runPublicCommand,
  retry = CORE_RETRY,
  delay = sleep
} = {}) {
  const output = {};
  const warnings = [];
  const retryNotices = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < MARKET_TASKS.length) {
      const task = MARKET_TASKS[cursor];
      cursor += 1;
      const [key, skill, subcommand, params] = task;
      try {
        output[key] = await runWithCoreRetry(runner, key, skill, subcommand, params, { retry, delay, warnings: retryNotices });
      } catch (error) {
        if (CORE_MARKET_TASK_KEYS.has(key)) throw error;
        output[key] = null;
        warnings.push(`${key}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
  if (warnings.length) output.collectionWarnings = warnings;
  if (retryNotices.length) output.collectionRetries = retryNotices;
  return output;
}
