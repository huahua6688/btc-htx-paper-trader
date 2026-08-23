import { TELEGRAM_CONFIG } from "./config.mjs";
import { calculateAccountState, calculatePerformance, getDailyRiskState } from "./paper-engine.mjs";
import { riskProfileChinese } from "./runtime-settings.mjs";
import {
  answerTelegramCallback,
  getTelegramUpdates,
  sendTelegramMessage,
  telegramEnabled
} from "./telegram-client.mjs";

const n = (value, digits = 2) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const pct = (value, digits = 2) => value === null || value === undefined ? "—" : `${n(Number(value) * 100, digits)}%`;

const MAIN_BUTTONS = Object.freeze({
  inline_keyboard: [
    [{ text: "📊 当前仓位", callback_data: "paper:view:positions" }, { text: "🧠 当前判断", callback_data: "paper:view:decision" }],
    [{ text: "🔬 详细分析", callback_data: "paper:view:details" }, { text: "🧪 研究页面", callback_data: "paper:view:research" }],
    [{ text: "💰 账户状态", callback_data: "paper:view:account" }, { text: "📈 今日表现", callback_data: "paper:view:today" }],
    [{ text: "⚙️ 风险设置", callback_data: "paper:view:risk" }, { text: "🎚 杠杆设置", callback_data: "paper:view:leverage" }],
    [{ text: "➕ 加仓设置", callback_data: "paper:view:pyramiding" }, { text: "📋 最近交易", callback_data: "paper:view:recent" }],
    [{ text: "⏸ 暂停新开仓", callback_data: "paper:set:newEntriesPaused:true" }, { text: "▶️ 恢复", callback_data: "paper:set:newEntriesPaused:false" }]
  ]
});

