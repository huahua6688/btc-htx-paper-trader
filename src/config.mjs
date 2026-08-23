import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const configuredHealthAge = Number(process.env.PAPER_HEALTH_MAX_AGE_MS);
const projectDatabasePath = fileURLToPath(new URL("../data/paper-trading.sqlite", import.meta.url));
const productionDatabasePath = "/var/lib/btc-htx-paper/paper-trading.sqlite";

export function resolveDatabaseLocation({
  argv = process.argv,
  environment = process.env,
  platform = process.platform,
  pathExists = existsSync
} = {}) {
  const cliValue = argv.find((item) => item.startsWith("--db="))?.slice("--db=".length).trim();
  if (cliValue) return { path: resolve(cliValue), source: "--db" };
  const environmentValue = environment.PAPER_DB_PATH?.trim();
  if (environmentValue) return { path: resolve(environmentValue), source: "PAPER_DB_PATH" };
  if (platform === "linux" && pathExists(productionDatabasePath)) {
    return { path: productionDatabasePath, source: "VPS_PERSISTENT_DEFAULT" };
  }
  return { path: projectDatabasePath, source: "PROJECT_DEFAULT" };
}

const databaseLocation = resolveDatabaseLocation();

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
  slippageRate: 0.0002,
  crowdedPressureMin: 56,
  extremePressureMin: 76,
  minimumLiquidationEvidenceCount: 3,
  breakoutVolumeRatio: 1.05,
  minimumBiasScore: 60,
  minimumImmediateEntryScore: 67,
  minimumDirectionalGap: 7,
  databasePath: databaseLocation.path,
  databasePathSource: databaseLocation.source
});

export const PAPER_EXCHANGE_CONSTRAINTS = Object.freeze({
  source: "PAPER_SAFETY_FALLBACK_NOT_REALTIME_HTX",
  maxLeverage: 20,
  maintenanceMarginRate: null,
  paperMaintenanceMarginRateEstimate: 0.005,
  liquidationSafetyBufferPct: 0.01,
  positionTierMaxNotionalCny: null,
  liquidationFormulaAvailable: false,
  note: "HTX 公共元数据没有提供当前账户对应仓位档位的可靠实时最大杠杆与维持保证金率；20x 仅为 Paper 安全硬上限，不代表 HTX 实时限制。"
});

export const RUNTIME_SETTINGS_DEFAULTS = Object.freeze({
  riskProfile: "BALANCED",
  riskPerTradePct: 0.01,
  maxMarginUsagePct: 0.25,
  userMaxLeverage: 5,
  maxTotalNotionalMultiple: 1,
  allowPyramiding: false,
  maxOpenPositions: 1,
  maxTotalRiskPct: 0.02,
  maxDailyLossPct: 0.03,
  maxConsecutiveLosses: 3,
  newEntriesPaused: false
});

export const RUNTIME_SETTING_LIMITS = Object.freeze({
  riskPerTradePct: [0.001, PAPER_CONFIG.maxRiskPerTradePct],
  maxMarginUsagePct: [0.05, 0.5],
  userMaxLeverage: [1, PAPER_EXCHANGE_CONSTRAINTS.maxLeverage],
  maxTotalNotionalMultiple: [0.1, 5],
  maxOpenPositions: [1, 5],
  maxTotalRiskPct: [0.005, 0.03],
  maxDailyLossPct: [0.005, PAPER_CONFIG.maxDailyLossPct],
  maxConsecutiveLosses: [1, PAPER_CONFIG.maxConsecutiveLosses]
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
  controlPollIntervalMs: 5_000,
  dailySummaryHour: 23,
  dailySummaryMinute: 55,
  stateDirectory: join(dirname(PAPER_CONFIG.databasePath), "notification-state")
});

export const SHADOW_CONFIG = Object.freeze({
  enabled: !["0", "false", "no"].includes(String(process.env.SHADOW_PAPER_ENABLED ?? "true").toLowerCase()),
  databasePath: process.env.SHADOW_DB_PATH?.trim()
    ? resolve(process.env.SHADOW_DB_PATH.trim())
    : join(dirname(PAPER_CONFIG.databasePath), "shadow-challenger.sqlite"),
  strategyVersion: "challenger-technical-v1",
  paperOnly: true
});

export const PAPER_ASSUMPTIONS = Object.freeze({
  fee: "每次开仓和关仓均按成交名义价值的 0.05% 模拟 taker 手续费",
  slippage: "每次模拟成交按 0.02% 不利滑点，毛利润、成本和净利润分开记录",
  conversion: "固定使用 1 USDT = 7.20 CNY，仅用于模拟账户换算",
  funding: "仅在 UTC 00:00/08:00/16:00 附近有对应公开费率时模拟结算；离线错过的历史费率不使用当前值回填",
  fills: "SL 与 TP 同时落在同一可观察 K 线时，保守地先按 SL 成交",
  leverage: "先确定止损、净风险和名义仓位，再用动态杠杆反推保证金；Paper 杠杆硬上限不代表 HTX 实时档位",
  liquidation: "强平价使用隔离保证金和 Paper 维持保证金率估算，明确不等于 HTX 实际强平价格"
});
