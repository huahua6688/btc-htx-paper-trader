import { RUNTIME_SETTINGS_DEFAULTS, TELEGRAM_CONFIG } from "./config.mjs";
import { calculateAccountState, calculatePerformance, calculateUnrealized, getDailyRiskState } from "./paper-engine.mjs";
import { controlModeChinese, RANGE_DEFINITIONS, riskProfileChinese } from "./runtime-settings.mjs";
import {
  answerTelegramCallback,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
  telegramEnabled
} from "./telegram-client.mjs";
// 只读访问研究登记簿。Telegram 绝不 import 研究 CLI 入口，
// 也绝不因为查看页面而写入研究数据库。
import { RESEARCH_REGISTRY, researchRegistrySnapshot, researchRunsByType } from "./research-registry.mjs";
import { formatDataInfrastructureStatus, readDataInfrastructureStatusSync } from "./data-infrastructure-status.mjs";
import { inspectBreakoutV4Shadow } from "./breakout-v4-shadow.mjs";

// Champion 的身份以冻结源码为准，即使登记簿还没建立也必须显示得出来。
const FROZEN_CHAMPION = Object.freeze({
  version: "V1.2-FROZEN",
  lifecycleStatus: "FROZEN",
  sha256: "9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6"
});

const n = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pct = (value, digits = 2) => value === null || value === undefined ? "—" : `${n(Number(value) * 100, digits)}%`;

function mainButtons(settings = { newEntriesPaused: false }) {
  return { inline_keyboard: [
    [{ text: "📊 当前仓位", callback_data: "paper:view:positions" }, { text: "🧠 当前判断", callback_data: "paper:view:decision" }],
    [{ text: "🔬 详细分析", callback_data: "paper:view:details" }, { text: "🧪 Feature Registry", callback_data: "paper:view:research" }],
    [{ text: "💰 账户状态", callback_data: "paper:view:account" }, { text: "📈 今日表现", callback_data: "paper:view:today" }],
    [{ text: "⚙️ 风险", callback_data: "paper:view:risk" }, { text: "🎚 杠杆", callback_data: "paper:view:leverage" }, { text: "💵 保证金", callback_data: "paper:view:margin" }],
    [{ text: "➕ 加仓设置", callback_data: "paper:view:pyramiding" }, { text: "📋 最近交易", callback_data: "paper:view:recent" }],
    [{ text: "🔄 持仓模式", callback_data: "paper:view:position-mode" }],
    [{ text: "⏱ 交易周期", callback_data: "paper:view:cycle" }, { text: "📐 指标 Profile", callback_data: "paper:view:profile" }],
    [{ text: "🧠 Strategy Learning", callback_data: "paper:view:learning" }, { text: "👑 Champion", callback_data: "paper:view:champion" }],
    [{ text: "👥 Challenger / Shadow", callback_data: "paper:view:shadow" }],
    [{ text: "📊 Historical Similarity", callback_data: "paper:view:similarity" }, { text: "📚 Research Results", callback_data: "paper:view:results" }],
    [{ text: "🛰 数据状态", callback_data: "paper:view:data-status" }],
    [{ text: "✨ 一键启用新版自动区间", callback_data: "paper:preset:autoRanges" }],
    [settings.newEntriesPaused
      ? { text: "▶️ 取消手动暂停", callback_data: "paper:set:newEntriesPaused:false" }
      : { text: "⏸ 暂停新开仓", callback_data: "paper:set:newEntriesPaused:true" }]
  ] };
}

const MAIN_BUTTONS = Object.freeze(mainButtons());

/**
 * AUTO 现在是真的按当时状态算出来的，因此必须能回答三件事：
 * 自动范围是多少、本轮实际采用了多少、为什么是这个值。
 */
export function dynamicLimitLines(db) {
  const snapshot = db.getLatestSnapshot();
  const limits = snapshot?.report?.dynamicLimits;
  if (!limits) return ["自动限额：本轮尚未计算（没有可入场的方向判断时不会计算）"];
  const format = (name, item, render) => {
    if (item.mode === "MANUAL") return `${name}：手动 ${render(item.value)}`;
    const why = (item.reasons ?? []).slice(0, 3).join("；");
    return `${name}：自动范围 ${render(item.minimum)}～${render(item.maximum)}；本轮 ${render(item.value)}（系数 ${item.factor}）\n  └ ${why}`;
  };
  const asPct = (value) => `${(Number(value) * 100).toFixed(2)}%`;
  const asX = (value) => `${Number(value).toFixed(2)}x`;
  return [
    format("单笔风险", limits.risk, asPct),
    format("保证金占用上限", limits.margin, asPct),
    format("杠杆上限", limits.leverage, asX),
    format("名义仓位上限", limits.notional, (value) => `${Number(value).toFixed(2)}倍权益`),
    format("组合总风险上限", limits.totalRisk, asPct)
  ];
}