function settingsText(settings) {
  return [
    "⚙️ Paper Trading 控制面板",
    `配置版本：${settings.revision}`,
    `新开仓：${settings.newEntriesPaused ? "已暂停" : "允许评估"}`,
    `风险偏好：${riskProfileChinese(settings.riskProfile)}`,
    `单笔风险上限：${pct(settings.riskPerTradePct)}`,
    `总风险上限：${pct(settings.maxTotalRiskPct)}`,
    `保证金使用上限：${pct(settings.maxMarginUsagePct)}`,
    `用户杠杆上限：${n(settings.userMaxLeverage, 1)}x（实际杠杆仍由仓位反推）`,
    `总名义仓位上限：权益的 ${n(settings.maxTotalNotionalMultiple, 1)} 倍`,
    `加仓：${settings.allowPyramiding ? "开启" : "关闭"}；最大 ${settings.maxOpenPositions} 仓`,
    `日损失上限：${pct(settings.maxDailyLossPct)}；连亏 ${settings.maxConsecutiveLosses} 笔暂停`,
    "所有按钮只改变本地 SQLite 中的模拟交易参数。"
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
      `单笔风险：${pct(settings.riskPerTradePct)}`,
      `总风险：${pct(settings.maxTotalRiskPct)}`,
      `日损失：${pct(settings.maxDailyLossPct)}`,
      `连亏暂停：${settings.maxConsecutiveLosses} 笔`
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "保守", callback_data: "paper:set:riskProfile:CONSERVATIVE" }, { text: "均衡", callback_data: "paper:set:riskProfile:BALANCED" }, { text: "积极", callback_data: "paper:set:riskProfile:AGGRESSIVE" }],
      [{ text: "单笔0.5%", callback_data: "paper:set:riskPerTradePct:0.005" }, { text: "单笔0.75%", callback_data: "paper:set:riskPerTradePct:0.0075" }, { text: "单笔1%", callback_data: "paper:set:riskPerTradePct:0.01" }],
      [{ text: "日损1%", callback_data: "paper:set:maxDailyLossPct:0.01" }, { text: "日损2%", callback_data: "paper:set:maxDailyLossPct:0.02" }, { text: "日损3%", callback_data: "paper:set:maxDailyLossPct:0.03" }],
      [{ text: "连亏1笔暂停", callback_data: "paper:set:maxConsecutiveLosses:1" }, { text: "2笔", callback_data: "paper:set:maxConsecutiveLosses:2" }, { text: "3笔", callback_data: "paper:set:maxConsecutiveLosses:3" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function leveragePanel(settings) {
  return {
    text: [
      "🎚 杠杆与保证金设置",
      `用户最大杠杆：${n(settings.userMaxLeverage, 1)}x`,
      `保证金使用上限：${pct(settings.maxMarginUsagePct)}`,
      `总名义仓位：权益的 ${n(settings.maxTotalNotionalMultiple, 1)} 倍`,
      "实际杠杆由止损、风险、仓位和保证金反推，不会自动用满上限。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "上限2x", callback_data: "paper:set:userMaxLeverage:2" }, { text: "上限3x", callback_data: "paper:set:userMaxLeverage:3" }, { text: "上限5x", callback_data: "paper:set:userMaxLeverage:5" }],
      [{ text: "保证金10%", callback_data: "paper:set:maxMarginUsagePct:0.1" }, { text: "20%", callback_data: "paper:set:maxMarginUsagePct:0.2" }, { text: "30%", callback_data: "paper:set:maxMarginUsagePct:0.3" }],
      [{ text: "仓位0.5倍", callback_data: "paper:set:maxTotalNotionalMultiple:0.5" }, { text: "1倍", callback_data: "paper:set:maxTotalNotionalMultiple:1" }, { text: "2倍", callback_data: "paper:set:maxTotalNotionalMultiple:2" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
    ] }
  };
}

function pyramidingPanel(settings) {
  return {
    text: [
      "➕ 加仓设置",
      `加仓：${settings.allowPyramiding ? "开启" : "关闭"}`,
      `最大同时仓位：${settings.maxOpenPositions}`,
      `组合总风险上限：${pct(settings.maxTotalRiskPct)}`,
      "开启后仍要求同方向、有利进展、新高质量信号及组合风险/保证金/名义仓位全部通过。"
    ].join("\n"),
    markup: { inline_keyboard: [
      [{ text: "关闭加仓", callback_data: "paper:set:allowPyramiding:false" }, { text: "开启加仓", callback_data: "paper:set:allowPyramiding:true" }],
      [{ text: "最多1仓", callback_data: "paper:set:maxOpenPositions:1" }, { text: "最多2仓", callback_data: "paper:set:maxOpenPositions:2" }, { text: "最多3仓", callback_data: "paper:set:maxOpenPositions:3" }],
      [{ text: "总风险1%", callback_data: "paper:set:maxTotalRiskPct:0.01" }, { text: "2%", callback_data: "paper:set:maxTotalRiskPct:0.02" }, { text: "3%", callback_data: "paper:set:maxTotalRiskPct:0.03" }],
      [{ text: "返回", callback_data: "paper:view:main" }]
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
  if (key === "riskProfile") return raw;
  return Number(raw);
}

export class TelegramControlPanel {
  constructor(db, {
    config = TELEGRAM_CONFIG,
    fetchImpl = globalThis.fetch,
    logger = (message) => process.stderr.write(`${message}\n`),
    getUpdates = getTelegramUpdates,
    send = sendTelegramMessage,
    answer = answerTelegramCallback
  } = {}) {
    this.db = db;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.getUpdates = getUpdates;
    this.send = send;
    this.answer = answer;
    this.timer = null;
    this.polling = false;
  }

  get enabled() { return telegramEnabled(this.config); }
  isAdmin(chatId) { return String(chatId) === String(this.config.chatId); }

  async sendView(text, replyMarkup = MAIN_BUTTONS) {
    return this.send(text, { config: this.config, fetchImpl: this.fetchImpl, replyMarkup });
  }

  view(name) {
    const settings = this.db.getRuntimeSettings();
    if (name === "positions") return { text: positionText(this.db), markup: MAIN_BUTTONS };
    if (name === "decision") return { text: decisionText(this.db), markup: MAIN_BUTTONS };
    if (name === "details") return { text: detailedAnalysisText(this.db), markup: MAIN_BUTTONS };
    if (name === "research") return { text: researchText(this.db), markup: MAIN_BUTTONS };
    if (name === "account") return { text: accountText(this.db), markup: MAIN_BUTTONS };
    if (name === "today") return { text: todayText(this.db), markup: MAIN_BUTTONS };
    if (name === "risk") return riskPanel(settings);
    if (name === "leverage") return leveragePanel(settings);
    if (name === "pyramiding") return pyramidingPanel(settings);
    if (name === "recent") return { text: recentText(this.db), markup: MAIN_BUTTONS };
    return { text: settingsText(settings), markup: MAIN_BUTTONS };
  }

  async applySetting(key, rawValue, updateId) {
    const value = parseSettingValue(key, rawValue);
    const current = this.db.getRuntimeSettings();
    const patch = { [key]: value };
    if (key === "allowPyramiding" && value === false && current.maxOpenPositions !== 1) patch.maxOpenPositions = 1;
    if (key === "maxOpenPositions" && value > 1 && !current.allowPyramiding) {
      throw new Error("请先开启加仓，再提高最大仓位数");
    }
    return this.db.updateRuntimeSettings(patch, {
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
          await this.sendView(view.text, view.markup);
          await this.answer(callback.id, "已刷新", { config: this.config, fetchImpl: this.fetchImpl });
        } else if (parts[1] === "set") {
          const result = await this.applySetting(parts[2], parts[3], update.update_id);
          await this.sendView(`✅ 设置已保存，下一轮 monitor 生效。\n\n${settingsText(result.settings)}`, MAIN_BUTTONS);
          await this.answer(callback.id, "设置已保存", { config: this.config, fetchImpl: this.fetchImpl });
        } else throw new Error("不支持的按钮");
      } else {
        const text = String(message?.text ?? "").trim();
        if (["/start", "/paper", "/panel", "/status"].includes(text)) {
          await this.sendView(settingsText(this.db.getRuntimeSettings()), MAIN_BUTTONS);
        } else if (["/pause", "/resume"].includes(text)) {
          const paused = text === "/pause";
          const result = await this.applySetting("newEntriesPaused", String(paused), update.update_id);
          await this.sendView(`✅ 已${paused ? "暂停" : "恢复"}新开仓。\n\n${settingsText(result.settings)}`, MAIN_BUTTONS);
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
