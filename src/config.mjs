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
  absoluteMaxRiskPerTradePct: 0.10,
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
  source: "HTX_PUBLIC_PRODUCT_RANGE_WITHOUT_ACCOUNT_ELIGIBILITY",
  minLeverage: 1,
  advertisedProductMaxLeverage: 200,
  maxLeverage: 200,
  maintenanceMarginRate: null,
  paperMaintenanceMarginRateEstimate: 0.005,
  liquidationSafetyBufferPct: 0.01,
  positionTierMaxNotionalCny: null,
  liquidationFormulaAvailable: false,
  note: "HTX 公共规则说明 USDT 本位合约产品范围最高可到 200x；Paper 不连接账户，无法得知 KYC、仓位档位和账户当时实际可用上限，200x 不是对真实账户可用性的承诺。"
});

export const RUNTIME_SETTINGS_DEFAULTS = Object.freeze({
  positionMode: "NET",
  riskProfile: "BALANCED",
  riskMode: "AUTO",
  riskMinPct: 0.005,
  riskMaxPct: 0.05,
  riskManualPct: 0.02,
  riskPerTradePct: 0.05,
  marginMode: "AUTO",
  marginMinUsagePct: 0.10,
  marginMaxUsagePct: 0.80,
  marginManualUsagePct: 0.50,
  maxMarginUsagePct: 0.80,
  leverageMode: "AUTO",
  leverageMin: 1,
  leverageMax: 200,
  leverageManual: 10,
  userMaxLeverage: 200,
  notionalMode: "AUTO",
  notionalMinMultiple: 0.5,
  notionalMaxMultiple: 20,
  notionalManualMultiple: 4,
  maxTotalNotionalMultiple: 20,
  allowPyramiding: false,
  positionLimitMode: "MANUAL",
  positionLimitMin: 1,
  positionLimitMax: 5,
  positionLimitManual: 1,
  maxOpenPositions: 1,
  totalRiskMode: "AUTO",
  totalRiskMinPct: 0.02,
  totalRiskMaxPct: 0.20,
  totalRiskManualPct: 0.06,
  maxTotalRiskPct: 0.11,
  dailyLossMode: "AUTO",
  dailyLossMinPct: 0.03,
  dailyLossMaxPct: 0.20,
  dailyLossManualPct: 0.06,
  maxDailyLossPct: 0.115,
  lossStreakMode: "AUTO",
  lossStreakMin: 3,
  lossStreakMax: 10,
  lossStreakManual: 4,
  maxConsecutiveLosses: 7,
  newEntriesPaused: false,
  indicatorProfile: "AUTO",
  monitorIntervalMinutes: 5,
  // 默认保持冻结 V1.2 的严格数据门禁，升级不会静默改写 Champion 行为。
  // 管理员显式切到 TIERED_DEGRADED 后，实时 monitor 才使用分级降级候选策略。
  dataPolicyMode: "FROZEN_V12_STRICT"
});

export const RUNTIME_SETTING_LIMITS = Object.freeze({
  riskMinPct: [0.001, PAPER_CONFIG.absoluteMaxRiskPerTradePct],
  riskMaxPct: [0.001, PAPER_CONFIG.absoluteMaxRiskPerTradePct],
  riskManualPct: [0.001, PAPER_CONFIG.absoluteMaxRiskPerTradePct],
  riskPerTradePct: [0.001, PAPER_CONFIG.absoluteMaxRiskPerTradePct],
  marginMinUsagePct: [0.01, 0.95],
  marginMaxUsagePct: [0.01, 0.95],
  marginManualUsagePct: [0.01, 0.95],
  maxMarginUsagePct: [0.01, 0.95],
  leverageMin: [1, PAPER_EXCHANGE_CONSTRAINTS.advertisedProductMaxLeverage],
  leverageMax: [1, PAPER_EXCHANGE_CONSTRAINTS.advertisedProductMaxLeverage],
  leverageManual: [1, PAPER_EXCHANGE_CONSTRAINTS.advertisedProductMaxLeverage],
  userMaxLeverage: [1, PAPER_EXCHANGE_CONSTRAINTS.advertisedProductMaxLeverage],
  notionalMinMultiple: [0.1, 200],
  notionalMaxMultiple: [0.1, 200],
  notionalManualMultiple: [0.1, 200],
  maxTotalNotionalMultiple: [0.1, 200],
  positionLimitMin: [1, 10],
  positionLimitMax: [1, 10],
  positionLimitManual: [1, 10],
  maxOpenPositions: [1, 10],
  totalRiskMinPct: [0.001, 0.5],
  totalRiskMaxPct: [0.001, 0.5],
  totalRiskManualPct: [0.001, 0.5],
  maxTotalRiskPct: [0.001, 0.5],
  dailyLossMinPct: [0.005, 1],
  dailyLossMaxPct: [0.005, 1],
  dailyLossManualPct: [0.005, 1],
  maxDailyLossPct: [0.005, 1],
  lossStreakMin: [1, 20],
  lossStreakMax: [1, 20],
  lossStreakManual: [1, 20],
  maxConsecutiveLosses: [1, 20],
  monitorIntervalMinutes: [5, 240]
});

export const HEALTH_CONFIG = Object.freeze({
  maxAgeMs: Number.isFinite(configuredHealthAge) && configuredHealthAge >= 5 * 60 * 1000
    ? configuredHealthAge
    : 15 * 60 * 1000
});

export const TELEGRAM_CONFIG = Object.freeze({
  botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
  chatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? "",
  // 群组里 chat.id 对所有成员都一样，只比对 chat.id 等于把控制权交给整个群。
  // 配置 TELEGRAM_ADMIN_USER_ID 后，只有该发送者本人可以修改任何 Paper 设置。
  adminUserId: process.env.TELEGRAM_ADMIN_USER_ID?.trim() ?? "",
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
