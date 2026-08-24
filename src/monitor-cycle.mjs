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
import { classifyDataQuality, DATA_POLICIES } from "./data-quality.mjs";
import { applyTieredDataPolicy, DATA_TIERED_PARAMETERS } from "./data-tiered-strategy.mjs";

function noEntry(actions, reasons, dailyRisk, { reasonCodes = [], rejections = [] } = {}) {
  actions.push({
    type: "NO_ENTRY",
    reasons: [...new Set(reasons)],
    reasonCodes: [...new Set(reasonCodes)],
    rejections,
    dailyRisk
  });
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
    // 分级数据质量始终计算并展示（DATA_OK / DATA_DEGRADED / DATA_BLOCKED）。
    // 是否据此改变交易行为由 dataPolicyMode 决定：默认 FROZEN_V12_STRICT 只做展示，
    // 冻结 V1.2 的判断保持逐字节可复现；只有管理员显式切到 TIERED_DEGRADED，
    // 才会启用 V1.3-DATA-TIERED 候选的降级放行逻辑。
    const policyMode = db.getRuntimeSettings().dataPolicyMode === "TIERED_DEGRADED"
      ? DATA_POLICIES.TIERED_DEGRADED
      : DATA_POLICIES.FROZEN_V12_STRICT;
    const dataQualityGate = classifyDataQuality(coreReport, market, { policy: policyMode });
    const policedReport = policyMode === DATA_POLICIES.TIERED_DEGRADED
      ? applyTieredDataPolicy(coreReport, market, dataQualityGate, DATA_TIERED_PARAMETERS, config)
      : coreReport;
    const context = attachMultiLayerMarketContext(db, policedReport, market);
    const report = context.report;
    report.dataQualityGate = dataQualityGate;
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
        const management = manageOpenPosition(position, report, config);
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

    let entryGate = null;
    if (blockedEntrySides.has(report.decision)) {
      noEntry(actions, [blockedEntrySides.get(report.decision)], null, { reasonCodes: ["SAME_SIDE_COOLDOWN"] });
    } else if (!coreDataFresh) {
      noEntry(actions, ["核心价格/K线不够新鲜，本轮禁止新开仓，且不会用陈旧价格触发持仓动作"], null, {
        reasonCodes: ["CORE_DATA_STALE"]
      });
    } else {
      const gate = evaluatePaperEntry(db, report, config, market);
      entryGate = gate;
      if (gate.allowed) {
        try {
          const position = db.openPosition(gate.candidate, snapshotId, {
            settingsRevision: gate.settings.revision,
            settingsUpdatedAt: gate.settings.updatedAt
          });
          actions.push({ type: gate.candidate.isAddOn ? "ADD_POSITION" : "OPEN", position, candidate: gate.candidate });
        } catch (error) {
          if (/运行时设置(?:版本)?已变化|已有模拟仓位|最大同时仓位|总风险|保证金|总名义仓位|相反方向|UNIQUE/.test(error.message)) {
            noEntry(actions, [`原子检查阻止开仓：${error.message}`], gate.dailyRisk, {
              reasonCodes: ["ATOMIC_RECHECK_BLOCKED"]
            });
          } else throw error;
        }
      } else {
        const marketReasons = report.entryAssessment?.missingConditions ?? [];
        const accountRejections = gate.rejections.filter((item) => item.code !== "DECISION_NOT_DIRECTIONAL");
        noEntry(actions, [...marketReasons, ...accountRejections.map((item) => item.message)], gate.dailyRisk, {
          reasonCodes: accountRejections.map((item) => item.code),
          rejections: accountRejections
        });
      }
    }

    if (snapshotId !== null && entryGate) {
      db.updateSnapshotReport(snapshotId, {
        dynamicLimits: entryGate.dynamicLimits,
        exposure: entryGate.exposure,
        entryRejectionCodes: entryGate.reasonCodes,
        sizingRejection: entryGate.sizingRejection
      });
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
      dataQualityGate,
      dataPolicyMode: policyMode,
      entryGate,
      dynamicLimits: entryGate?.dynamicLimits ?? null,
      exposure: entryGate?.exposure ?? null,
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
