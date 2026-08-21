import { runPublicCommand } from "./htx-cli.mjs";

export const MARKET_TASKS = Object.freeze([
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
  ["basis", "mark-price", "basis", { contract_code: "BTC-USDT", period: "60min", basis_price_type: "close", size: 24 }]
]);

export async function collectMarketSnapshot({ concurrency = 3, runner = runPublicCommand } = {}) {
  const output = {};
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < MARKET_TASKS.length) {
      const task = MARKET_TASKS[cursor];
      cursor += 1;
      const [key, skill, subcommand, params] = task;
      output[key] = await runner(skill, subcommand, params);
    }
  });
  await Promise.all(workers);
  return output;
}
