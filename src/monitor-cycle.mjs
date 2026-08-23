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
  if (!positions.length) throw new Error("Paper position group has no open positions");
  const sides = new Set(positions.map((position) => position.side));
  if (sides.size !== 1) throw new Error("Position Group contains mixed LONG/SHORT legs");
  const quantity = positions.reduce((sum, item) => sum + Number(item.quantity_btc), 0);
  const weighted = (field) => quantity > 0
    ? positions.reduce((sum, item) => sum + Number(item[field]) * Number(item.quantity_btc), 0) / quantity
    : null;
  const root = positions[0];
  return {
    ...root,
    id: root.position_group_id,
    position_group_id: root.position_group_id,
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

    const blockedEntrySides = new Map();
    const coreDataFresh = coreMarketDataFreshForTrading(report, market);
    const groups = db.getOpenPositionGroups();
    for (const group of groups) {
      const groupId = group.group_id;
      const originalPositions = group.positions.filter((position) => position.status === "OPEN");
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

      // Position Group 隔离生命周期；组内每个实际仓位仍保留自己的 SL/TP/PnL。
      // 某一腿触发退出不会强制关闭同组其他腿，更不会影响另一方向 group。
      const survivors = [];
      for (const position of positions) {
        const hardExit = evaluatePaperExit(position, report, config, { checkStop: true, checkTarget: false });
        if (hardExit) {
          closeWith(db, position, hardExit, actions);
          blockedEntrySides.set(group.side, "本轮该方向仓位刚完成风险退出，禁止同方向立即重开");
        } else {
          survivors.push(position);
        }
      }

      for (let position of survivors) {
        const management = manageOpenPosition(position, report);
        if (management.action === "EXIT") {
          const exit = evaluatePaperExit(position, report, config, {
            checkStop: false,
            checkTarget: false,
            forcedReason: management.exitReason,
            managementReason: management.reason
          });
          closeWith(db, position, exit, actions);
          blockedEntrySides.set(group.side, "本轮该方向仓位刚因逻辑变化退出，禁止立即重开");
          if (report.decision !== group.side && ["LONG", "SHORT"].includes(report.decision)) {
            blockedEntrySides.set(report.decision, "相反方向刚触发逻辑退出，等待下一轮确认，避免机械平仓后立刻反手");
          }
          continue;
        }
        if (management.action === "UPDATE") {
          position = db.updatePositionManagement(position.id, management);
          actions.push({ type: "POSITION_MANAGED", groupId, position, positions: [position], management });
        } else {
          actions.push({ type: "POSITION_HELD", groupId, position, positions: [position], management });
        }

        const targetExit = evaluatePaperExit(position, report, config, { checkStop: false, checkTarget: true });
        if (targetExit) {
          closeWith(db, position, targetExit, actions);
          blockedEntrySides.set(group.side, "本轮该方向仓位刚止盈，禁止同方向立即重开");
        }
      }
    }

    if (blockedEntrySides.has(report.decision)) {
      noEntry(actions, [blockedEntrySides.get(report.decision)], null);
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
      positionGroups: db.getOpenPositionGroups(),
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
