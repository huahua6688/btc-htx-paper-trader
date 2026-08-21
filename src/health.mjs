import { existsSync } from "node:fs";
import { PAPER_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";
import { evaluateHealth, formatHealth } from "./health-check.mjs";

const json = process.argv.includes("--json");

if (!existsSync(PAPER_CONFIG.databasePath)) {
  const result = {
    healthy: false,
    checkedAt: new Date().toISOString(),
    failures: [`SQLite 文件不存在：${PAPER_CONFIG.databasePath}`],
    monitor: null,
    snapshot: null,
    account: null
  };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatHealth(result)}\n`);
  process.exitCode = 1;
} else {
  let db;
  try {
    db = openPaperDatabase(PAPER_CONFIG.databasePath, PAPER_CONFIG, { readOnly: true });
    const result = evaluateHealth(db);
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatHealth(result)}\n`);
    if (!result.healthy) process.exitCode = 1;
  } catch (error) {
    const result = {
      healthy: false,
      checkedAt: new Date().toISOString(),
      failures: [`SQLite health 检查失败：${error.message}`],
      monitor: null,
      snapshot: null,
      account: null
    };
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatHealth(result)}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
