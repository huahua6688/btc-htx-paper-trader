import test from "node:test";
import assert from "node:assert/strict";
import { PaperDatabase } from "../src/db.mjs";
import { editTelegramMessage, sendTelegramMessage } from "../src/telegram-client.mjs";
import { classifyCloseTelegram, formatCloseTelegram, formatOpenTelegram } from "../src/telegram-format.mjs";
import { shanghaiClock, TelegramNotifier } from "../src/telegram-notifier.mjs";
import { directCandidate, paperReport } from "./helpers.mjs";

const telegramConfig = Object.freeze({
  botToken: "unit-test-token",
  chatId: "12345",
  apiBaseUrl: "https://api.telegram.test",
  timeoutMs: 100,
  dailySummaryHour: 23,
  dailySummaryMinute: 55,
  stateDirectory: "unused"
});

class MemoryStateStore {
  constructor() { this.values = new Map(); }
  get(key) { return this.values.get(key) ?? null; }
  set(key, value) { this.values.set(key, String(value)); }
}

function notifierHarness(sender = async () => ({ ok: true, skipped: false, messageId: 1 })) {
  const messages = [];
  const logs = [];
  const notifier = new TelegramNotifier({
    config: telegramConfig,
    stateStore: new MemoryStateStore(),
    sender: async (message, options) => {
      messages.push(message);
      return sender(message, options);
    },
    logger: (message) => logs.push(message)
  });
  return { notifier, messages, logs };
}

test("Telegram client posts plain text through sendMessage", async () => {
  let request;
  const result = await sendTelegramMessage("paper test", {
    config: telegramConfig,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 77);
  assert.equal(request.url, "https://api.telegram.test/botunit-test-token/sendMessage");
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: "12345", text: "paper test" });
});

test("Telegram panel refresh uses editMessageText instead of creating another message", async () => {
  let request;
  const result = await editTelegramMessage(77, "updated panel", {
    config: telegramConfig,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    },
    replyMarkup: { inline_keyboard: [[{ text: "返回", callback_data: "paper:view:main" }]] }
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, "https://api.telegram.test/botunit-test-token/editMessageText");
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: "12345",
    message_id: 77,
    text: "updated panel",
    reply_markup: { inline_keyboard: [[{ text: "返回", callback_data: "paper:view:main" }]] }
  });
});

