import { RUNTIME_SETTINGS_DEFAULTS, TELEGRAM_CONFIG } from "./config.mjs";
import { calculateAccountState, calculatePerformance, getDailyRiskState } from "./paper-engine.mjs";
import { controlModeChinese, RANGE_DEFINITIONS, riskProfileChinese } from "./runtime-settings.mjs";
import {
  answerTelegramCallback,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
  telegramEnabled
} from "./telegram-client.mjs";

const n = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pct = (value, digits = 2) => value === null || value === undefined ? "—" : `${n(Number(value) * 100, digits)}%`;

function mainButtons(settings = { newEntriesPaused: false }) {
  return { inline_keyboard: [
    [{ text: "📊 当前仓位", callback_data: "paper:view:positions" }, { text: "🧠 当前判断", callback_data: "paper:view:decision" }],
    [{ text: "🔬 详细分析", callback_data: "paper:view:details" }, { text: "🧪 研究页面", callback_data: "paper:view:research" }],
    [{ text: "💰 账户状态", callback_data: "paper:view:account" }, { text: "📈 今日表现", callback_data: "paper:view:today" }],
    [{ text: "⚙️ 风险设置", callback_data: "paper:view:risk" }, { text: "🎚 杠杆设置", callback_data: "paper:view:leverage" }],
    [{ text: "➕ 加仓设置", callback_data: "paper:view:pyramiding" }, { text: "📋 最近交易", callback_data: "paper:view:recent" }],
    [{ text: "✨ 一键启用新版自动区间", callback_data: "paper:preset:autoRanges" }],
    [settings.newEntriesPaused
      ? { text: "▶️ 取消手动暂停", callback_data: "paper:set:newEntriesPaused:false" }
      : { text: "⏸ 暂停新开仓", callback_data: "paper:set:newEntriesPaused:true" }]
  ] };
}

const MAIN_BUTTONS = Object.freeze(mainButtons());

function settingsText(settings) {
  return [
    "⚙️ Paper Trading 控制面板",
    `配置版本：${settings.revision}`,
    `手动新开仓开关：${settings.newEntriesPaused ? "已暂停" : "允许评估（仍须通过自动风控）"}`,
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
    "旧数据库保留原值；需要时点“一键启用新版自动区间”，无需逐项修改。",
    "按钮修改本地 SQLite；回调会编辑本消息，不再每按一次新增一条。"
  ].join("\n");
}

function positionText(db) {
  const snapshot = db.getLatestSnapshot();
  const state = calculateAccountState(db, snapshot?.price);
  if (!state.positions.length) return "📊 当前模拟仓位\n无持仓。";
  const rows = [
    "📊 当前模拟仓位",
    `方向：${state.positions[0].side}；共 ${state.positions.length} 笔受控仓位`,
    `平均入场：${n(state.averageEntryPrice, 1)} USDT`,
    `总数量：${n(state.totalQuantityBtc, 8)} BTC`,
    `总名义仓位：${n(state.totalNotionalCny)} CNY`,
    `保证金：${n(state.marginUsedCny)} CNY；有效杠杆 ${n(state.effectiveLeverage)}x`,
    `未实现盈亏：${n(state.unrealizedPnlCny)} CNY`,
    `当前总风险：${n(state.totalRiskCny)} CNY（${pct(state.totalRiskPct)}）`
  ];
  for (const position of state.positions) {
    rows.push(`#${position.id}：入场 ${n(position.entry_price, 1)} / SL ${n(position.stop_loss, 1)} / TP ${n(position.take_profit, 1)}`);
  }
  return rows.join("\n");
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
      `  状态 ${item.status} / 权重 ${n(item.current_weight, 2)} / 来源 ${item.data_source}`,
      `  历史 ${item.historical_coverage_start ?? "未记录"} → ${item.historical_coverage_end ?? "未记录"} / OOS增量 ${n(item.oos_incremental_contribution, 3)}`
    ].join("\n")),
    "",
    "只有成本后严格样本外、walk-forward 和增量贡献稳定通过，才允许晋级 enabled。"
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

function riskPanel(settings) {
  return {
    text: [
      "⚙️ 风险设置",
      `风险偏好：${riskProfileChinese(settings.riskProfile)}`,
      `单笔风险：${controlModeChinese(settings.riskMode)} ${pct(settings.riskMinPct)}～${pct(settings.riskMaxPct)}`,
      `账户总风险：${controlModeChinese(settings.totalRiskMode)} ${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}`,
      `每日损失：${controlModeChinese(settings.dailyLossMode)} ${pct(settings.dailyLossMinPct)}～${pct(settings.dailyLossMaxPct)}`,
      `连亏暂停：${controlModeChinese(settings.lossStreakMode)} ${settings.lossStreakMin}～${settings.lossStreakMax} 笔`,
      "选择一项后再调最低、最高和手动值；每次点击只刷新当前消息。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "保守", callback_data: "paper:set:riskProfile:CONSERVATIVE" }, { text: "均衡", callback_data: "paper:set:riskProfile:BALANCED" }, { text: "积极", callback_data: "paper:set:riskProfile:AGGRESSIVE" }],
      [{ text: "单笔风险", callback_data: "paper:view:range-risk" }, { text: "总风险", callback_data: "paper:view:range-totalRisk" }],
      [{ text: "每日损失", callback_data: "paper:view:range-dailyLoss" }, { text: "连亏暂停", callback_data: "paper:view:range-lossStreak" }],
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
      `加仓：${settings.allowPyramiding ? "开启" : "关闭"}`,
      `仓位模式：${controlModeChinese(settings.positionLimitMode)}；${settings.positionLimitMin}～${settings.positionLimitMax}；当前 ${settings.maxOpenPositions}`,
      `组合总风险：${controlModeChinese(settings.totalRiskMode)}；${pct(settings.totalRiskMinPct)}～${pct(settings.totalRiskMaxPct)}；当前 ${pct(settings.maxTotalRiskPct)}`,
      "开启后仍要求同方向、有利进展、新高质量信号及组合风险/保证金/名义仓位全部通过。仓位数量也有完整最低/最高/手动区间。"
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
  positions: Object.freeze({ title: "同时仓位数量", effectiveLabel: "当前最多", step: 1, format: (value) => `${n(value, 0)} 仓`, back: "pyramiding", note: "关闭加仓时，无论此处设置如何，实际仍只允许 1 个 BTC 仓位组。" })
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
  if (key === "riskProfile" || Object.values(RANGE_DEFINITIONS).some((definition) => definition.mode === key)) return raw;
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
    answer = answerTelegramCallback
  } = {}) {
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
  isAdmin(chatId) { return String(chatId) === String(this.config.chatId); }

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
    if (name === "risk") return riskPanel(settings);
    if (name === "leverage") return leveragePanel(settings);
    if (name === "pyramiding") return pyramidingPanel(settings);
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
    if (key === "allowPyramiding" && value === false && current.maxOpenPositions !== 1) patch.maxOpenPositions = 1;
    if (key === "maxOpenPositions" && value > 1 && !current.allowPyramiding) {
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
    const chatId = callback?.message?.chat?.id ?? message?.chat?.id;
    if (!this.isAdmin(chatId)) {
      if (callback?.id) await this.answer(callback.id, "无权限", { config: this.config, fetchImpl: this.fetchImpl });
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
