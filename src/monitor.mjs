import { openPaperDatabase } from "./db.mjs";
import { PAPER_CONFIG, SHADOW_CONFIG } from "./config.mjs";
import { formatCycle } from "./paper-format.mjs";
import { runMonitorCycle } from "./monitor-cycle.mjs";
import { TelegramNotifier } from "./telegram-notifier.mjs";
import { TelegramControlPanel } from "./telegram-control.mjs";
import { analyzeChallenger, analyzeHistoricalCompatible } from "./challenger-strategy.mjs";
import { readJson, resolveResearchPath } from "./research-utils.mjs";
import { analyzeTradableEdge } from "./tradable-edge.mjs";
import { analyzeAntiChaseChallenger } from "./anti-chase-challenger.mjs";

const once = process.argv.includes("--once");
const activeShadow = await readJson(resolveResearchPath("active-shadow-strategy.json"));
if (activeShadow && (activeShadow.paperOnly !== true || !["historical-compatible", "tradable-edge", "anti-chase"].includes(activeShadow.strategyType))) {
  throw new Error("Active Shadow strategy is not an approved Paper-only research configuration");
}
const activeEdgeModel = activeShadow?.strategyType === "tradable-edge"
  ? await readJson(activeShadow.modelPath)
  : null;
if (activeShadow?.strategyType === "tradable-edge"
  && (!activeEdgeModel || activeEdgeModel.modelHash !== activeShadow.modelHash)) {
  throw new Error("Active Tradable Edge Shadow model is missing or its hash does not match");
}
const shadowDatabasePath = activeShadow?.databasePath ?? SHADOW_CONFIG.databasePath;
const shadowStrategyVersion = activeShadow?.version ?? SHADOW_CONFIG.strategyVersion;
const shadowAnalyze = activeShadow
  ? activeShadow.strategyType === "anti-chase"
    ? (market) => analyzeAntiChaseChallenger(market, activeShadow.parameters)
    : activeShadow.strategyType === "tradable-edge"
    ? (market) => analyzeTradableEdge(market, {
        ...activeShadow.parameters,
        model: activeEdgeModel,
        version: activeShadow.version
      })
    : (market) => analyzeHistoricalCompatible(market, activeShadow.parameters)
  : analyzeChallenger;
const db = openPaperDatabase();
const shadowDb = SHADOW_CONFIG.enabled
  ? openPaperDatabase(shadowDatabasePath, {
      ...PAPER_CONFIG,
      databasePath: shadowDatabasePath,
      databasePathSource: "SHADOW_PAPER"
    })
  : null;
const telegram = new TelegramNotifier();
const telegramControl = new TelegramControlPanel(db);
let stopped = false;
let running = false;
let timer = null;
let databaseClosed = false;

async function cycle() {
  try {
    const result = await runMonitorCycle(db);
    process.stdout.write(`${formatCycle(result)}\n`);
    await telegram.notifyMonitorResult(result, db);
    if (shadowDb) {
      try {
        const shadow = await runMonitorCycle(shadowDb, {
          collect: async () => result.marketSnapshot,
          analyze: shadowAnalyze
        });
        const types = shadow.actions.map((item) => item.type).join(", ") || "NO_ACTION";
        const edgeEstimates = shadow.report.tradableEdge?.estimates;
        const edgeValue = (side) => edgeEstimates?.[side]?.netTradableEdgePct == null
          ? "证据不足"
          : `${edgeEstimates[side].netTradableEdgePct}%`;
        const edgeText = edgeEstimates ? `；净优势 多 ${edgeValue("LONG")} / 空 ${edgeValue("SHORT")}` : "";
        process.stdout.write(`Shadow ${shadowStrategyVersion}: ${shadow.report.decision}; ${types}${edgeText}; 独立权益 ${Number(shadowDb.getAccount().cash_cny).toFixed(2)} CNY\n`);
      } catch (error) {
        process.stderr.write(`Shadow Paper failed independently: ${error.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`V1.2 monitor failed safely: ${error.message}\n`);
    if (once) process.exitCode = 1;
  }
}

async function main() {
  if (once) {
    await telegramControl.pollOnce();
    await cycle();
    shadowDb?.close();
    db.close();
    return;
  }

  const closeAndExit = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    telegramControl.stop();
    shadowDb?.close();
    db.close();
    process.stdout.write("V1.2 monitor 已停止。\n");
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
  telegramControl.start();
  await loop();
}

await main();
