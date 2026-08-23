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
  const answered = [];
  try {
    const updates = [
      { update_id: 10, callback_query: { id: "bad", data: "paper:set:newEntriesPaused:true", message: { chat: { id: 999 } } } },
      { update_id: 11, callback_query: { id: "good", data: "paper:set:riskProfile:CONSERVATIVE", message: { chat: { id: 42 } } } }
    ];
    const panel = new TelegramControlPanel(db, {
      config: { botToken: token, chatId: "42", controlPollIntervalMs: 5_000 },
      getUpdates: async (offset) => ({ ok: true, result: updates.filter((item) => item.update_id >= offset) }),
      send: async (text, options) => { sent.push({ text, options }); return { ok: true }; },
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
    assert.equal(audit.length, 1);
    assert.equal(audit[0].source, "TELEGRAM_ADMIN_CHAT");
    assert.equal(audit[0].source_event_id, "telegram:11");
    assert.ok(sent[0].options.replyMarkup.inline_keyboard.flat().some((button) => button.text.includes("当前仓位")));
    assert.ok(panel.view("risk").markup.inline_keyboard.flat().some((button) => button.callback_data?.includes("maxConsecutiveLosses")));
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
      answer: async () => ({ ok: true }),
      logger: () => {}
    });
    const update = { update_id: 99, callback_query: { id: "same", data: "paper:set:newEntriesPaused:true", message: { chat: { id: 42 } } } };
    await panel.handleAdminUpdate(update);
    await panel.handleAdminUpdate(update);
    assert.equal(db.getRuntimeSettings().newEntriesPaused, true);
    assert.equal(db.getRuntimeSettingAudit().filter((item) => item.setting_key === "newEntriesPaused").length, 1);
  } finally {
    db.close();
  }
});