function settingsText(settings) {
  return [
    "⚙️ Paper Trading 控制面板",
    `配置版本：${settings.revision}`,
    `数据门禁政策：${settings.dataPolicyMode === "TIERED_DEGRADED" ? "分级降级（V1.3 候选）" : "冻结 V1.2 严格门禁"}`,
    `手动新开仓开关：${settings.newEntriesPaused ? "已暂停" : "允许评估（仍须通过自动风控）"}`,
    `持仓模式：${settings.positionMode === "HEDGE" ? "双向 HEDGE" : "单向 NET"}`,
    `风险偏好：${riskProfileChinese(settings.riskProfile)}`,
    `单笔风险：${controlModeChinese(settings.riskMode)}；区间 ${pct(settings.riskMinPct)}～${pct(settings.riskMaxPct)}；当前限制 ${pct(settings.riskPerTradePct)}`,
    `总风险：${controlModeChinese(settings.totalRiskMode)}；区间 ${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}；当前 ${pct(settings.maxTotalRiskPct)}`,
    `保证金：${controlModeChinese(settings.marginMode)}；区间 ${pct(settings.marginMinUsagePct)}～${pct(settings.marginMaxUsagePct)}；当前上限 ${pct(settings.maxMarginUsagePct)}`,
    `杠杆：${controlModeChinese(settings.leverageMode)}；用户区间 ${n(settings.leverageMin, 0)}x～${n(settings.leverageMax, 0)}x；当前上限 ${n(settings.userMaxLeverage, 1)}x`,
    `HTX公开产品范围：1x～200x；账户/KYC/仓位档位实际可用上限未知`,
    `名义仓位：${controlModeChinese(settings.notionalMode)}；权益 ${n(settings.notionalMinMultiple, 1)}～${n(settings.notionalMaxMultiple, 1)} 倍；当前上限 ${n(settings.maxTotalNotionalMultiple, 1)} 倍`,
    `加仓：${settings.allowPyramiding ? "开启" : "关闭"}；仓位区间 ${settings.positionLimitMin}～${settings.positionLimitMax}；当前最多 ${settings.maxOpenPositions} 仓`,
    `日损：${controlModeChinese(settings.dailyLossMode)}；区间 ${pct(settings.dailyLossMinPct)}～${pct(settings.dailyLossMaxPct)}；当前 ${pct(settings.maxDailyLossPct)}`,
    `连亏：${controlModeChinese(settings.lossStreakMode)}；区间 ${settings.lossStreakMin}～${settings.lossStreakMax}；当前 ${settings.maxConsecutiveLosses} 笔暂停`,
    `运行周期：每 ${settings.monitorIntervalMinutes} 分钟；Indicator Profile：${settings.indicatorProfile}`,
    "旧数据库保留原值；需要时点“一键启用新版自动区间”，无需逐项修改。",
    "按钮修改本地 SQLite；回调会编辑本消息，不再每按一次新增一条。"
  ].join("\n");
}

function positionText(db) {
  const snapshot = db.getLatestSnapshot();
  const state = calculateAccountState(db, snapshot?.price);
  const rows = [
    "📊 当前模拟仓位",
    `账户权益：${n(state.equityCny)} CNY；可用资金 ${n(state.availableFundsCny)} CNY`,
    `LONG 名义：${n(state.longNotionalCny)} CNY；SHORT 名义：${n(state.shortNotionalCny)} CNY`,
    `Gross Notional：${n(state.grossNotionalCny)} CNY（多空不抵消）`,
    `总保证金：${n(state.marginUsedCny)} CNY；账户有效杠杆 ${n(state.effectiveLeverage)}x`,
    `未实现盈亏：${n(state.unrealizedPnlCny)} CNY；总风险 ${n(state.totalRiskCny)} CNY（${pct(state.totalRiskPct)}）`
  ];
  if (!state.positionGroups.length) rows.push("", "无持仓。");
  for (const group of state.positionGroups) {
    rows.push("", `${group.side === "LONG" ? "🟢 LONG" : "🔴 SHORT"} GROUP #${group.groupId}`);
    for (const position of group.positions) {
      rows.push(
        `#${position.id} Entry ${n(position.entry_price, 1)} / SL ${n(position.stop_loss, 1)} / TP ${n(position.take_profit, 1)}`,
        `Margin ${n(position.margin_cny)} CNY / Leverage ${n(position.leverage)}x / PnL ${n(calculateUnrealized(position, snapshot?.price))} CNY / Risk ${n(position.expected_loss_cny ?? position.risk_cny)} CNY`
      );
      if (position.legacy_contract_math_status === "LEGACY_UNKNOWN") {
        rows.push("⚠️ 旧仓合约数据缺失；风控按名义仓位=保证金的保守 1x 估算，界面不伪造历史杠杆/强平价。");
      }
    }
  }
  return rows.join("\n");
}

