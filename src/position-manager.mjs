import { PAPER_CONFIG } from "./config.mjs";

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

function improvesStop(side, proposed, current) {
  return side === "LONG" ? proposed > current : proposed < current;
}

function targetTouched(side, bar, target) {
  return side === "LONG" ? Number(bar.high) >= target : Number(bar.low) <= target;
}

export function manageSwingRunnerPosition(position, report, config = PAPER_CONFIG) {
  const generatedMs = new Date(report.generatedAt).getTime();
  const latestBarTs = Number(report.latest15mBar?.timestamp);
  const completedBarTs = Number(report.completed15mBar?.timestamp);
  if (!finite(report.currentPrice) || !finite(latestBarTs) || generatedMs - latestBarTs > 30 * 60 * 1000) {
    return { action: "HOLD", reason: "runner 核心价格或K线不够新鲜，只保留硬止损止盈", dataSafe: false };
  }
  if (!finite(completedBarTs) || completedBarTs <= Number(position.last_management_bar_ts ?? position.entry_bar_ts)) {
    return { action: "HOLD", reason: "runner 等待新的完整15分钟K线", dataSafe: true };
  }
  const side = position.side;
  const opposite = side === "LONG" ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const currentPrice = Number(report.currentPrice);
  const entry = Number(position.entry_price);
  const initialStop = Number(position.initial_stop_loss ?? position.stop_loss);
  const initialRiskDistance = Math.abs(entry - initialStop);
  const favorableDistance = direction * (currentPrice - entry);
  const rMultiple = initialRiskDistance > 0 ? favorableDistance / initialRiskDistance : 0;
  const targetR = Math.max(2, Number(position.net_rr ?? position.rr ?? 2));
  const contract = report.strategy?.managementContract ?? {};
  const breakEvenTriggerR = Math.max(1.35, Number(contract.breakEvenTriggerR ?? targetR * 0.60));
  const trailingTriggerR = Math.max(1.75, Number(contract.trailingTriggerR ?? targetR * 0.78));
  const minimumHoldBars = Math.max(1, Number(contract.minimumHoldBarsBeforeSignalExit ?? 8));
  const oppositeBarsForExit = Math.max(2, Number(contract.oppositeSignalBarsForExit ?? 3));
  const heldBars = Math.max(0, Math.floor((completedBarTs - Number(position.entry_bar_ts ?? completedBarTs)) / (15 * 60 * 1000)));
  const ownScore = Number(report.opportunities?.[side]?.score ?? 0);
  const oppositeScore = Number(report.opportunities?.[opposite]?.score ?? 0);
  const clearOpposite = heldBars >= minimumHoldBars
    && report.candidateDecision === opposite
    && oppositeScore >= 65
    && oppositeScore - ownScore >= 9;
  const nextOppositeCount = clearOpposite ? Number(position.opposite_signal_count ?? 0) + 1 : 0;
  if (nextOppositeCount >= oppositeBarsForExit) {
    return {
      action: "EXIT",
      exitReason: favorableDistance > 0 ? "RUNNER_EVIDENCE_REVERSAL_PROFIT" : "RUNNER_EVIDENCE_INVALIDATED",
      reason: `持有 ${heldBars} 根后，连续 ${oppositeBarsForExit} 根完整15分钟K线出现独立反向证据`,
      oppositeSignalCount: nextOppositeCount,
      lastManagementBarTs: completedBarTs,
      dataSafe: true
    };
  }

  let stopLoss = Number(position.stop_loss);
  const takeProfit = Number(position.take_profit);
  const changes = [];
  const exitCostPerBtc = entry * (Number(config.feeRatePerSide) + Number(config.slippageRate)) * 2;
  const breakEven = side === "LONG" ? entry + exitCostPerBtc : entry - exitCostPerBtc;
  if (rMultiple >= breakEvenTriggerR && improvesStop(side, breakEven, stopLoss)) {
    stopLoss = breakEven;
    changes.push(`达到 ${round(breakEvenTriggerR, 2)}R 后才移动到成本后保本`);
  }
  const trendStillStrong = report.candidateDecision === side && ownScore >= 67;
  if (rMultiple >= trailingTriggerR && trendStillStrong) {
    const atr15m = Number(report.timeframes?.["15m"]?.atr14 ?? 0);
    const trailing = side === "LONG"
      ? Number(report.completed15mBar.low) - atr15m * 0.35
      : Number(report.completed15mBar.high) + atr15m * 0.35;
    if (improvesStop(side, trailing, stopLoss)) {
      stopLoss = trailing;
      changes.push(`达到 ${round(trailingTriggerR, 2)}R 后按完整15分钟结构跟踪`);
    }
  }
  const stopChanged = round(stopLoss, 2) !== round(Number(position.stop_loss), 2);
  const reason = changes.length
    ? changes.join("；")
    : clearOpposite
      ? `runner 记录第 ${nextOppositeCount}/${oppositeBarsForExit} 根反向证据，不在 1R 附近机械退出`
      : heldBars < minimumHoldBars
        ? `runner 最短持有观察期 ${heldBars}/${minimumHoldBars} 根，硬止损止盈仍有效`
        : "runner 尚未达到管理阈值，保留原始 2R+ 收益空间";
  return {
    action: changes.length || nextOppositeCount !== Number(position.opposite_signal_count ?? 0) ? "UPDATE" : "HOLD",
    reason,
    stopLoss: round(stopLoss, 2),
    takeProfit: round(takeProfit, 2),
    oppositeSignalCount: nextOppositeCount,
    lastManagementBarTs: completedBarTs,
    stopEffectiveBarTs: stopChanged ? latestBarTs : undefined,
    stopChanged,
    event: {
      type: changes.length ? "RUNNER_RISK_ADJUSTED" : "RUNNER_REVIEWED",
      at: report.generatedAt,
      barTs: completedBarTs,
      reason,
      oldStopLoss: Number(position.stop_loss),
      newStopLoss: round(stopLoss, 2),
      oldTakeProfit: Number(position.take_profit),
      newTakeProfit: round(takeProfit, 2),
      ownScore,
      oppositeScore,
      rMultiple: round(rMultiple, 3),
      targetR: round(targetR, 3),
      breakEvenTriggerR: round(breakEvenTriggerR, 3),
      trailingTriggerR: round(trailingTriggerR, 3),
      heldBars
    },
    dataSafe: true
  };
}

