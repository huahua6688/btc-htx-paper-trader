import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PaperDatabase } from "../src/db.mjs";
import { TelegramControlPanel } from "../src/telegram-control.mjs";
import { paperReport } from "./helpers.mjs";

test("Telegram control accepts only the configured administrator and persists atomic audited settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-telegram-"));
  const path = join(directory, "paper.sqlite");
  const token = "unit-test-token-not-a-credential";
  const db = new PaperDatabase(path);
  db.insertSnapshot(paperReport());
  const sent = [];
  const edited = [];
  const answered = [];
  try {
    const updates = [
      { update_id: 10, callback_query: { id: "bad", data: "paper:set:newEntriesPaused:true", message: { message_id: 1, chat: { id: 999 } } } },
      { update_id: 11, callback_query: { id: "good", data: "paper:set:riskProfile:CONSERVATIVE", message: { message_id: 2, chat: { id: 42 } } } }
    ];
    const panel = new TelegramControlPanel(db, {
      config: { botToken: token, chatId: "42", controlPollIntervalMs: 5_000 },
      getUpdates: async (offset) => ({ ok: true, result: updates.filter((item) => item.update_id >= offset) }),
      send: async (text, options) => { sent.push({ text, options }); return { ok: true }; },
      edit: async (messageId, text, options) => { edited.push({ messageId, text, options }); return { ok: true }; },
      answer: async (id, text) => { answered.push({ id, text }); return { ok: true }; },
      logger: () => {}
    });
    const result = await panel.pollOnce();
    assert.equal(result.processed, 2);
    assert.equal(db.getRuntimeSettings().newEntriesPaused, false, "非管理员不能暂停");
    assert.equal(db.getRuntimeSettings().riskProfile, "CONSERVATIVE");
    assert.equal(db.getTelegramUpdateOffset(), 12);
    assert.ok(answered.some((item) => item.id === "bad" && item.text === "无权限"));
    const audit = db.getRuntimeSettingAudit();
    assert.ok(audit.length >= 1);
    assert.ok(audit.every((item) => item.source === "TELEGRAM_ADMIN_CHAT" && item.source_event_id === "telegram:11"));
    assert.ok(audit.some((item) => item.setting_key === "riskProfile"));
    assert.equal(sent.length, 0, "callback should edit the existing panel instead of sending a new message");
    assert.equal(edited.length, 1);
    assert.ok(edited[0].text.includes("风险设置"));
    assert.ok(panel.view("risk").markup.inline_keyboard.flat().some((button) => button.callback_data === "paper:view:range-lossStreak"));
    assert.ok(panel.view("range-risk").markup.inline_keyboard.flat().some((button) => button.callback_data?.includes("riskMaxPct")));
    assert.ok(panel.view("range-risk").text.includes("最低值"));
    assert.ok(panel.view("range-risk").text.includes("最高值"));
    assert.ok(panel.view("range-risk").text.includes("手动值"));
    assert.ok(panel.view("range-risk").text.includes("自动可用上限"));
    assert.ok(panel.view("range-leverage").markup.inline_keyboard.flat().some((button) => button.callback_data?.includes("leverageManual")));
    assert.ok(panel.view("leverage").text.includes("1x～200x"));
    assert.equal(panel.view("main").markup.inline_keyboard.flat().some((button) => button.text.includes("恢复")), false);
    assert.ok(panel.view("details").text.includes("仅实际生效因素"));
    assert.ok(panel.view("research").text.includes("权重为 0"));
  } finally {
    db.close();
    assert.equal(readFileSync(path).includes(Buffer.from(token)), false, "Bot Token 不得写入 SQLite");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate Telegram callback event is idempotent", async () => {
  const db = new PaperDatabase(":memory:");
  try {
    const panel = new TelegramControlPanel(db, {
      config: { botToken: "test-token", chatId: "42" },
      send: async () => ({ ok: true }),
      edit: async () => ({ ok: true }),
      answer: async () => ({ ok: true }),
      logger: () => {}
    });
    const update = { update_id: 99, callback_query: { id: "same", data: "paper:set:newEntriesPaused:true", message: { message_id: 9, chat: { id: 42 } } } };
    await panel.handleAdminUpdate(update);
    await panel.handleAdminUpdate(update);
    assert.equal(db.getRuntimeSettings().newEntriesPaused, true);
    assert.equal(db.getRuntimeSettingAudit().filter((item) => item.setting_key === "newEntriesPaused").length, 1);
  } finally {
    db.close();
  }
});

