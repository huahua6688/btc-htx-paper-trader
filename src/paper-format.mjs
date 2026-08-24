import {
  calculateAccountState,
  calculateUnrealized,
  calculatePerformance,
  getDailyRiskState
} from "./paper-engine.mjs";
import { PAPER_ASSUMPTIONS, PAPER_EXCHANGE_CONSTRAINTS } from "./config.mjs";
import { controlModeChinese, riskProfileChinese } from "./runtime-settings.mjs";

const n = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pf = (value) => value === Infinity ? "∞" : value === null ? "—" : n(value, 2);
const pct = (value, digits = 2) => value === null || value === undefined ? "—" : `${n(Number(value) * 100, digits)}%`;

export function formatCycle(result) {
  const report = result.report;
  const lines = [
    `V1.2 monitor 完成：${report.generatedAt}`,
    `当前 BTC：${n(report.currentPrice, 1)} USDT`,
    `系统判断：${report.decision}（信号质量分 ${report.signalQualityScore ?? report.confidencePct}/100，排序指标，不是胜率或概率）`,
    `双向机会：做多 ${report.opportunities?.LONG?.score ?? "—"} / 做空 ${report.opportunities?.SHORT?.score ?? "—"}`,
    `是否现在入场：${report.entryAssessment?.enterNow ? "是" : "否"}；${report.entryAssessment?.methodLabel ?? "继续等待"}`,
    ...((report.entryAssessment?.reasons ?? []).slice(0, 5).map((item) => `- ${item}`))
  ];
  for (const action of result.actions) {
    if (["OPEN", "ADD_POSITION"].includes(action.type)) {
      const p = action.position;
      lines.push(`${action.type === "ADD_POSITION" ? "受控模拟加仓" : "模拟开仓"}：${p.side} #${p.id}，保证金 ${n(p.margin_cny)} CNY / ${n(p.leverage)}x / 名义 ${n(p.notional_cny)} CNY / 净 RR 1:${n(p.net_rr ?? p.rr)}`);
    } else if (action.type === "CLOSE") {
      lines.push(`模拟平仓：${action.exit.managementReason ?? action.exit.exitReason}，毛收益 ${n(action.position.gross_pnl_cny)} / 净收益 ${n(action.position.net_pnl_cny)} CNY`);
    } else if (action.type === "POSITION_MANAGED") {
      lines.push(`动态持仓调整：#${action.position.id}，${action.management.reason}；SL ${n(action.position.stop_loss, 1)} / TP ${n(action.position.take_profit, 1)}`);
    } else if (action.type === "POSITION_HELD") {
      lines.push(`继续持有：#${action.position.id}，${action.management.reason}`);
    } else if (action.type === "FUNDING") {
      const impact = action.settlements.reduce((sum, item) => sum + item.cashflowCny, 0);
      lines.push(`Funding 模拟结算：${action.settlements.length} 次，影响 ${n(impact, 4)} CNY`);
    } else if (action.type === "FUNDING_SKIPPED") {
      lines.push(`Funding：${action.reason}`);
    } else if (action.type === "NO_ENTRY") {
      lines.push(`未开新仓：${action.reasons.join("；")}`);
    } else if (action.type === "LEGACY_SETUP_CANCELLED") {
      lines.push(`已停用旧版固定计划：#${action.setup.id}。`);
    }
  }
  if (result.collectionWarnings?.length) lines.push(`次要公开数据降级：${result.collectionWarnings.join("；")}`);
  lines.push("安全：仅公开行情 + 本地模拟账本，交易所写操作保持关闭。");
  return lines.join("\n");
}

