import { PAPER_CONFIG } from "./config.mjs";

const finite = (value) => Number.isFinite(Number(value));
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

function touchesZone(report, zone) {
  if (!Array.isArray(zone) || zone.length !== 2) return false;
  const low = Number(report.latest15mBar?.low ?? report.currentPrice);
  const high = Number(report.latest15mBar?.high ?? report.currentPrice);
  return finite(low) && finite(high) && low <= Number(zone[1]) && high >= Number(zone[0]);
}

function crossesInvalidation(setup, report) {
  const invalidation = Number(setup.plan.invalidationPrice);
  if (!finite(invalidation)) return true;
  if (setup.side === "LONG") {
    return Number(report.latest15mBar?.low ?? report.currentPrice) <= invalidation;
  }
  return Number(report.latest15mBar?.high ?? report.currentPrice) >= invalidation;
}

function confirmationMatches(setup, report, config) {
  const bar = report.completed15mBar;
  if (!bar || !finite(bar.timestamp) || !finite(bar.close) || !finite(bar.open)) return false;
  if (finite(setup.armed_bar_ts) && Number(bar.timestamp) < Number(setup.armed_bar_ts)) return false;
  const trigger = Number(setup.plan.triggerPrice);
  const directionConfirmed = setup.side === "LONG"
    ? Number(bar.close) >= trigger && Number(bar.close) > Number(bar.open)
    : Number(bar.close) <= trigger && Number(bar.close) < Number(bar.open);
  const volumeConfirmed = setup.setup_type !== "BREAKOUT_CONTINUATION"
    || Number(bar.volumeRatio) >= config.breakoutVolumeRatio;
  return directionConfirmed && volumeConfirmed;
}

export function materializeSetupReport(setup, report) {
  const entry = Number(report.currentPrice);
  const stopLoss = Number(setup.plan.stopLoss);
  const long = setup.side === "LONG";
  const riskDistance = Math.abs(entry - stopLoss);
  const takeProfit = long
    ? [entry + riskDistance * 2.2, entry + riskDistance * 2.8]
    : [entry - riskDistance * 2.2, entry - riskDistance * 2.8];
  const currentRiskPct = Number(report.strategy?.riskPct);
  const setupRiskPct = Number(setup.risk_pct);
  const riskPct = Math.min(
    Number.isFinite(currentRiskPct) && currentRiskPct > 0 ? currentRiskPct : setupRiskPct,
    setupRiskPct
  );
  return {
    ...report,
    decision: setup.side,
    candidateDecision: setup.side,
    riskGates: [],
    plan: {
      entryZone: setup.plan.entryZone,
      stopLoss: round(stopLoss, 2),
      takeProfit: takeProfit.map((value) => round(value, 2)),
      riskReward: [2.2, 2.8],
      waitTriggers: null
    },
    strategy: {
      ...report.strategy,
      state: "TRIGGERED",
      riskPct,
      riskTier: riskPct < PAPER_CONFIG.maxRiskPerTradePct ? "REDUCED" : "NORMAL",
      activeSetupId: setup.id,
      setupType: setup.setup_type,
      setupReasons: setup.reasons
    }
  };
}

export function advanceSetup(db, setup, report, config = PAPER_CONFIG) {
  const now = report.generatedAt;
  if (new Date(now).getTime() >= new Date(setup.expires_at).getTime()) {
    const finished = db.finishSetup(setup.id, "EXPIRED", now, "待触发计划已超过有效期");
    return { type: "SETUP_EXPIRED", setup: finished };
  }
  const bias = report.strategy?.bias;
  if (bias !== setup.side) {
    const finished = db.finishSetup(setup.id, "CANCELLED", now, `4h 方向偏好已转为 ${bias ?? "UNKNOWN"}`);
    return { type: "SETUP_CANCELLED", setup: finished };
  }
  if (crossesInvalidation(setup, report)) {
    const finished = db.finishSetup(setup.id, "INVALIDATED", now, "价格触及计划失效位");
    return { type: "SETUP_INVALIDATED", setup: finished };
  }
  if (report.strategy?.hardBlocks?.length) {
    const finished = db.finishSetup(setup.id, "BLOCKED", now, report.strategy.hardBlocks.join("；"));
    return { type: "SETUP_BLOCKED", setup: finished };
  }

  let current = setup;
  let armedNow = false;
  if (current.status === "WATCHING" && touchesZone(report, current.plan.entryZone)) {
    current = db.armSetup(current.id, now, report.latest15mBar?.timestamp ?? report.completed15mBar?.timestamp);
    armedNow = true;
  }
  if (current.status === "ARMED" && confirmationMatches(current, report, config)) {
    return { type: "SETUP_TRIGGER", setup: current, entryReport: materializeSetupReport(current, report), armedNow };
  }
  return { type: armedNow ? "SETUP_ARMED" : "SETUP_WAITING", setup: current };
}