test("Telegram client skips missing configuration and redacts token on network errors", async () => {
  const skipped = await sendTelegramMessage("x", {
    config: { ...telegramConfig, botToken: "" },
    fetchImpl: async () => { throw new Error("must not run"); }
  });
  assert.equal(skipped.skipped, true);

  const failed = await sendTelegramMessage("x", {
    config: telegramConfig,
    fetchImpl: async () => { throw new Error(`failed unit-test-token`); }
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.error, /unit-test-token/);
  assert.match(failed.error, /REDACTED/);
});

test("WAIT produces no Telegram event notification", async () => {
  const { notifier, messages } = notifierHarness();
  const db = new PaperDatabase(":memory:");
  try {
    await notifier.notifyMonitorResult({
      report: paperReport({ decision: "WAIT", generatedAt: "2026-08-21T01:00:00.000Z" }),
      actions: [{ type: "NO_ENTRY", reasons: ["WAIT"], dailyRisk: { paused: false } }]
    }, db);
    assert.equal(messages.length, 0);
  } finally {
    db.close();
  }
});

test("paper LONG/SHORT and TP/SL messages contain the required trade fields", () => {
  const common = {
    id: 9,
    opened_at: "2026-08-21T01:00:00.000Z",
    closed_at: "2026-08-21T02:00:00.000Z",
    entry_price: 100,
    stop_loss: 95,
    take_profit: 111,
    rr: 2.1,
    quantity_btc: 0.01,
    risk_cny: 9,
    openingReasons: ["趋势确认"],
    exit_price: 111,
    gross_pnl_cny: 10,
    entry_fee_cny: 0.1,
    exit_fee_cny: 0.1,
    funding_cny: -0.02,
    net_pnl_cny: 9.78
  };
  assert.match(formatOpenTelegram({ ...common, side: "LONG" }), /模拟开多/);
  assert.match(formatOpenTelegram({ ...common, side: "SHORT" }), /模拟开空/);
  assert.match(formatCloseTelegram({ ...common, side: "LONG", exit_reason: "TP" }), /模拟止盈/);
  assert.match(formatCloseTelegram({ ...common, side: "SHORT", exit_reason: "SL", stop_loss: 105 }), /风险止损/);
});

function closePosition(overrides = {}) {
  return {
    id: 12,
    side: "LONG",
    exit_reason: "SL",
    opened_at: "2026-08-21T01:00:00.000Z",
    closed_at: "2026-08-21T02:00:00.000Z",
    entry_price: 100,
    stop_loss: 95,
    exit_price: 95,
    gross_pnl_cny: -5,
    entry_fee_cny: 0.1,
    exit_fee_cny: 0.1,
    entry_slippage_cny: 0.02,
    exit_slippage_cny: 0.02,
    funding_cny: 0,
    net_pnl_cny: -5.24,
    account_equity_cny: 1000,
    ...overrides
  };
}

test("Telegram classifies LONG risk, profit-protect, and breakeven stops by stop location", () => {
  const risk = closePosition({ side: "LONG", stop_loss: 95 });
  const protectedProfit = closePosition({ side: "LONG", stop_loss: 105, exit_price: 105, net_pnl_cny: 4.7 });
  const breakeven = closePosition({ side: "LONG", stop_loss: 100.05, exit_price: 100.05, net_pnl_cny: -0.2 });
  assert.equal(classifyCloseTelegram(risk), "RISK_STOP");
  assert.match(formatCloseTelegram(risk), /🛑 模拟平仓（风险止损）/);
  assert.match(formatCloseTelegram(risk), /价格触及风险止损/);
  assert.equal(classifyCloseTelegram(protectedProfit), "PROFIT_PROTECT_STOP");
  assert.match(formatCloseTelegram(protectedProfit), /🟢 模拟平仓（盈利保护）/);
  assert.match(formatCloseTelegram(protectedProfit), /保护止损：105\.0 USDT/);
  assert.equal(classifyCloseTelegram(breakeven), "BREAKEVEN_STOP");
  assert.match(formatCloseTelegram(breakeven), /🟡 模拟平仓（保本保护）/);
  assert.match(formatCloseTelegram(breakeven), /价格触及保本止损/);
});

test("Telegram classifies SHORT risk, profit-protect, and breakeven stops by stop location", () => {
  const risk = closePosition({ side: "SHORT", stop_loss: 105 });
  const protectedProfit = closePosition({ side: "SHORT", stop_loss: 95, exit_price: 95, net_pnl_cny: 4.7 });
  const breakeven = closePosition({ side: "SHORT", stop_loss: 99.95, exit_price: 99.95, net_pnl_cny: -0.2 });
  assert.equal(classifyCloseTelegram(risk), "RISK_STOP");
  assert.match(formatCloseTelegram(risk), /价格触及风险止损/);
  assert.equal(classifyCloseTelegram(protectedProfit), "PROFIT_PROTECT_STOP");
  assert.match(formatCloseTelegram(protectedProfit), /价格触及盈利保护止损/);
  assert.equal(classifyCloseTelegram(breakeven), "BREAKEVEN_STOP");
  assert.match(formatCloseTelegram(breakeven), /价格触及保本止损/);
});

test("profit-protect stop stays profit-protect when costs make net PnL non-positive", () => {
  const position = closePosition({
    side: "LONG", stop_loss: 102, exit_price: 102, gross_pnl_cny: 1,
    entry_fee_cny: 0.6, exit_fee_cny: 0.6, net_pnl_cny: -0.2
  });
  assert.equal(classifyCloseTelegram(position), "PROFIT_PROTECT_STOP");
  assert.match(formatCloseTelegram(position), /模拟平仓（盈利保护）/);
});

test("TP, EARLY_PROFIT, and SIGNAL_INVALIDATED display semantics remain unchanged", () => {
  const takeProfit = formatCloseTelegram(closePosition({ exit_reason: "TP", stop_loss: 95, exit_price: 110, net_pnl_cny: 9 }));
  const earlyProfit = formatCloseTelegram(closePosition({ exit_reason: "EARLY_PROFIT", stop_loss: 95, exit_price: 103, net_pnl_cny: 2 }));
  const invalidated = formatCloseTelegram(closePosition({ exit_reason: "SIGNAL_INVALIDATED", stop_loss: 105 }));
  assert.match(takeProfit, /✅ 模拟平仓（盈利）/);
  assert.match(takeProfit, /价格触及模拟止盈/);
  assert.match(earlyProfit, /✅ 模拟平仓（盈利）/);
  assert.match(earlyProfit, /提前保护利润/);
  assert.match(invalidated, /🛑 模拟平仓（风险控制）/);
  assert.match(invalidated, /原开仓逻辑连续确认失效/);
  assert.doesNotMatch(invalidated, /盈利保护止损|保本止损/);
});

test("Telegram failures are logged and never escape the monitor notification layer", async () => {
  const { notifier, logs } = notifierHarness(async () => ({ ok: false, skipped: false, error: "network unavailable" }));
  const db = new PaperDatabase(":memory:");
  try {
    await notifier.notifyMonitorResult({
      report: paperReport({ generatedAt: "2026-08-21T01:00:00.000Z" }),
      actions: [{ type: "OPEN", position: { ...directCandidate(), id: 1, status: "OPEN", side: "LONG", entry_price: 100, stop_loss: 95, take_profit: 111, quantity_btc: 0.01, risk_cny: 9, rr: 2.1, opened_at: "2026-08-21T01:00:00.000Z", openingReasons: [] } }]
    }, db);
    assert.match(logs.join(" "), /failed safely/);
  } finally {
    db.close();
  }
});

test("risk pause notification is deduplicated once per Shanghai day", async () => {
  const { notifier, messages } = notifierHarness();
  const db = new PaperDatabase(":memory:");
  const dailyRisk = {
    paused: true,
    dayStart: "2026-08-20T16:00:00.000Z",
    dailyPnlCny: -31,
    maxDailyLossCny: 30,
    consecutiveLosses: 3,
    pauseReasons: ["当日损失达到上限"]
  };
  const result = {
    report: paperReport({ decision: "WAIT", generatedAt: "2026-08-21T01:00:00.000Z" }),
    actions: [{ type: "NO_ENTRY", reasons: dailyRisk.pauseReasons, dailyRisk }]
  };
  try {
    await notifier.notifyMonitorResult(result, db);
    await notifier.notifyMonitorResult(result, db);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /风控暂停新交易/);
  } finally {
    db.close();
  }
});