export function manageHardBracketPosition(position, report) {
  const generatedMs = new Date(report.generatedAt).getTime();
  const latestBarTs = Number(report.latest15mBar?.timestamp);
  if (!finite(report.currentPrice) || !finite(latestBarTs) || generatedMs - latestBarTs > 30 * 60 * 1000) {
    return {
      action: "HOLD",
      reason: "突破持仓的行情不够新鲜；不做动态修改，原始硬止损止盈继续有效",
      dataSafe: false
    };
  }
  return {
    action: "HOLD",
    reason: "HARD_BRACKET_HOLD_V1 不移动止损、不延伸止盈、不按短周期反向评分退出；等待原始硬 SL/TP",
    stopLoss: round(Number(position.stop_loss), 2),
    takeProfit: round(Number(position.take_profit), 2),
    oppositeSignalCount: Number(position.opposite_signal_count ?? 0),
    dataSafe: true
  };
}

export function manageOpenPosition(position, report, config = PAPER_CONFIG) {
  if (report.strategy?.positionManagementProfile === "HARD_BRACKET_HOLD_V1") {
    return manageHardBracketPosition(position, report);
  }
  if (report.strategy?.positionManagementProfile === "SWING_RUNNER_V1") {
    return manageSwingRunnerPosition(position, report, config);
  }
  const generatedMs = new Date(report.generatedAt).getTime();
  const latestBarTs = Number(report.latest15mBar?.timestamp);
  const completedBarTs = Number(report.completed15mBar?.timestamp);
  if (!finite(report.currentPrice) || !finite(latestBarTs) || generatedMs - latestBarTs > 30 * 60 * 1000) {
    return { action: "HOLD", reason: "核心价格或K线不够新鲜，本轮只保留原止损止盈，不做动态调整", dataSafe: false };
  }
  if (!finite(completedBarTs) || completedBarTs <= Number(position.last_management_bar_ts ?? position.entry_bar_ts)) {
    return { action: "HOLD", reason: "等待新的完整15分钟K线，避免被5分钟噪音反复触发", dataSafe: true };
  }

  const side = position.side;
  const opposite = side === "LONG" ? "SHORT" : "LONG";
  const direction = side === "LONG" ? 1 : -1;
  const currentPrice = Number(report.currentPrice);
  const entry = Number(position.entry_price);
  const initialStop = Number(position.initial_stop_loss ?? position.stop_loss);
  const initialRiskDistance = Math.abs(entry - initialStop);
  const favorableDistance = direction * (currentPrice - entry);
  const rMultiple = initialRiskDistance > 0 ? favorableDistance / initialRiskDistance : 0;
  const ownScore = Number(report.opportunities?.[side]?.score ?? 0);
  const oppositeScore = Number(report.opportunities?.[opposite]?.score ?? 0);
  const scoreGap = oppositeScore - ownScore;
  const clearOpposite = report.decision === opposite && oppositeScore >= 75 && scoreGap >= 12;
  const originalInvalid = report.candidateDecision === opposite && ownScore <= 40 && oppositeScore >= 65;
  const nextOppositeCount = clearOpposite || originalInvalid
    ? Number(position.opposite_signal_count ?? 0) + 1
    : 0;

  if (nextOppositeCount >= 2) {
    const profitable = favorableDistance > 0;
    return {
      action: "EXIT",
      exitReason: profitable ? "EARLY_PROFIT" : "SIGNAL_INVALIDATED",
      reason: profitable
        ? `连续两根完整15分钟K线显示${opposite === "LONG" ? "多头" : "空头"}优势明显，提前保护已有利润`
        : `原${side === "LONG" ? "多单" : "空单"}逻辑连续两根完整15分钟K线失效，提前控制亏损`,
      oppositeSignalCount: nextOppositeCount,
      lastManagementBarTs: completedBarTs,
      dataSafe: true
    };
  }

  let stopLoss = Number(position.stop_loss);
  let takeProfit = Number(position.take_profit);
  const changes = [];
  const events = position.management?.events ?? [];
  const exitCostPerBtc = entry * (Number(config.feeRatePerSide) + Number(config.slippageRate)) * 2;
  const breakEven = side === "LONG" ? entry + exitCostPerBtc : entry - exitCostPerBtc;
  if (rMultiple >= 1 && improvesStop(side, breakEven, stopLoss)) {
    stopLoss = breakEven;
    changes.push("盈利达到约1R，止损移动到覆盖基础交易成本的保本附近");
  }

  const trendStillStrong = report.candidateDecision === side && ownScore >= 70;
  if (rMultiple >= 1.5 && trendStillStrong) {
    const atr15m = Number(report.timeframes?.["15m"]?.atr14 ?? 0);
    const trailing = side === "LONG"
      ? Number(report.completed15mBar.low) - atr15m * 0.25
      : Number(report.completed15mBar.high) + atr15m * 0.25;
    if (improvesStop(side, trailing, stopLoss)) {
      stopLoss = trailing;
      changes.push("趋势仍强，按完整15分钟结构上移/下移保护止损，让利润继续运行");
    }
  }

  const extensionCount = events.filter((item) => item.type === "TP_EXTENDED").length;
  const oldTargetTouched = targetTouched(side, report.completed15mBar, Number(position.take_profit));
  const targetDistance = direction * (takeProfit - currentPrice);
  if (rMultiple >= 1.2 && ownScore >= 78 && report.candidateDecision === side
    && !oldTargetTouched && targetDistance >= 0 && targetDistance <= initialRiskDistance * 0.6
    && extensionCount < 3) {
    takeProfit += direction * initialRiskDistance * 0.8;
    changes.push("原方向继续加强且尚未触及止盈，将止盈适度顺势延伸");
  }

  const stopChanged = round(stopLoss, 2) !== round(Number(position.stop_loss), 2);
  const reason = changes.length
    ? changes.join("；")
    : clearOpposite || originalInvalid
      ? "出现一次明显反向信号，先观察下一根完整15分钟K线，不机械反手"
      : trendStillStrong
        ? "原方向仍然有效，继续持有"
        : "尚无连续失效证据，维持仓位并保留原风险保护";
  return {
    action: changes.length || nextOppositeCount !== Number(position.opposite_signal_count ?? 0) ? "UPDATE" : "HOLD",
    reason,
    stopLoss: round(stopLoss, 2),
    takeProfit: round(takeProfit, 2),
    oppositeSignalCount: nextOppositeCount,
    lastManagementBarTs: completedBarTs,
    // 止损一旦移动，新的止损只能作用于「止损生效之后」才开始的 K 线。
    stopEffectiveBarTs: stopChanged ? latestBarTs : undefined,
    stopChanged,
    event: {
      type: changes.some((item) => item.includes("止盈")) ? "TP_EXTENDED" : changes.length ? "RISK_ADJUSTED" : "REVIEWED",
      at: report.generatedAt,
      barTs: completedBarTs,
      reason,
      oldStopLoss: Number(position.stop_loss),
      newStopLoss: round(stopLoss, 2),
      oldTakeProfit: Number(position.take_profit),
      newTakeProfit: round(takeProfit, 2),
      ownScore,
      oppositeScore,
      rMultiple: round(rMultiple, 3)
    },
    dataSafe: true
  };
}
