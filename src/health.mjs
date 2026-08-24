import { existsSync } from "node:fs";
import { PAPER_CONFIG } from "./config.mjs";
import { openPaperDatabase } from "./db.mjs";
import { evaluateHealth, formatHealth } from "./health-check.mjs";
import { TelegramNotifier } from "./telegram-notifier.mjs";
import { buildDataInfrastructureStatus } from "./data-infrastructure-status.mjs";

const json = process.argv.includes("--json");

async function main() {
  let result;
  let db;
  if (!existsSync(PAPER_CONFIG.databasePath)) {
    result = {
      healthy: false,
      checkedAt: new Date().toISOString(),
      failures: [`SQLite 文件不存在：${PAPER_CONFIG.databasePath}`],
      monitor: null,
      snapshot: null,
      account: null
    };
  } else {
    try {
      db = openPaperDatabase(PAPER_CONFIG.databasePath, PAPER_CONFIG, { readOnly: true });
      const infrastructure = await buildDataInfrastructureStatus(db);
      result = evaluateHealth(db, { infrastructure });
    } catch (error) {
      result = {
        healthy: false,
        checkedAt: new Date().toISOString(),
        failures: [`SQLite health 检查失败：${error.message}`],
        monitor: null,
        snapshot: null,
        account: null
      };
    } finally {
      db?.close();
    }
  }

  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatHealth(result)}\n`);
  const telegram = new TelegramNotifier();
  await telegram.notifyHealthResult(result);
  if (!result.healthy) process.exitCode = 1;
}

await main();
