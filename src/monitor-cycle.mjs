import { analyzeSnapshot } from "./analysis-engine.mjs";
import { PAPER_CONFIG } from "./config.mjs";
import { collectMarketSnapshot } from "./market-data.mjs";
import {
  applyDueFunding,
  evaluatePaperEntry,
  evaluatePaperExit
} from "./paper-engine.mjs";
import { manageOpenPosition } from "./position-manager.mjs";
import { attachMultiLayerMarketContext, coreMarketDataFreshForTrading } from "./market-context.mjs";

function noEntry(actions, reasons, dailyRisk) {
  actions.push({ type: "NO_ENTRY", reasons: [...new Set(reasons)], dailyRisk });
}

function closeWith(db, position, exit, actions) {
  const closed = db.closePosition(position.id, exit);
  actions.push({ type: "CLOSE", position: closed, exit });
  return closed;
}

function aggregatePositionGroup(positions) {
  const quantity = positions.reduce((sum, item) => sum + Number(item.quantity_btc), 0);
  const weighted = (field) => quantity > 0
    ? positions.reduce((sum, item) => sum + Number(item[field]) * Number(item.quantity_btc), 0) / quantity
    : null;
  const root = positions[0];
  return {
    ...root,
    id: root.position_group_id ?? root.id,
    position_group_id: root.position_group_id ?? root.id,
    entry_price: weighted("entry_price"),
    signal_entry_price: weighted("signal_entry_price"),
    initial_stop_loss: weighted("initial_stop_loss"),
    stop_loss: weighted("stop_loss"),
    take_profit: weighted("take_profit"),
    quantity_btc: quantity,
    entry_bar_ts: Math.max(...positions.map((item) => Number(item.entry_bar_ts))),
    last_management_bar_ts: Math.max(...positions.map((item) => Number(item.last_management_bar_ts ?? item.entry_bar_ts))),
    opposite_signal_count: Math.max(...positions.map((item) => Number(item.opposite_signal_count ?? 0))),
    liquidation_price_estimate: null,
    management: root.management ?? { events: [] }
  };
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
    const coreReport = analyze(market);
    const context = attachMultiLayerMarketContext(db, coreReport, market);
    const report = context.report;
    snapshotId = db.insertSnapshot(report);
    db.recordDataSourceObservations(snapshotId, context.observations);
    const actions = [];
    const legacySetup = db.getActiveSetup();
    if (legacySetup) {
      const cancelled = db.finishSetup(
        legacySetup.id,
        "CANCELLED",
        report.generatedAt,
        "V1.2 每轮重新判断，不再沿用固定方向或固定触发价"
      );
      actions.push({ type: "LEGACY_SETUP_CANCELLED", setup: cancelled });
    }

    let closedThisCycle = false;
    const coreDataFresh = coreMarketDataFreshForTrading(report, market);
    const groups = new Map();
    for (const position of db.getOpenPositions()) {
      const key = position.position_group_id ?? position.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(position);
    }
    for (const [groupId, originalPositions] of groups) {
      let positions = [];
      for (const original of originalPositions) {
        const funding = applyDueFunding(db, original, report);
        positions.push(funding.position);
        if (funding.settlements.length) actions.push({ type: "FUNDING", positionId: original.id, settlements: funding.settlements });
        if (funding.skipped) actions.push({ type: "FUNDING_SKIPPED", positionId: original.id, reason: funding.skipped });
      }

      if (!coreDataFresh) {
        actions.push({
          type: "POSITION_HELD",
          position: aggregatePositionGroup(positions),
          positions,
          management: { action: "HOLD", reason: "核心价格/K线不够新鲜，本轮禁止触发止损、止盈、动态调整或新开仓", dataSafe: false }
        });
        continue;
      }

      const hardExits = positions.map((position) => evaluatePaperExit(position, report, config, { checkStop: true, checkTarget: false }));
      const firstHardExit = hardExits.find(Boolean);
      if (firstHardExit) {
        for (let index = 0; index < positions.length; index += 1) {
          const exit = hardExits[index] ?? evaluatePaperExit(positions[index], report, config, {
            checkStop: false,
            checkTarget: false,
            forcedReason: firstHardExit.exitReason,
            managementReason: "同一净仓位组统一执行风险退出"
          });
          closeWith(db, positions[index], exit, actions);
        }
        closedThisCycle = true;
        continue;
      }

      const aggregate = aggregatePositionGroup(positions);
      const management = manageOpenPosition(aggregate, report);
      if (management.action === "EXIT") {
        for (const position of positions) {
          const exit = evaluatePaperExit(position, report, config, {
            checkStop: false,
            checkTarget: false,
            forcedReason: management.exitReason,
            managementReason: management.reason
          });
          closeWith(db, position, exit, actions);
        }
        closedThisCycle = true;
        continue;
      }
      if (management.action === "UPDATE") {
        positions = db.updatePositionGroupManagement(groupId, management);
        actions.push({ type: "POSITION_MANAGED", position: aggregatePositionGroup(positions), positions, management });
      } else {
        actions.push({ type: "POSITION_HELD", position: aggregate, positions, management });
      }

      const targetExits = positions.map((position) => evaluatePaperExit(position, report, config, { checkStop: false, checkTarget: true }));
      const firstTargetExit = targetExits.find(Boolean);
      if (firstTargetExit) {
        for (let index = 0; index < positions.length; index += 1) {
          const exit = targetExits[index] ?? evaluatePaperExit(positions[index], report, config, {
            checkStop: false,
            checkTarget: false,
            forcedReason: "TP",
            managementReason: "同一净仓位组统一止盈"
          });
          closeWith(db, positions[index], exit, actions);
        }
        closedThisCycle = true;
      }
    }

    if (closedThisCycle) {
      noEntry(actions, ["本轮刚完成平仓，等待下一轮重新确认后再考虑新方向，避免机械反手"], null);
    } else if (!coreDataFresh) {
      noEntry(actions, ["核心价格/K线不够新鲜，本轮禁止新开仓，且不会用陈旧价格触发持仓动作"], null);
    } else {
      const gate = evaluatePaperEntry(db, report, config, market);
      if (gate.allowed) {
        try {
          const position = db.openPosition(gate.candidate, snapshotId, {
            settingsRevision: gate.settings.revision,
            settingsUpdatedAt: gate.settings.updatedAt
          });
          actions.push({ type: gate.candidate.isAddOn ? "ADD_POSITION" : "OPEN", position, candidate: gate.candidate });
        } catch (error) {
          if (/运行时设置(?:版本)?已变化|已有模拟仓位|最大同时仓位|总风险|保证金|总名义仓位|相反方向|UNIQUE/.test(error.message)) {
            noEntry(actions, [`原子检查阻止开仓：${error.message}`], gate.dailyRisk);
          } else throw error;
        }
      } else {
        const marketReasons = report.entryAssessment?.missingConditions ?? [];
        const accountReasons = gate.reasons.filter((item) => item !== "当前决策不是 LONG/SHORT");
        noEntry(actions, [...marketReasons, ...accountReasons], gate.dailyRisk);
      }
    }

    const finishedAt = now();
    const message = actions.map((action) => action.type).join(", ") || "NO_ACTION";
    db.recordMonitorRun({ startedAt, finishedAt, status: "OK", message, snapshotId });
    return {
      report,
      snapshotId,
      actions,
      position: db.getOpenPosition(),
      positions: db.getOpenPositions(),
      runtimeSettings: db.getRuntimeSettings(),
      marketSnapshot: market,
      collectionWarnings: market.collectionWarnings ?? []
    };
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
