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
import { analyzeResearchChallengerV2 } from "./research-challenger-v2.mjs";
import { openMarketArchive } from "./market-archive.mjs";
import { resolveHtxArchiveIdentity } from "./htx-upstream.mjs";
import { analyzeMultiVenueChallenger } from "./multi-venue-challenger.mjs";
import { collectCurrentMultiVenueFunding } from "./multi-venue-catalog.mjs";
import { analyzeBreakoutChallenger } from "./breakout-challenger.mjs";
import { resolveNextMonitorWake } from "./monitor-schedule.mjs";
import { collectMarketSnapshot } from "./market-data.mjs";

const once = process.argv.includes("--once");
const activeShadow = await readJson(resolveResearchPath("active-shadow-strategy.json"));
if (activeShadow && (activeShadow.paperOnly !== true || !["historical-compatible", "tradable-edge", "anti-chase", "research-v2", "multi-venue-v3", "breakout-v4"].includes(activeShadow.strategyType))) {
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
  ? activeShadow.strategyType === "research-v2"
    ? (market) => analyzeResearchChallengerV2(market, activeShadow.parameters, undefined, {
        indicatorProfile: shadowDb?.getRuntimeSettings()?.indicatorProfile ?? activeShadow.parameters?.indicatorProfile
      })
    : activeShadow.strategyType === "multi-venue-v3"
    ? (market) => analyzeMultiVenueChallenger(market, activeShadow.parameters, undefined, {
        indicatorProfile: shadowDb?.getRuntimeSettings()?.indicatorProfile ?? activeShadow.parameters?.indicatorProfile
      })
    : activeShadow.strategyType === "breakout-v4"
    ? (market) => analyzeBreakoutChallenger(market, activeShadow.parameters)
    : activeShadow.strategyType === "anti-chase"
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
let marketArchive = null;
let htxIdentity = null;
try {
  marketArchive = openMarketArchive();
} catch (error) {
  process.stderr.write(`HTX Market Archive disabled safely for this process: ${error.message}\n`);
}
try {
  htxIdentity = await resolveHtxArchiveIdentity();
} catch (error) {
  // resolveHtxArchiveIdentity is already fail-safe; retain this final boundary so
  // provenance collection can never prevent Paper Monitor startup.
  process.stderr.write(`HTX CLI identity unavailable for archive provenance: ${error.message}\n`);
}
let stopped = false;
let running = false;
let timer = null;
let databaseClosed = false;

// marketSnapshot 为 null 表示这一轮是研究边界唤醒：主 Champion 没有跑，
// Shadow 自己采集一次只读行情，绝不复用上一轮的旧快照。
async function shadowCycle(marketSnapshot) {
  if (!shadowDb) return;
  try {
    const shadow = await runMonitorCycle(shadowDb, {
      collect: async () => {
        const snapshot = marketSnapshot ?? await collectMarketSnapshot();
        if (activeShadow?.strategyType !== "multi-venue-v3") return snapshot;
        const funding = await collectCurrentMultiVenueFunding({
          htxFundingHistory: snapshot.fundingHistory
        });
        return { ...snapshot, multiVenue: { funding } };
      },
      analyze: shadowAnalyze
    });
    const types = shadow.actions.map((item) => item.type).join(", ") || "NO_ACTION";
    const edgeEstimates = shadow.report.tradableEdge?.estimates;
    const edgeValue = (side) => edgeEstimates?.[side]?.netTradableEdgePct == null
      ? "证据不足"
      : `${edgeEstimates[side].netTradableEdgePct}%`;
    const edgeText = edgeEstimates ? `；净优势 多 ${edgeValue("LONG")} / 空 ${edgeValue("SHORT")}` : "";
    const scope = marketSnapshot ? "" : "（4h 边界，仅 Shadow）";
    process.stdout.write(`Shadow ${shadowStrategyVersion}${scope}: ${shadow.report.decision}; ${types}${edgeText}; 独立权益 ${Number(shadowDb.getAccount().cash_cny).toFixed(2)} CNY\n`);
  } catch (error) {
    process.stderr.write(`Shadow Paper failed independently: ${error.message}\n`);
  }
}

async function cycle({ shadowOnly = false } = {}) {
  try {
    if (shadowOnly) {
      await shadowCycle(null);
      return;
    }
    const result = await runMonitorCycle(db, {
      archive: marketArchive
        ? (market, { observedAt }) => marketArchive.archiveSnapshot(market, {
            observedAt,
            cliRelease: htxIdentity?.release ?? null,
            cliSha256: htxIdentity?.sha256 ?? null
          })
        : null
    });
    process.stdout.write(`${formatCycle(result)}\n`);
    await telegram.notifyMonitorResult(result, db);
    await shadowCycle(result.marketSnapshot);
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
    marketArchive?.close();
    db.close();
    return;
  }

  const closeAndExit = () => {
    if (databaseClosed) return;
    databaseClosed = true;
    telegramControl.stop();
    shadowDb?.close();
    marketArchive?.close();
    db.close();
    process.stdout.write("V1.2 monitor 已停止。\n");
    process.exit(0);
  };

  const loop = async (shadowOnly = false) => {
    if (stopped) return;
    const cycleStartedAt = Date.now();
    running = true;
    await cycle({ shadowOnly });
    running = false;
    if (stopped) {
      closeAndExit();
      return;
    }
    // 读坏的设置绝不能变成 setTimeout(loop, NaN) —— 那会退化成一个不停敲打 HTX 的忙循环。
    const configuredMinutes = Number(db.getRuntimeSettings()?.monitorIntervalMinutes);
    const configuredInterval = Number.isFinite(configuredMinutes) && configuredMinutes >= 1
      ? configuredMinutes * 60_000
      : PAPER_CONFIG.monitorIntervalMs;
    const wake = resolveNextMonitorWake({
      cycleStartedAtMs: cycleStartedAt,
      cycleFinishedAtMs: Date.now(),
      configuredIntervalMs: configuredInterval,
      activeShadowStrategyType: activeShadow?.strategyType ?? null
    });
    const scope = wake.shadowOnly ? "（4h 边界，仅 Shadow，不改变 V1.2 生产节奏）" : "";
    process.stdout.write(`下一次运行：约 ${Math.ceil(wake.delayMs / 60_000)} 分钟后${scope}。按 Ctrl+C 安全停止。\n`);
    timer = setTimeout(() => loop(wake.shadowOnly), wake.delayMs);
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