test("range and pause callbacks refresh one message and keep the user in context", async () => {
  const db = new PaperDatabase(":memory:");
  const sent = [];
  const edited = [];
  try {
    const panel = new TelegramControlPanel(db, {
      config: { botToken: "test-token", chatId: "42" },
      send: async (...args) => { sent.push(args); return { ok: true }; },
      edit: async (messageId, text, options) => { edited.push({ messageId, text, options }); return { ok: true }; },
      answer: async () => ({ ok: true }),
      logger: () => {}
    });
    await panel.handleAdminUpdate({
      update_id: 201,
      callback_query: { id: "lower", data: "paper:adj:leverageMax:-10", message: { message_id: 77, chat: { id: 42 } } }
    });
    assert.equal(db.getRuntimeSettings().leverageMax, 190);
    assert.equal(sent.length, 0);
    assert.equal(edited.at(-1).messageId, 77);
    assert.ok(edited.at(-1).text.includes("用户杠杆限制"));

    await panel.handleAdminUpdate({
      update_id: 202,
      callback_query: { id: "pause", data: "paper:set:newEntriesPaused:true", message: { message_id: 77, chat: { id: 42 } } }
    });
    assert.equal(db.getRuntimeSettings().newEntriesPaused, true);
    assert.equal(edited.length, 2);
    const buttons = edited.at(-1).options.replyMarkup.inline_keyboard.flat();
    assert.equal(buttons.some((button) => button.callback_data === "paper:set:newEntriesPaused:true"), false);
    assert.equal(buttons.some((button) => button.text.includes("取消手动暂停")), true);
  } finally {
    db.close();
  }
});

test("one-click automatic range preset upgrades preserved legacy limits without a message flood", async () => {
  const db = new PaperDatabase(":memory:");
  const sent = [];
  const edited = [];
  try {
    db.updateRuntimeSettings({
      riskPerTradePct: 0.01,
      maxMarginUsagePct: 0.25,
      userMaxLeverage: 5,
      maxTotalNotionalMultiple: 1,
      maxTotalRiskPct: 0.02,
      maxDailyLossPct: 0.03,
      maxConsecutiveLosses: 3
    });
    const panel = new TelegramControlPanel(db, {
      config: { botToken: "test-token", chatId: "42" },
      send: async (...args) => { sent.push(args); return { ok: true }; },
      edit: async (messageId, text, options) => { edited.push({ messageId, text, options }); return { ok: true }; },
      answer: async () => ({ ok: true }),
      logger: () => {}
    });
    await panel.handleAdminUpdate({
      update_id: 301,
      callback_query: { id: "preset", data: "paper:preset:autoRanges", message: { message_id: 88, chat: { id: 42 } } }
    });
    const settings = db.getRuntimeSettings();
    assert.ok(["riskMode", "marginMode", "leverageMode", "notionalMode", "positionLimitMode", "totalRiskMode", "dailyLossMode", "lossStreakMode"]
      .every((key) => settings[key] === "AUTO"));
    assert.equal(settings.riskMaxPct, 0.05);
    assert.equal(settings.leverageMax, 200);
    assert.equal(settings.notionalMaxMultiple, 20);
    assert.equal(sent.length, 0);
    assert.equal(edited.length, 1);
    assert.equal(edited[0].messageId, 88);
    assert.ok(edited[0].text.includes("单笔风险：自动"));
  } finally {
    db.close();
  }
});