test("daily summary sends once after 23:55 Shanghai and contains all metrics", async () => {
  const { notifier, messages } = notifierHarness();
  const db = new PaperDatabase(":memory:");
  const result = {
    report: paperReport({ decision: "WAIT", generatedAt: "2026-08-21T15:56:00.000Z" }),
    actions: [{ type: "NO_ENTRY", reasons: ["WAIT"], dailyRisk: { paused: false } }]
  };
  try {
    await notifier.notifyMonitorResult(result, db);
    await notifier.notifyMonitorResult(result, db);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /每日汇总/);
    assert.match(messages[0], /当前模拟资金/);
    assert.match(messages[0], /Profit Factor/);
    assert.match(messages[0], /最大回撤/);
    assert.match(messages[0], /当前持仓/);
  } finally {
    db.close();
  }
});

test("health failure and recovery each notify once", async () => {
  const { notifier, messages } = notifierHarness();
  const failed = {
    healthy: false,
    checkedAt: "2026-08-21T01:00:00.000Z",
    failures: ["monitor stale"],
    monitor: { status: "ERROR" },
    snapshot: null
  };
  const recovered = {
    healthy: true,
    checkedAt: "2026-08-21T01:05:00.000Z",
    failures: [],
    monitor: { status: "OK" },
    snapshot: { count: 10 }
  };
  await notifier.notifyHealthResult(failed);
  await notifier.notifyHealthResult(failed);
  await notifier.notifyHealthResult(recovered);
  await notifier.notifyHealthResult(recovered);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /健康检查失败/);
  assert.match(messages[1], /恢复正常/);
});

test("Shanghai summary clock uses UTC+8", () => {
  assert.deepEqual(shanghaiClock("2026-08-21T15:55:00.000Z"), { dayKey: "2026-08-21", minuteOfDay: 23 * 60 + 55 });
  assert.deepEqual(shanghaiClock("2026-08-21T16:00:00.000Z"), { dayKey: "2026-08-22", minuteOfDay: 0 });
});
