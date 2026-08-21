import { analyzeSnapshot } from "./analysis-engine.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { collectMarketSnapshot } from "./market-data.mjs";
import { applyDueFunding, evaluatePaperEntry, evaluatePaperExit } from "./paper-engine.mjs";

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
    const report = analyze(market);
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
      const gate = evaluatePaperEntry(db, report, config);
      if (gate.allowed) {
        position = db.openPosition(gate.candidate, snapshotId);
        actions.push({ type: "OPEN", position });
      } else {
        actions.push({ type: "NO_ENTRY", reasons: gate.reasons, dailyRisk: gate.dailyRisk });
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