function positionModePanel(settings) {
  return {
    text: [
      "🔄 持仓模式",
      `当前：${settings.positionMode === "HEDGE" ? "双向 HEDGE" : "单向 NET"}`,
      "NET：出现相反方向新机会时仍保持原单向限制。",
      "HEDGE：LONG 与 SHORT 可各自独立持仓；关闭加仓只禁止同方向增加新腿。",
      `所有方向合计最多 ${settings.maxOpenPositions} 个实际仓位；风险、保证金和名义仓位按多空绝对值相加。`,
      ...(settings.positionMode === "HEDGE" && settings.maxOpenPositions < 2 ? ["⚠️ 当前最大仓位数小于 2；如需同时多空，请在“加仓设置→仓位数量区间”提高。"] : [])
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: settings.positionMode === "NET" ? "✅ 单向 NET" : "单向 NET", callback_data: "paper:set:positionMode:NET" },
        { text: settings.positionMode === "HEDGE" ? "✅ 双向 HEDGE" : "双向 HEDGE", callback_data: "paper:set:positionMode:HEDGE" }],
      [{ text: "仓位数量区间", callback_data: "paper:view:range-positions" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

/**
 * 数据质量必须能被一眼看到：DATA_OK / DATA_DEGRADED / DATA_BLOCKED 加上到底缺了什么。
 * 以前一个次要接口挂掉只会表现为一串安静的 WAIT，根本看不出系统已经不可能开仓。
 */
export function dataQualityLines(report) {
  const gate = report?.dataQualityGate;
  if (!gate) return ["数据质量：未记录"];
  const tierName = (tier) => tier === "CRITICAL" ? "核心" : tier === "IMPORTANT" ? "重要" : "辅助";
  const provenanceName = (provenance) => ({
    HISTORICAL_UNAVAILABLE: "历史无档案",
    LIVE_FAILURE: "实时失败",
    STALE: "数据过期",
    REPLAY_ARCHIVE_ERROR: "回放档案错误"
  })[provenance] ?? provenance;
  const missing = gate.missing?.length
    ? gate.missing.map((item) => `${item.label}[${tierName(item.tier)}/${provenanceName(item.provenance)}]`).join("、")
    : "无";
  return [
    `数据质量：${gate.status}（政策 ${gate.policy}）`,
    `missing：${missing}`,
    ...(gate.status === "DATA_DEGRADED"
      ? [`降级：权重 ${gate.degradationScore}，风险系数 ×${gate.riskMultiplier}，入场分门槛 +${gate.entryScoreBonus}`]
      : []),
    ...(gate.status === "DATA_BLOCKED" ? gate.hardBlockReasons.slice(0, 3).map((item) => `阻断：${item}`) : [])
  ];
}

function decisionText(db) {
  const snapshot = db.getLatestSnapshot();
  if (!snapshot) return "🧠 当前判断\n尚无行情快照。";
  const report = snapshot.report ?? {};
  return [
    "🧠 当前判断",
    `BTC：${n(snapshot.price, 1)} USDT`,
    `做多评分：${report.opportunities?.LONG?.score ?? "—"}`,
    `做空评分：${report.opportunities?.SHORT?.score ?? "—"}`,
    `最终判断：${snapshot.decision}`,
    `信号质量分：${report.signalQualityScore ?? report.confidencePct ?? "—"}/100（排序指标，不是胜率）`,
    ...dataQualityLines(report),
    `是否值得现在入场：${report.entryAssessment?.enterNow ? "是" : "否"}`,
    "主要原因：",
    ...((report.entryAssessment?.reasons ?? []).slice(0, 5).map((item) => `- ${item}`))
  ].join("\n");
}

function detailedAnalysisText(db) {
  const snapshot = db.getLatestSnapshot();
  if (!snapshot) return "🔬 详细分析\n尚无行情快照。";
  const report = snapshot.report ?? {};
  const factors = report.multiLayerContext?.activeProductionFactors ?? [];
  return [
    "🔬 本轮详细分析（仅实际生效因素）",
    `最终判断：${snapshot.decision}；多 ${report.opportunities?.LONG?.score ?? "—"} / 空 ${report.opportunities?.SHORT?.score ?? "—"}`,
    ...(factors.length ? factors.slice(0, 8).map((item) => `- ${item.label}`) : ["- 尚无分层归因；V1.2 原始判断仍保持不变"]),
    "",
    "未启用的长期、链上、期权、跨所和宏观指标不会显示在这里，也不会影响评分。"
  ].join("\n");
}

function researchText(db) {
  const research = db.getFeatureRegistry({ status: "research-only" });
  const latestQuality = db.getLatestDataSourceQuality();
  const missing = latestQuality.filter((item) => item.missing).length;
  return [
    "🧪 Feature Registry 研究页面",
    `研究中/未启用：${research.length} 项；全部当前权重为 0`,
    `最近一轮数据源缺失：${missing}/${latestQuality.length || 0}`,
    ...research.slice(0, 10).map((item) => [
      `- [${item.time_layer}] ${item.display_name}`,
      `  状态 ${item.availability_status ?? item.status} / 生产状态 ${item.status} / 权重 ${n(item.current_weight, 2)} / 来源 ${item.data_source}`,
      `  历史 ${item.historical_coverage_start ?? "未记录"} → ${item.historical_coverage_end ?? "未记录"} / OOS增量 ${n(item.oos_incremental_contribution, 3)}`
    ].join("\n")),
    "",
    "只有成本后严格样本外、walk-forward 和增量贡献稳定通过，才允许晋级 enabled。"
  ].join("\n");
}

function dataInfrastructureText(db) {
  try {
    return `🛰 数据状态（只读）\n${formatDataInfrastructureStatus(readDataInfrastructureStatusSync(db))}`;
  } catch (error) {
    return `🛰 数据状态（只读）\n读取失败：${error.message}\n这不会改变 Paper 仓位或交易逻辑。`;
  }
}

function indicatorProfilePanel(settings) {
  const labels = { SHORT_SWING: "短波段", STANDARD_SWING: "标准波段", LONG_SWING: "长波段", AUTO: "自动" };
  return {
    text: [
      "📐 Indicator Profile",
      `当前：${labels[settings.indicatorProfile] ?? settings.indicatorProfile}`,
      "Profile 统一管理 EMA / RSI / MACD / ATR 和多周期权重，不会修改冻结 V1.2 Champion；仅供新 Research/Shadow Challenger 下一轮读取。",
      "自动模式按已识别 Market Regime 选择 Profile。恢复默认即 AUTO。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "短波段", callback_data: "paper:set:indicatorProfile:SHORT_SWING" }, { text: "标准波段", callback_data: "paper:set:indicatorProfile:STANDARD_SWING" }],
      [{ text: "长波段", callback_data: "paper:set:indicatorProfile:LONG_SWING" }, { text: "自动/恢复默认", callback_data: "paper:set:indicatorProfile:AUTO" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function cyclePanel(settings) {
  return {
    text: [
      "⏱ Monitor 运行周期",
      `当前：每 ${settings.monitorIntervalMinutes} 分钟`,
      "修改写入 SQLite；monitor 每轮结束后重新读取，下一轮生效，无需重启。持仓风险动作仍只使用新鲜核心价格/K线。",
      "若启用 Breakout V4 Shadow，系统会在每个完整 4h 收盘额外唤醒一次，且这一轮只跑 Shadow：",
      "V1.2 生产周期仍然完全按你选的间隔执行，不会因为研究策略而改变。5 分钟旧信号上限不会放宽。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "5分钟", callback_data: "paper:set:monitorIntervalMinutes:5" }, { text: "15分钟", callback_data: "paper:set:monitorIntervalMinutes:15" }],
      [{ text: "1小时", callback_data: "paper:set:monitorIntervalMinutes:60" }, { text: "4小时", callback_data: "paper:set:monitorIntervalMinutes:240" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function marginPanel(settings) {
  return {
    text: [
      "💵 保证金设置",
      `模式：${controlModeChinese(settings.marginMode)}`,
      `允许区间：${pct(settings.marginMinUsagePct)}～${pct(settings.marginMaxUsagePct)}`,
      `手动值：${pct(settings.marginManualUsagePct)}`,
      `当前上限：${pct(settings.maxMarginUsagePct)}`,
      "保证金只用于反推动态杠杆；不会改变已确定的最大亏损。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "调整完整区间", callback_data: "paper:view:range-margin" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

// Champion 的实时状态以生产 Paper 库和冻结源码为准；
// Challenger / 研究运行 / 相似行情 / 研究结果一律从独立的研究登记簿只读读取。
function championText(db, registryPath) {
  const snapshot = db.getLatestSnapshot();
  const registry = researchRegistrySnapshot({ runLimit: 1, path: registryPath });
  const champion = registry.strategyVersions.find((item) => item.role === "CHAMPION") ?? null;
  return [
    "👑 Paper Champion",
    `版本：${champion?.version ?? FROZEN_CHAMPION.version}`,
    `状态：${champion?.lifecycle_status ?? FROZEN_CHAMPION.lifecycleStatus}`,
    `SHA-256：${champion?.strategy_hash ?? FROZEN_CHAMPION.sha256}`,
    `最近判断：${snapshot?.decision ?? "尚无"}`,
    `数据门禁政策：${db.getRuntimeSettings()?.dataPolicyMode ?? "FROZEN_V12_STRICT"}`,
    "冻结 Champion 不允许原地改参数；新版本只能从 Challenger 完整验证后晋级，并保留回滚点。"
  ].join("\n");
}

function registryFooter(registry) {
  return registry.available
    ? `登记簿：${registry.path}（只读读取，不写入）`
    : `登记簿尚未创建：${registry.path}`;
}

function shadowText(registryPath) {
  const registry = researchRegistrySnapshot({ runLimit: 1, path: registryPath });
  const challengers = registry.strategyVersions.filter((item) => item.role === "CHALLENGER");
  const active = inspectBreakoutV4Shadow();
  const v4 = active.strategyType === "breakout-v4" ? active.evidence : null;
  return [
    "👥 Challenger / Shadow",
    ...(v4 ? [
      `当前：Breakout V4 ${String(active.config.strategyHash).slice(0, 16)}… / ${v4.status}`,
      `观察：${v4.calendarDays}/${v4.policy.minimumCalendarDays} 天；方向信号 ${v4.directionalSignals}/${v4.policy.minimumDirectionalSignals}`,
      `执行时延：已记录 ${v4.timingObservedSignals}；超出 5 分钟 ${v4.staleTimingSignals}；缺失率 ${(Number(v4.missingTimingRate) * 100).toFixed(2)}%`,
      `Shadow 净收益：${v4.performance?.cumulativeReturnPct ?? "—"}%；PF：${v4.performance?.profitFactor ?? "—"}`,
      `数据库：${active.config.databasePath}`,
      "状态只会进入人工晋级审核，不会自动替换 Champion。"
    ] : active.available ? [
      `当前 active Shadow：${active.strategyType ?? "unknown"}`
    ] : [
      `当前没有可验证的 active Shadow：${active.error ?? active.reason}`
    ]),
    ...(challengers.length
      ? challengers.slice(0, 6).map((item) => `- ${item.version}：${item.lifecycle_status} / ${String(item.strategy_hash ?? "").slice(0, 16)}…`)
      : ["尚无研究记录：还没有登记任何 Challenger。"]),
    "Shadow 使用独立 SQLite，不能影响 Champion 账户。未证明净 edge 的候选不会晋级。",
    registryFooter(registry)
  ].join("\n");
}

function learningText(registryPath) {
  const registry = researchRegistrySnapshot({ runLimit: 8, path: registryPath });
  const runs = registry.researchRuns;
  return [
    "🧠 Strategy Learning",
    "闭环：Candidate → Replay → Walk-forward/Purged OOS → untouched Final OOS → Monte Carlo → Shadow → Promotion Gate。",
    `已登记策略版本：${registry.strategyVersionCount}；已持久化研究运行：${registry.researchRunCount}`,
    ...(runs.length
      ? runs.slice(0, 5).map((item) => `- ${item.run_type}：${item.status}（${item.finished_at}）`)
      : ["尚无研究记录。"]),
    "自动学习不会按单笔输赢即时调参，也不会用已使用 Final OOS 继续选策略。",
    registryFooter(registry)
  ].join("\n");
}

function similarityText(registryPath) {
  const run = researchRunsByType("HISTORICAL_SIMILARITY", { limit: 1, path: registryPath })[0] ?? null;
  const registry = researchRegistrySnapshot({ runLimit: 1, path: registryPath });
  return [
    "📊 Historical Similarity",
    run
      ? `最近运行：${run.finished_at}\n状态：${run.status}\n${JSON.stringify(run.summary)}`
      : "尚无研究记录：登记簿里还没有相似行情运行摘要；不会伪造概率。样本不足时必须显示 insufficient evidence。",
    registryFooter(registry)
  ].join("\n");
}

function researchResultsText(registryPath) {
  const registry = researchRegistrySnapshot({ runLimit: 10, path: registryPath });
  const runs = registry.researchRuns;
  return [
    "📚 Research Results",
    ...(runs.length
      ? runs.map((item) => `- ${item.run_type} / ${item.status} / ${item.finished_at}`)
      : ["尚无研究记录；research-output 原始产物不会被假装成数据库结果。"]),
    registryFooter(registry)
  ].join("\n");
}

function accountText(db) {
  const state = calculateAccountState(db);
  return [
    "💰 Paper 账户状态",
    `账户权益：${n(state.equityCny)} CNY`,
    `可用资金：${n(state.availableFundsCny)} CNY`,
    `已实现盈亏：${n(state.realizedPnlCny)} CNY`,
    `未实现盈亏：${n(state.unrealizedPnlCny)} CNY`,
    `保证金占用：${n(state.marginUsedCny)} CNY`,
    `总名义仓位：${n(state.totalNotionalCny)} CNY`,
    `有效杠杆：${n(state.effectiveLeverage)}x`
  ].join("\n");
}

function todayText(db) {
  const risk = getDailyRiskState(db);
  const performance = calculatePerformance(db);
  return [
    "📈 今日表现",
    `今日盈亏：${n(risk.dailyPnlCny)} CNY`,
    `连续亏损：${risk.consecutiveLosses} 笔`,
    `新开仓状态：${risk.paused ? "暂停" : "允许评估"}`,
    `累计交易：${performance.totalTrades} 笔`,
    `累计净收益：${n(performance.cumulativePnlCny)} CNY`,
    `胜率：${n(performance.winRatePct)}%`
  ].join("\n");
}

function riskPanel(settings, db = null) {
  return {
    text: [
      "⚙️ 风险设置",
      `风险偏好：${riskProfileChinese(settings.riskProfile)}`,
      `单笔风险：${controlModeChinese(settings.riskMode)} ${pct(settings.riskMinPct)}～${pct(settings.riskMaxPct)}`,
      `账户总风险：${controlModeChinese(settings.totalRiskMode)} ${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}`,
      `每日损失：${controlModeChinese(settings.dailyLossMode)} ${pct(settings.dailyLossMinPct)}～${pct(settings.dailyLossMaxPct)}`,
      `连亏暂停：${controlModeChinese(settings.lossStreakMode)} ${settings.lossStreakMin}～${settings.lossStreakMax} 笔`,
      "",
      "本轮实际采用的自动值：",
      ...(db ? dynamicLimitLines(db) : []),
      "",
      "选择一项后再调最低、最高和手动值；每次点击只刷新当前消息。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "保守", callback_data: "paper:set:riskProfile:CONSERVATIVE" }, { text: "均衡", callback_data: "paper:set:riskProfile:BALANCED" }, { text: "积极", callback_data: "paper:set:riskProfile:AGGRESSIVE" }],
      [{ text: "单笔风险", callback_data: "paper:view:range-risk" }, { text: "总风险", callback_data: "paper:view:range-totalRisk" }],
      [{ text: "每日损失", callback_data: "paper:view:range-dailyLoss" }, { text: "连亏暂停", callback_data: "paper:view:range-lossStreak" }],
      [{ text: "🤖 本轮自动限额", callback_data: "paper:view:auto" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function leveragePanel(settings) {
  return {
    text: [
      "🎚 杠杆与保证金设置",
      `杠杆：${controlModeChinese(settings.leverageMode)}；${n(settings.leverageMin, 0)}x～${n(settings.leverageMax, 0)}x；手动 ${n(settings.leverageManual, 0)}x`,
      `保证金：${controlModeChinese(settings.marginMode)}；${pct(settings.marginMinUsagePct)}～${pct(settings.marginMaxUsagePct)}；手动 ${pct(settings.marginManualUsagePct)}`,
      `名义仓位：${controlModeChinese(settings.notionalMode)}；权益 ${n(settings.notionalMinMultiple, 1)}～${n(settings.notionalMaxMultiple, 1)} 倍；手动 ${n(settings.notionalManualMultiple, 1)} 倍`,
      "公开产品范围1x～200x；账户实际可用上限未知。选择一项进入完整的最低/最高/手动调节。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "杠杆区间", callback_data: "paper:view:range-leverage" }],
      [{ text: "保证金区间", callback_data: "paper:view:range-margin" }, { text: "名义仓位区间", callback_data: "paper:view:range-notional" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function pyramidingPanel(settings) {
  return {
    text: [
      "➕ 加仓设置",
      `持仓模式：${settings.positionMode === "HEDGE" ? "双向 HEDGE" : "单向 NET"}`,
      `加仓：${settings.allowPyramiding ? "开启" : "关闭"}`,
      `仓位模式：${controlModeChinese(settings.positionLimitMode)}；${settings.positionLimitMin}～${settings.positionLimitMax}；当前 ${settings.maxOpenPositions}`,
      `组合总风险：${controlModeChinese(settings.totalRiskMode)}；${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}；当前 ${pct(settings.maxTotalRiskPct)}`,
      "开启后仍要求同方向、有利进展、新高质量信号及组合风险/保证金/名义仓位全部通过。HEDGE 下关闭加仓不影响独立的相反方向首仓。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "关闭加仓", callback_data: "paper:set:allowPyramiding:false" }, { text: "开启加仓", callback_data: "paper:set:allowPyramiding:true" }],
      [{ text: "仓位数量区间", callback_data: "paper:view:range-positions" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

const RANGE_PANEL_META = Object.freeze({
  risk: Object.freeze({ title: "单笔账户风险", effectiveLabel: "自动可用上限", step: 0.0025, format: pct, back: "risk", note: "自动模式会在区间内按权益、机会质量、波动和已有风险动态选择，并不固定使用最高值。" }),
  totalRisk: Object.freeze({ title: "账户总风险", effectiveLabel: "当前阈值", step: 0.005, format: pct, back: "risk", note: "这是所有未平仓仓位合计的账户风险边界。" }),
  dailyLoss: Object.freeze({ title: "每日最大损失", effectiveLabel: "当前阈值", step: 0.005, format: pct, back: "risk", note: "达到本轮采用值后，当天暂停新增模拟仓位。" }),
  lossStreak: Object.freeze({ title: "连亏暂停笔数", effectiveLabel: "当前阈值", step: 1, format: (value) => `${n(value, 0)} 笔`, back: "risk", note: "达到本轮采用值后，当天暂停新增模拟仓位。" }),
  leverage: Object.freeze({ title: "用户杠杆限制", effectiveLabel: "当前最高允许", step: 5, format: (value) => `${n(value, 0)}x`, back: "leverage", note: "自动模式只把最高值当上限；实际杠杆由止损、名义仓位和保证金反推，不会自动用满。" }),
  margin: Object.freeze({ title: "保证金使用比例", effectiveLabel: "当前使用上限", step: 0.05, format: pct, back: "leverage", note: "限制模拟仓位最多占用多少账户权益作为保证金。" }),
  notional: Object.freeze({ title: "总名义仓位", effectiveLabel: "当前总上限", step: 0.5, format: (value) => `${n(value, 1)} 倍权益`, back: "leverage", note: "杠杆不能让名义仓位突破这里的限制。" }),
  positions: Object.freeze({ title: "同时仓位数量", effectiveLabel: "当前最多", step: 1, format: (value) => `${n(value, 0)} 仓`, back: "pyramiding", note: "统计 LONG + SHORT 所有实际 OPEN 腿；NET 且关闭加仓时为 1，HEDGE 关闭加仓时仍可各有一条 LONG/SHORT。" })
});

function rangeControlPanel(settings, name) {
  const definition = RANGE_DEFINITIONS[name];
  const meta = RANGE_PANEL_META[name];
  if (!definition || !meta) return riskPanel(settings);
  const format = meta.format;
  const delta = meta.step;
  const minus = String(-delta);
  const plus = String(delta);
  return {
    text: [
      `🎛 ${meta.title}`,
      `模式：${controlModeChinese(settings[definition.mode])}`,
      `最低值：${format(settings[definition.minimum])}`,
      `最高值：${format(settings[definition.maximum])}`,
      `手动值：${format(settings[definition.manual])}`,
      `${meta.effectiveLabel}：${format(settings[definition.effective])}`,
      meta.note,
      "修改写入 SQLite，下一轮 monitor 生效。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: settings[definition.mode] === "AUTO" ? "✅ 自动" : "自动", callback_data: `paper:set:${definition.mode}:AUTO` },
        { text: settings[definition.mode] === "MANUAL" ? "✅ 手动" : "手动", callback_data: `paper:set:${definition.mode}:MANUAL` }],
      [{ text: `最低 −${format(delta)}`, callback_data: `paper:adj:${definition.minimum}:${minus}` }, { text: `最低 +${format(delta)}`, callback_data: `paper:adj:${definition.minimum}:${plus}` }],
      [{ text: `最高 −${format(delta)}`, callback_data: `paper:adj:${definition.maximum}:${minus}` }, { text: `最高 +${format(delta)}`, callback_data: `paper:adj:${definition.maximum}:${plus}` }],
      [{ text: `手动 −${format(delta)}`, callback_data: `paper:adj:${definition.manual}:${minus}` }, { text: `手动 +${format(delta)}`, callback_data: `paper:adj:${definition.manual}:${plus}` }],
      [{ text: "返回", callback_data: `paper:view:${meta.back}` }]
    ] }
  };
}

function recentText(db) {
  const trades = db.getRecentPositions({ limit: 8 });
  return [
    "📋 最近交易",
    ...(trades.length ? trades.map((item) => `#${item.id} ${item.side} ${item.status === "OPEN" ? "持仓中" : `${item.exit_reason} / 净收益 ${n(item.net_pnl_cny)} CNY`}`) : ["暂无交易"])
  ].join("\n");
}

function parseSettingValue(key, raw) {
  if (["allowPyramiding", "newEntriesPaused"].includes(key)) return raw === "true";
  if (["riskProfile", "indicatorProfile", "positionMode"].includes(key) || Object.values(RANGE_DEFINITIONS).some((definition) => definition.mode === key)) return raw;
  return Number(raw);
}

function automaticRangePreset() {
  const patch = {};
  for (const definition of Object.values(RANGE_DEFINITIONS)) {
    patch[definition.mode] = "AUTO";
    patch[definition.minimum] = RUNTIME_SETTINGS_DEFAULTS[definition.minimum];
    patch[definition.maximum] = RUNTIME_SETTINGS_DEFAULTS[definition.maximum];
    patch[definition.manual] = RUNTIME_SETTINGS_DEFAULTS[definition.manual];
  }
  return patch;
}

function panelNameForSetting(key) {
  for (const [name, definition] of Object.entries(RANGE_DEFINITIONS)) {
    if ([definition.mode, definition.minimum, definition.maximum, definition.manual, definition.effective].includes(key)) return `range-${name}`;
  }
  if (key === "riskProfile") return "risk";
  if (key === "indicatorProfile") return "profile";
  if (key === "monitorIntervalMinutes") return "cycle";
  if (key === "positionMode") return "position-mode";
  if (/position|Pyramiding/i.test(key)) return "pyramiding";
  return "main";
}

export class TelegramControlPanel {
  constructor(db, {
    config = TELEGRAM_CONFIG,
    fetchImpl = globalThis.fetch,
    logger = (message) => process.stderr.write(`${message}\n`),
    getUpdates = getTelegramUpdates,
    send = sendTelegramMessage,
    edit = editTelegramMessage,
    answer = answerTelegramCallback,
    // 研究登记簿路径可注入，便于测试与自定义部署；默认走 research-registry 的解析结果。
    researchRegistryPath = RESEARCH_REGISTRY.path
  } = {}) {
    this.researchRegistryPath = researchRegistryPath;
    this.db = db;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.getUpdates = getUpdates;
    this.send = send;
    this.edit = edit;
    this.answer = answer;
    this.timer = null;
    this.polling = false;
  }

  get enabled() { return telegramEnabled(this.config); }

  /**
   * 授权判定必须同时区分 CHAT ID 与 SENDER(USER) ID。
   *
   *   - chat 必须精确等于 TELEGRAM_CHAT_ID，否则一律拒绝。
   *   - 配置了 TELEGRAM_ADMIN_USER_ID 时，发送者必须精确等于它。
   *     这是群组场景下唯一安全的模式：群里其他人即使看到按钮也无法操作。
   *   - 未配置 TELEGRAM_ADMIN_USER_ID 时，只兼容私聊：私聊的 chat.id 等于用户自己的
   *     user id，因此要求 sender === chat 才放行。群组/超级群/频道在没有显式管理员
   *     user id 的情况下一律拒绝，绝不因为“在群里”就把风控开关交出去。
   */
  authorize({ chatId, senderId, chatType } = {}) {
    if (chatId === null || chatId === undefined || String(chatId) === "") {
      return { allowed: false, reason: "无法识别来源会话" };
    }
    if (String(chatId) !== String(this.config.chatId)) {
      return { allowed: false, reason: "无权限" };
    }
    const adminUserId = String(this.config.adminUserId ?? "").trim();
    if (adminUserId) {
      if (senderId === null || senderId === undefined || String(senderId) === "") {
        return { allowed: false, reason: "无法识别发送者" };
      }
      return String(senderId) === adminUserId
        ? { allowed: true, mode: "ADMIN_USER_ID" }
        : { allowed: false, reason: "只有管理员本人可以操作 Paper 设置" };
    }
    const isPrivate = chatType === undefined || chatType === null || chatType === "private";
    if (!isPrivate) {
      return { allowed: false, reason: "群组模式必须配置 TELEGRAM_ADMIN_USER_ID 才能操作" };
    }
    if (senderId !== null && senderId !== undefined && String(senderId) !== String(chatId)) {
      return { allowed: false, reason: "发送者与私聊会话不一致" };
    }
    return { allowed: true, mode: "PRIVATE_CHAT" };
  }

  isAdmin(chatId, senderId, chatType) {
    return this.authorize({ chatId, senderId, chatType }).allowed;
  }

  async sendView(text, replyMarkup = MAIN_BUTTONS) {
    return this.send(text, { config: this.config, fetchImpl: this.fetchImpl, replyMarkup });
  }

  async editView(messageId, text, replyMarkup = MAIN_BUTTONS) {
    const result = await this.edit(messageId, text, {
      config: this.config,
      fetchImpl: this.fetchImpl,
      replyMarkup
    });
    if (!result.ok) this.logger(`Telegram panel edit failed safely: ${result.error}`);
    return result;
  }

  view(name) {
    const settings = this.db.getRuntimeSettings();
    const main = mainButtons(settings);
    if (name === "positions") return { text: positionText(this.db), markup: main };
    if (name === "decision") return { text: decisionText(this.db), markup: main };
    if (name === "details") return { text: detailedAnalysisText(this.db), markup: main };
    if (name === "research") return { text: researchText(this.db), markup: main };
    if (name === "account") return { text: accountText(this.db), markup: main };
    if (name === "today") return { text: todayText(this.db), markup: main };
    if (name === "risk") return riskPanel(settings, this.db);
    if (name === "auto") return { text: ["🤖 本轮自动限额", ...dynamicLimitLines(this.db)].join("\n"), markup: main };
    if (name === "leverage") return leveragePanel(settings);
    if (name === "margin") return marginPanel(settings);
    if (name === "pyramiding") return pyramidingPanel(settings);
    if (name === "position-mode") return positionModePanel(settings);
    if (name === "profile") return indicatorProfilePanel(settings);
    if (name === "cycle") return cyclePanel(settings);
    if (name === "champion") return { text: championText(this.db, this.researchRegistryPath), markup: main };
    if (name === "shadow") return { text: shadowText(this.researchRegistryPath), markup: main };
    if (name === "learning") return { text: learningText(this.researchRegistryPath), markup: main };
    if (name === "similarity") return { text: similarityText(this.researchRegistryPath), markup: main };
    if (name === "results") return { text: researchResultsText(this.researchRegistryPath), markup: main };
    if (name === "data-status") return { text: dataInfrastructureText(this.db), markup: main };
    if (name.startsWith("range-")) return rangeControlPanel(settings, name.slice("range-".length));
    if (name === "recent") return { text: recentText(this.db), markup: main };
    return { text: settingsText(settings), markup: main };
  }

  async applySetting(key, rawValue, updateId) {
    const value = parseSettingValue(key, rawValue);
    const current = this.db.getRuntimeSettings();
    const patch = { [key]: value };
    const range = Object.values(RANGE_DEFINITIONS).find((definition) => definition.minimum === key || definition.maximum === key);
    if (range?.minimum === key) {
      if (value > Number(current[range.maximum])) throw new Error("最低值不能高于最高值");
      if (value > Number(current[range.manual])) patch[range.manual] = value;
    }
    if (range?.maximum === key) {
      if (value < Number(current[range.minimum])) throw new Error("最高值不能低于最低值");
      if (value < Number(current[range.manual])) patch[range.manual] = value;
    }
    if (key === "positionMode" && value === "NET" && new Set(this.db.getOpenPositions().map((position) => position.side)).size > 1) {
      throw new Error("当前同时存在 LONG 与 SHORT；请先自然平掉一侧，再切换 NET，系统不会自动抵消仓位");
    }
    if (key === "allowPyramiding" && value === false && current.positionMode === "NET" && current.maxOpenPositions !== 1) patch.maxOpenPositions = 1;
    if (key === "maxOpenPositions" && value > 1 && !current.allowPyramiding && current.positionMode === "NET") {
      throw new Error("请先开启加仓，再提高最大仓位数");
    }
    return this.db.updateRuntimeSettings(patch, {
      source: "TELEGRAM_ADMIN_CHAT",
      sourceEventId: `telegram:${updateId}`
    });
  }

  async adjustSetting(key, rawDelta, updateId) {
    const current = this.db.getRuntimeSettings();
    if (!(key in current)) throw new Error(`未知参数：${key}`);
    const delta = Number(rawDelta);
    if (!Number.isFinite(delta)) throw new Error("调整步长必须是数字");
    const next = Number((Number(current[key]) + delta).toFixed(8));
    return this.applySetting(key, String(next), updateId);
  }

  applyAutomaticRangePreset(updateId) {
    return this.db.updateRuntimeSettings(automaticRangePreset(), {
      source: "TELEGRAM_ADMIN_CHAT",
      sourceEventId: `telegram:${updateId}`
    });
  }

  async handleAdminUpdate(update) {
    const callback = update.callback_query;
    const message = update.message;
    const chat = callback?.message?.chat ?? message?.chat;
    const chatId = chat?.id;
    const senderId = callback?.from?.id ?? message?.from?.id;
    const decision = this.authorize({ chatId, senderId, chatType: chat?.type });
    if (!decision.allowed) {
      this.logger(`Telegram control rejected an unauthorized update: chat=${chatId ?? "?"} sender=${senderId ?? "?"} reason=${decision.reason}`);
      if (callback?.id) await this.answer(callback.id, decision.reason, { config: this.config, fetchImpl: this.fetchImpl });
      this.db.markTelegramUpdateProcessed(update.update_id);
      return;
    }
    try {
      if (callback) {
        const parts = String(callback.data ?? "").split(":");
        if (parts[0] !== "paper") throw new Error("不支持的按钮");
        if (parts[1] === "view") {
          const view = this.view(parts[2]);
          await this.editView(callback.message.message_id, view.text, view.markup);
          await this.answer(callback.id, "已刷新", { config: this.config, fetchImpl: this.fetchImpl });
        } else if (parts[1] === "set") {
          await this.applySetting(parts[2], parts[3], update.update_id);
          const view = this.view(panelNameForSetting(parts[2]));
          await this.editView(callback.message.message_id, view.text, view.markup);
          await this.answer(callback.id, "已保存；下一轮生效", { config: this.config, fetchImpl: this.fetchImpl });
        } else if (parts[1] === "adj") {
          await this.adjustSetting(parts[2], parts[3], update.update_id);
          const view = this.view(panelNameForSetting(parts[2]));
          await this.editView(callback.message.message_id, view.text, view.markup);
          await this.answer(callback.id, "设置已保存", { config: this.config, fetchImpl: this.fetchImpl });
        } else if (parts[1] === "preset" && parts[2] === "autoRanges") {
          await this.applyAutomaticRangePreset(update.update_id);
          const view = this.view("main");
          await this.editView(callback.message.message_id, view.text, view.markup);
          await this.answer(callback.id, "新版自动区间已启用；下一轮生效", { config: this.config, fetchImpl: this.fetchImpl });
        } else throw new Error("不支持的按钮");
      } else {
        const text = String(message?.text ?? "").trim();
        if (["/start", "/paper", "/panel", "/status"].includes(text)) {
          const view = this.view("main");
          await this.sendView(view.text, view.markup);
        } else if (["/pause", "/resume"].includes(text)) {
          const paused = text === "/pause";
          const result = await this.applySetting("newEntriesPaused", String(paused), update.update_id);
          await this.sendView(`✅ 已${paused ? "暂停" : "恢复"}新开仓。\n\n${settingsText(result.settings)}`, mainButtons(result.settings));
        } else if (text.startsWith("/set ")) {
          const [, key, rawValue] = text.split(/\s+/, 3);
          if (!key || rawValue === undefined) throw new Error("格式：/set 参数 值，例如 /set leverageMax 100");
          const result = await this.applySetting(key, rawValue, update.update_id);
          await this.sendView(`✅ ${key} 已更新。\n\n${settingsText(result.settings)}`, mainButtons(result.settings));
        }
      }
    } catch (error) {
      this.logger(`Telegram control failed safely: ${error.message}`);
      if (callback?.id) await this.answer(callback.id, error.message, { config: this.config, fetchImpl: this.fetchImpl });
    } finally {
      this.db.markTelegramUpdateProcessed(update.update_id);
    }
  }

  async pollOnce() {
    if (!this.enabled || this.polling) return { skipped: true, processed: 0 };
    this.polling = true;
    try {
      const response = await this.getUpdates(this.db.getTelegramUpdateOffset(), { config: this.config, fetchImpl: this.fetchImpl });
      if (!response.ok) {
        if (!response.skipped) this.logger(`Telegram control polling failed safely: ${response.error}`);
        return { skipped: response.skipped, processed: 0 };
      }
      const updates = [...(response.result ?? [])].sort((a, b) => a.update_id - b.update_id);
      for (const update of updates) await this.handleAdminUpdate(update);
      return { skipped: false, processed: updates.length };
    } catch (error) {
      this.logger(`Telegram control polling failed safely: ${error.message}`);
      return { skipped: false, processed: 0, error: error.message };
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.config.controlPollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { MAIN_BUTTONS };
