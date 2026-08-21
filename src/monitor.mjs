import { openPaperDatabase } from "./db.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { formatCycle } from "./paper-format.mjs";
import { runMonitorCycle } from "./monitor-cycle.mjs";
import { TelegramNotifier } from "./telegram-notifier.mjs";

const once = process.argv.includes("--once");
const db = openPaperDatabase();
const telegram = new TelegramNotifier();
let stopped = false;
let running = false;
let timer = null;
let databaseClosed = false;

async function cycle() {
  try {
    const result = await runMonitorCycle(db);
    process.stdout.write(`${formatCycle(result)}\n`);
    await telegram.notifyMonitorResult(result, db);
  } catch (error) {
    process.stderr.write(`V1 monitor failed safely: ${error.message}\n`);
    if (once) process.exitCode = 1;
  }
}

async function main() {
  if (once) {
    await cycle();
    db.close();
    return;
  }

  const closeAndExit = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    db.close();
    process.stdout.write("V1 monitor 已停止。\n");
    process.exit(0);
  };

  const loop = async () => {
    if (stopped) return;
    const cycleStartedAt = Date.now();
    running = true;
    await cycle();
    running = false;
    if (stopped) {
      closeAndExit();
      return;
    }
    const elapsed = Date.now() - cycleStartedAt;
    const delay = Math.max(0, PAPER_CONFIG.monitorIntervalMs - elapsed);
    process.stdout.write(`下一次运行：约 ${Math.ceil(delay / 60_000)} 分钟后。按 Ctrl+C 安全停止。\n`);
    timer = setTimeout(loop, delay);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (running) process.stdout.write("正在等待本次只读采集安全结束…\n");
    else closeAndExit();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await loop();
}

await main();