export function formatStatus(db, infrastructure = null) {
  const snapshot = db.getLatestSnapshot();
  const report = snapshot?.report;
  const state = calculateAccountState(db, snapshot?.price);
  const settings = db.getRuntimeSettings();
  const run = db.getLatestMonitorRun();
  const risk = getDailyRiskState(db, snapshot?.captured_at ?? new Date().toISOString(), settings);
  const registry = db.getFeatureRegistry();
  const dataQuality = db.getLatestDataSourceQuality();
  const lines = [
    "BTC/USDT V1.2 Dynamic Contract Paper Trading 状态",
    `数据库：${db.path}（来源：${db.pathSource}）`,
    "",
    "账户",
    `账户权益：${n(state.equityCny)} CNY`,
    `可用资金：${n(state.availableFundsCny)} CNY`,
    `已实现盈亏：${n(state.realizedPnlCny)} CNY`,
    `未实现盈亏：${n(state.unrealizedPnlCny)} CNY`,
    `保证金占用：${n(state.marginUsedCny)} CNY`,
    `LONG 名义仓位：${n(state.longNotionalCny)} CNY`,
    `SHORT 名义仓位：${n(state.shortNotionalCny)} CNY`,
    `Gross Notional：${n(state.grossNotionalCny)} CNY（多空不抵消）`,
    `当前有效杠杆：${n(state.effectiveLeverage)}x`,
    `当前总风险：${n(state.totalRiskCny)} CNY（${pct(state.totalRiskPct)}）`,
    `今日损益：${n(risk.dailyPnlCny)} CNY；连亏 ${risk.consecutiveLosses} 笔；${risk.paused ? `暂停：${risk.pauseReasons.join("；")}` : "允许评估新仓"}`,
    "",
    "运行状态",
    `行情快照：${db.countSnapshots()} 次`,
    `最近 monitor：${run ? `${run.status} / ${run.finished_at} / ${run.message}` : "尚未运行"}`
  ];
  if (snapshot) {
    lines.push(
      `最近判断：${snapshot.decision}；偏好 ${report?.strategy?.bias ?? snapshot.candidate_decision}；BTC ${n(snapshot.price, 1)} USDT`,
      `做多/做空方向指标（非概率）：${report?.opportunities?.LONG?.score ?? "—"} / ${report?.opportunities?.SHORT?.score ?? "—"}`,
      `是否值得现在入场：${report?.entryAssessment?.enterNow ? "是" : "否"}；${report?.entryAssessment?.methodLabel ?? "—"}`
    );
  }
  lines.push("", "当前仓位");
  if (!state.positions.length) lines.push("无");
  for (const group of state.positionGroups) {
    lines.push(`${group.side === "LONG" ? "🟢 LONG" : "🔴 SHORT"} GROUP #${group.groupId}：${group.positionCount} 个实际仓位`);
    for (const position of group.positions) {
      const current = Number(snapshot?.price);
      const stopDistance = position.side === "LONG"
        ? (current - Number(position.stop_loss)) / current
        : (Number(position.stop_loss) - current) / current;
      const targetDistance = position.side === "LONG"
        ? (Number(position.take_profit) - current) / current
        : (current - Number(position.take_profit)) / current;
      lines.push(
        `#${position.id}：entry ${n(position.entry_price, 1)} / SL ${n(position.stop_loss, 1)} / TP ${n(position.take_profit, 1)}`,
        `  距离 SL ${pct(stopDistance)} / TP ${pct(targetDistance)}；数量 ${n(position.quantity_btc, 8)} BTC`,
        `  保证金 ${n(position.margin_cny)} CNY / ${n(position.leverage)}x / 名义 ${n(position.notional_cny)} CNY / 未实现 ${n(calculateUnrealized(position, snapshot?.price))} CNY / 风险 ${n(position.expected_loss_cny ?? position.risk_cny)} CNY`,
        `  Paper 估算强平 ${n(position.liquidation_price_estimate, 1)} USDT（非 HTX 实际强平价）`
      );
      if (position.legacy_contract_math_status === "LEGACY_UNKNOWN") {
        lines.push("  ⚠️ 旧仓合约数据缺失；风险/可用资金按保证金=名义仓位的保守 1x fallback 计算，未伪造杠杆或强平价。");
      }
    }
  }
  lines.push(
    "",
    "运行时设置（SQLite 持久化）",
    `配置版本 ${settings.revision} / 风险偏好 ${riskProfileChinese(settings.riskProfile)}`,
    `持仓模式：${settings.positionMode === "HEDGE" ? "双向 HEDGE" : "单向 NET"}`,
    `单笔风险 ${controlModeChinese(settings.riskMode)}：${pct(settings.riskMinPct)}～${pct(settings.riskMaxPct)}；当前限制 ${pct(settings.riskPerTradePct)}`,
    `总风险 ${controlModeChinese(settings.totalRiskMode)}：${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}；当前 ${pct(settings.maxTotalRiskPct)}`,
    `保证金 ${controlModeChinese(settings.marginMode)}：${pct(settings.marginMinUsagePct)}～${pct(settings.marginMaxUsagePct)}；当前上限 ${pct(settings.maxMarginUsagePct)}`,
    `杠杆 ${controlModeChinese(settings.leverageMode)}：${n(settings.leverageMin, 0)}x～${n(settings.leverageMax, 0)}x；当前上限 ${n(settings.userMaxLeverage, 1)}x（账户实际可用上限未知）`,
    `名义仓位 ${controlModeChinese(settings.notionalMode)}：${n(settings.notionalMinMultiple, 1)}～${n(settings.notionalMaxMultiple, 1)}倍权益；当前上限 ${n(settings.maxTotalNotionalMultiple, 1)}倍`,
    `加仓 ${settings.allowPyramiding ? "开启" : "关闭"} / 仓位区间 ${settings.positionLimitMin}～${settings.positionLimitMax} / 当前最多 ${settings.maxOpenPositions} 仓 / 新开仓 ${settings.newEntriesPaused ? "手动暂停" : "未手动暂停"}`,
    `日损 ${controlModeChinese(settings.dailyLossMode)}：${pct(settings.dailyLossMinPct)}～${pct(settings.dailyLossMaxPct)}；当前 ${pct(settings.maxDailyLossPct)} / 连亏当前 ${settings.maxConsecutiveLosses} 笔暂停`,
    `交易所约束来源：${PAPER_EXCHANGE_CONSTRAINTS.source}；${PAPER_EXCHANGE_CONSTRAINTS.note}`,
    "",
    "多层市场环境 / Feature Registry",
    `生产启用 ${registry.filter((item) => item.status === "enabled").length} 项 / research-only ${registry.filter((item) => item.status === "research-only").length} 项 / disabled ${registry.filter((item) => item.status === "disabled").length} 项`,
    `最近数据源质量：${dataQuality.length ? `${dataQuality.filter((item) => !item.missing).length}/${dataQuality.length} 可用；缺失 ${dataQuality.filter((item) => item.missing).length}` : "尚无采集记录"}`,
    "新增研究特征在 OOS + walk-forward + Shadow Paper + 明确晋级前权重为 0；长期层不能触发分钟级交易。",
    "安全：没有 API Key、私有接口、真实调杠杆或真实下单能力。"
  );
  if (infrastructure) {
    lines.push(
      "",
      "HTX / Research Data Infrastructure V2",
      `HTX CLI：${infrastructure.htx.installed ? infrastructure.htx.release ?? "已安装" : "MISSING"} / SHA ${infrastructure.htx.sha256 ?? "—"}`,
      `兼容检查：${infrastructure.htx.compatibility ? infrastructure.htx.compatibility.compatible ? "PASS" : "FAIL" : "尚未运行"}；上游更新 ${infrastructure.htx.updateAvailable === null ? "未检查" : infrastructure.htx.updateAvailable ? "有" : "无"}`,
      `Market Archive：${infrastructure.archive.available ? `${infrastructure.archive.storage.records} 条 / ${infrastructure.archive.path}` : `尚未建立 / ${infrastructure.archive.path}`}`,
      `Historical Catalog：${infrastructure.catalog.available ? `v${infrastructure.catalog.schemaVersion} / ${infrastructure.catalog.quality}` : "尚未建立"}`,
      `Replay：${infrastructure.replayFields.filter((item) => item.provenance !== "HISTORICAL_UNAVAILABLE").map((item) => item.field).join("、") || "仅 Kline/Funding"}`
    );
  }
  return lines.join("\n");
}

