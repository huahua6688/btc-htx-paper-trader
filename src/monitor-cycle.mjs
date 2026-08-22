import { analyzeSnapshot } from "./analysis-engine.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { collectMarketSnapshot } from "./market-data.mjs";
import { applyDueFunding, evaluatePaperEntry, evaluatePaperExit, getDailyRiskState } from "./paper-engine.mjs";
import { advanceSetup } from "./setup-engine.mjs";

function noEntry(actions, reasons, dailyRisk) {
  actions.push({ type: "NO_ENTRY", reasons: [...new Set(reasons)], dailyRisk });
}

function handleSetupTransition(db, transition, report, snapshotId, actions, config) {
  if (transition.type === "SETUP_TRIGGER") {
    const gate = evaluatePaperEntry(db, transition.entryReport, config);
    if (gate.allowed) {
      const position = db.openPosition(gate.candidate, snapshotId);
      const setup = db.finishSetup(transition.setup.id, "TRIGGERED", report.generatedAt, "15m 确认条件满足并创建模拟仓位");
      actions.push({ type: "OPEN", position, setup });
      return { position, effectiveReport: transition.entryReport };
    }
    const setup = db.finishSetup(transition.setup.id, "BLOCKED", report.generatedAt, gate.reasons.join("；"));
    noEntry(actions, gate.reasons, gate.dailyRisk);
    return { position: null, effectiveReport: report, setup };
  }
  if (transition.type !== "SETUP_WAITING") actions.push(transition);
  else actions.push({ type: "SETUP_WAITING", setup: transition.setup });
  return { position: null, effectiveReport: report };
}

export async function runMonitorCycle(db, {
  collect = collectMarketSnapshot,
  analyze = analyzeSnapshot,
  config = PAPER_CONFIG,
  now = () => new Date().toISOString()
} = {}) {
  const startedAt = now();
  let snapshotId = null;
  try {
    const market = await collect();
    let report = analyze(market);
    snapshotId = db.insertSnapshot(report);
    let position = db.getOpenPosition();
    const actions = [];

    if (position) {
      const funding = applyDueFunding(db, position, report);
      position = funding.position;
      if (funding.settlements.length) actions.push({ type: "FUNDING", settlements: funding.settlements });
      const exit = evaluatePaperExit(position, report, config);
      if (exit) {
        position = db.closePosition(position.id, exit);
        actions.push({ type: "CLOSE", position, exit });
      }
    } else {
      const dailyRisk = getDailyRiskState(db, report.generatedAt, config);
      let setup = db.getActiveSetup();
      if (setup) {
        const handled = handleSetupTransition(
          db,
          advanceSetup(db, setup, report, config),
          report,
          snapshotId,
          actions,
          config
        );
        position = handled.position;
        if (handled.effectiveReport !== report) {
          report = handled.effectiveReport;
          db.updateSnapshotReport(snapshotId, report);
        }
      } else if (dailyRisk.paused) {
        noEntry(actions, dailyRisk.pauseReasons, dailyRisk);
      } else if (report.strategy?.hardBlocks?.length) {
        noEntry(actions, report.strategy.hardBlocks, dailyRisk);
      } else if (report.strategy?.setupProposal) {
        setup = db.createSetup(report.strategy.setupProposal, snapshotId);
        actions.push({ type: "SETUP_CREATED", setup });
        const handled = handleSetupTransition(
          db,
          advanceSetup(db, setup, report, config),
          report,
          snapshotId,
          actions,
          config
        );
        position = handled.position;
        if (handled.effectiveReport !== report) {
          report = handled.effectiveReport;
          db.updateSnapshotReport(snapshotId, report);
        }
      } else {
        noEntry(actions, ["当前没有满足 4h 方向与 1h 结构的待触发计划"], dailyRisk);
      }
    }

    const finishedAt = now();
    const message = actions.map((action) => action.type).join(", ") || "NO_ACTION";
    db.recordMonitorRun({ startedAt, finishedAt, status: "OK", message, snapshotId });
    return { report, snapshotId, actions, position };
  } catch (error) {
    db.recordMonitorRun({
      startedAt,
      finishedAt: now(),
      status: "ERROR",
      message: error.message,
      snapshotId
    });
    throw error;
  }
}
