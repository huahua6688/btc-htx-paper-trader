import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const configuredDatabasePath = process.env.PAPER_DB_PATH?.trim();
const configuredHealthAge = Number(process.env.PAPER_HEALTH_MAX_AGE_MS);

export const PAPER_CONFIG = Object.freeze({
  version: "V1.2",
  symbol: "BTC-USDT",
  monitorIntervalMs: 5 * 60 * 1000,
  initialCapitalCny: 1_000,
  usdtCnyRate: 7.2,
  maxRiskPerTradePct: 0.01,
  reducedRiskPerTradePct: 0.005,
  maxDailyLossPct: 0.03,
  maxConsecutiveLosses: 3,
  minimumRiskReward: 2,
  feeRatePerSide: 0.0005,
  maxNotionalMultiple: 1,
  crowdedPressureMin: 56,
  extremePressureMin: 76,
  minimumLiquidationEvidenceCount: 3,
  breakoutVolumeRatio: 1.05,
  minimumBiasScore: 60,
  minimumImmediateEntryScore: 67,
  minimumDirectionalGap: 7,
  databasePath: configuredDatabasePath
    ? resolve(configuredDatabasePath)
    : fileURLToPath(new URL("../data/paper-trading.sqlite", import.meta.url))
});

export const HEALTH_CONFIG = Object.freeze({
  maxAgeMs: Number.isFinite(configuredHealthAge) && configuredHealthAge >= 5 * 60 * 1000
    ? configuredHealthAge
    : 15 * 60 * 1000
});

export const TELEGRAM_CONFIG = Object.freeze({
  botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
  chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
  apiBaseUrl: "https://api.telegram.org",
  timeoutMs: 10_000,
  dailySummaryHour: 23,
  dailySummaryMinute: 55,
  stateDirectory: join(dirname(PAPER_CONFIG.databasePath), "notification-state")
});

export const PAPER_ASSUMPTIONS = Object.freeze({
  fee: "每次开仓和关仓均按成交名义价值的 0.05% 模拟 taker 手续费",
  conversion: "固定使用 1 USDT = 7.20 CNY，仅用于模拟账户换算",
  funding: "按 HTX 当前公开 Funding Rate，在 UTC 00:00/08:00/16:00 的跨越点模拟结算",
  fills: "SL 与 TP 同时落在同一可观察 K 线时，保守地先按 SL 成交",
  leverage: "名义敞口不超过当前模拟现金的 1 倍"
});