export function formatReport(db) {
  const report = calculatePerformance(db);
  const registry = db.getFeatureRegistry();
  return [
    "BTC/USDT V1.2 Contract Paper Trading 绩效报告",
    `总交易次数：${report.totalTrades}（多单 ${report.longTrades} / 空单 ${report.shortTrades}）`,
    `胜率：${n(report.winRatePct)}%（${report.wins} 胜 / ${report.losses} 负）`,
    `平均盈利：${n(report.averageProfitCny, 4)} CNY`,
    `平均亏损：${n(report.averageLossCny, 4)} CNY`,
    `Profit Factor：${pf(report.profitFactor)}`,
    `Expectancy：${n(report.expectancyCny, 4)} CNY/笔`,
    `最大回撤：${n(report.maxDrawdownCny, 4)} CNY（${n(report.maxDrawdownPct, 4)}%）`,
    `平均净 RR：${n(report.averageRr, 4)}`,
    `平均/最大实际杠杆：${n(report.averageLeverage, 4)}x / ${n(report.maxLeverage, 4)}x`,
    `平均保证金使用率：${n(report.averageMarginUsagePct, 4)}%`,
    `毛收益：${n(report.grossPnlCny, 4)} CNY`,
    `累计手续费：${n(report.feesCny, 4)} CNY`,
    `累计滑点成本：${n(report.slippageCny, 4)} CNY`,
    `累计 Funding：${n(report.fundingCny, 4)} CNY`,
    `总成本：${n(report.totalCostsCny, 4)} CNY`,
    `净收益：${n(report.cumulativePnlCny, 4)} CNY`,
    `账户收益率：${n(report.cumulativeReturnPct, 4)}%`,
    "",
    "Paper 模拟假设：",
    ...Object.values(PAPER_ASSUMPTIONS).map((item) => `- ${item}`),
    "",
    `Feature Registry：生产 ${registry.filter((item) => item.status === "enabled").length} / 研究 ${registry.filter((item) => item.status === "research-only").length} / 禁用 ${registry.filter((item) => item.status === "disabled").length}`,
    "研究特征的历史验证和 Shadow Paper 不会自动修改 Champion 或运行时交易参数。",
    "",
    "安全：所有结果仅写入本地 SQLite；不会连接交易账户。"
  ].join("\n");
}
