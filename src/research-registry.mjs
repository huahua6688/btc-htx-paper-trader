// 研究登记簿。
//
// 研究运行与策略版本必须与生产 Paper 账户彻底分离：研究可以随时重跑、失败、被丢弃，
// 而生产 Paper 的仓位与账本必须是干净的。因此两者使用不同的 SQLite 文件。
//
// 但「分离」不等于「藏起来」：Telegram 需要只读地看到研究到底登记了什么，
// 否则会出现「CLI 已经成功持久化，面板却显示 0 条」的假象。
//
// 三条硬约束：
//   1. 登记簿路径永远不得等于生产 Paper 库或 Shadow 库。
//   2. 长期研究状态不能只存在于随时可删的 research-output/ 临时产物目录里，
//      默认落在与生产库同级的持久化目录。
//   3. Telegram 一律只读打开；查看页面绝不能改动研究数据库，
//      文件不存在或表还没建好时必须安全降级成「尚无研究记录」。

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PAPER_CONFIG, SHADOW_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";

export const RESEARCH_REGISTRY_FILENAME = "research-registry.sqlite";

/**
 * 解析研究登记簿位置。
 *
 * 优先级：--research-db= > PAPER_RESEARCH_DB_PATH > RESEARCH_DB_PATH > 与生产库同级的默认路径。
 * 无论走哪条路径，都不允许指向生产 Paper 库或 Shadow 库。
 */
export function resolveResearchRegistryLocation({
  argv = process.argv,
  environment = process.env,
  paperConfig = PAPER_CONFIG,
  shadowConfig = SHADOW_CONFIG
} = {}) {
  const cliValue = argv.find((item) => item.startsWith("--research-db="))?.slice("--research-db=".length).trim();
  const configured = cliValue
    || environment.PAPER_RESEARCH_DB_PATH?.trim()
    || environment.RESEARCH_DB_PATH?.trim()
    || "";
  const source = cliValue
    ? "--research-db"
    : environment.PAPER_RESEARCH_DB_PATH?.trim()
      ? "PAPER_RESEARCH_DB_PATH"
      : environment.RESEARCH_DB_PATH?.trim()
        ? "RESEARCH_DB_PATH"
        : "PERSISTENT_DEFAULT_NEXT_TO_PAPER_DB";
  // 默认与生产库同级：那是一个真正持久化的目录，而不是随时会被清掉的 research-output/。
  const path = configured
    ? resolve(configured)
    : join(dirname(paperConfig.databasePath), RESEARCH_REGISTRY_FILENAME);

  const forbidden = [paperConfig.databasePath, shadowConfig?.databasePath].filter(Boolean).map((item) => resolve(item));
  if (forbidden.includes(path)) {
    throw new Error(`研究登记簿不得指向生产 Paper / Shadow 数据库：${path}`);
  }
  return { path, source };
}

const location = resolveResearchRegistryLocation();

export const RESEARCH_REGISTRY = Object.freeze({
  path: location.path,
  pathSource: location.source,
  productionPaperDatabasePath: PAPER_CONFIG.databasePath,
  isolatedFromProduction: true
});

function registryConfig(path) {
  return {
    ...PAPER_CONFIG,
    databasePath: path,
    databasePathSource: "RESEARCH_REGISTRY_NOT_PRODUCTION"
  };
}

/**
 * 以可写方式打开登记簿（仅供研究 CLI 使用）。会在需要时建目录并初始化 schema。
 */
export function openResearchRegistry(path = RESEARCH_REGISTRY.path) {
  mkdirSync(dirname(path), { recursive: true });
  return openPaperDatabase(path, registryConfig(path));
}

export function withResearchRegistry(work, path = RESEARCH_REGISTRY.path) {
  const db = openResearchRegistry(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/**
 * 只读访问。任何读取失败（文件不存在、schema 还没建、库被占用）都降级成 fallback，
 * 绝不抛出，也绝不写入任何东西 —— 看一眼面板不应该改变研究数据库。
 */
export function readResearchRegistry(work, { path = RESEARCH_REGISTRY.path, fallback = null } = {}) {
  if (!existsSync(path)) return fallback;
  let db = null;
  try {
    db = openPaperDatabase(path, registryConfig(path), { readOnly: true });
    return work(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* 关闭失败不影响只读展示 */ }
  }
}

const EMPTY_SUMMARY = Object.freeze({
  available: false,
  path: RESEARCH_REGISTRY.path,
  pathSource: RESEARCH_REGISTRY.pathSource,
  researchRuns: [],
  researchRunCount: 0,
  strategyVersions: [],
  strategyVersionCount: 0
});

/**
 * Telegram 用的只读快照。登记簿不存在时返回 available=false，页面显示「尚无研究记录」。
 */
export function researchRegistrySnapshot({ path = RESEARCH_REGISTRY.path, runLimit = 20 } = {}) {
  return readResearchRegistry((db) => {
    const researchRuns = db.getResearchRuns({ limit: runLimit });
    const strategyVersions = db.getStrategyVersions({ limit: 200 }).filter(Boolean);
    return {
      available: true,
      path,
      pathSource: RESEARCH_REGISTRY.pathSource,
      researchRuns,
      researchRunCount: db.getResearchRuns({ limit: 1_000_000 }).length,
      strategyVersions,
      strategyVersionCount: strategyVersions.length
    };
  }, { path, fallback: { ...EMPTY_SUMMARY, path } });
}

export function researchRunsByType(runType, { path = RESEARCH_REGISTRY.path, limit = 1 } = {}) {
  return readResearchRegistry((db) => db.getResearchRuns({ limit, runType }), { path, fallback: [] }) ?? [];
}

/**
 * 登记一次研究运行。status 必须如实反映真实结果：PASSED / PARTIAL / FAILED / BLOCKED。
 */
export function recordResearchRun(record, { path = RESEARCH_REGISTRY.path } = {}) {
  return withResearchRegistry((db) => ({
    id: db.recordResearchRun(record),
    registryPath: path,
    totalRuns: db.getResearchRuns({ limit: 1_000_000 }).length
  }), path);
}

export function registerResearchStrategyVersion(record, { path = RESEARCH_REGISTRY.path } = {}) {
  return withResearchRegistry((db) => db.registerStrategyVersion(record), path);
}
