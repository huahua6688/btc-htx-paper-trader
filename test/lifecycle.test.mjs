import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PaperDatabase } from "../src/db.mjs";
import { runMonitorCycle } from "../src/monitor-cycle.mjs";
import { TelegramNotifier } from "../src/telegram-notifier.mjs";
import { paperReport } from "./helpers.mjs";

const memoryState = () => {
  const values = new Map();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => values.set(key, value) };
};

async function cycle(db, report) {
  return runMonitorCycle(db, {
    collect: async () => report,
    analyze: (value) => value,
    now: () => report.generatedAt
  });
}

test("full Paper lifecycle covers restart, hold, trailing risk, funding, close, accounting, Telegram and next trade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-life-"));
  const path = join(directory, "paper.sqlite");
  const messages = [];
  const notifier = new TelegramNotifier({
    config: { botToken: "test", chatId: "42", dailySummaryHour: 23, dailySummaryMinute: 55 },
    stateStore: memoryState(),
    sender: async (text) => { messages.push(text); return { ok: true }; },
    logger: () => {}
  });
  try {
    let db = new PaperDatabase(path);
    const openReport = paperReport({ generatedAt: "2026-08-21T00:01:00.000Z" });
    const opened = await cycle(db, openReport);
    assert.ok(opened.actions.some((item) => item.type === "OPEN"));
    await notifier.notifyMonitorResult(opened, db);
    const originalId = db.getOpenPosition().id;
    const cashAfterEntry = db.getAccount().cash_cny;
    db.close();

    db = new PaperDatabase(path);
    assert.equal(db.getOpenPosition().id, originalId, "重启后应恢复原仓位");
    assert.equal(db.getAccount().cash_cny, cashAfterEntry, "重启不能重置模拟资金");

    const managedReport = paperReport({
      generatedAt: "2026-08-21T01:15:00.000Z",
      currentPrice: 106,
      latest15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), open: 102, high: 106, low: 101, close: 106 },
      completed15mBar: { timestamp: new Date("2026-08-21T01:00:00.000Z").getTime(), open: 102, high: 106, low: 101, close: 106 }
    });
    const managed = await cycle(db, managedReport);
    assert.ok(managed.actions.some((item) => item.type === "POSITION_MANAGED"));
    assert.ok(db.getOpenPosition().stop_loss > db.getOpenPosition().entry_price);

    const fundedReport = paperReport({
      generatedAt: "2026-08-21T08:01:00.000Z",
      currentPrice: 108,
      latest15mBar: { timestamp: new Date("2026-08-21T07:46:00.000Z").getTime(), open: 106, high: 108, low: 105, close: 108 },
      completed15mBar: { timestamp: new Date("2026-08-21T07:46:00.000Z").getTime(), open: 106, high: 108, low: 105, close: 108 }
    });
    const funded = await cycle(db, fundedReport);
    assert.ok(funded.actions.some((item) => item.type === "FUNDING"));
    assert.notEqual(db.getOpenPosition().funding_cny, 0);

    const closeReport = paperReport({
      generatedAt: "2026-08-21T08:15:00.000Z",
      currentPrice: 112,
      latest15mBar: { timestamp: new Date("2026-08-21T08:00:00.000Z").getTime(), open: 108, high: 112, low: 108, close: 112 },
      completed15mBar: { timestamp: new Date("2026-08-21T08:00:00.000Z").getTime(), open: 108, high: 112, low: 108, close: 112 }
    });
    const closed = await cycle(db, closeReport);
    const closeAction = closed.actions.find((item) => item.type === "CLOSE");
    assert.ok(closeAction);
    await notifier.notifyMonitorResult(closed, db);
    assert.equal(db.getOpenPosition(), null);
    assert.ok(closeAction.position.gross_pnl_cny > closeAction.position.net_pnl_cny);
    assert.ok(closeAction.position.entry_fee_cny > 0);
    assert.ok(closeAction.position.exit_fee_cny > 0);
    assert.ok(closeAction.position.exit_slippage_cny > 0);
    assert.notEqual(closeAction.position.funding_cny, 0);
    assert.ok(db.getAccountEvents().some((item) => item.event_type === "FUNDING"));
    assert.ok(messages.some((item) => item.includes("模拟开多")));
    assert.ok(messages.some((item) => item.includes("持仓时间") && item.includes("净收益")));

    const nextReport = paperReport({
      generatedAt: "2026-08-21T08:30:00.000Z",
      latest15mBar: { timestamp: new Date("2026-08-21T08:15:00.000Z").getTime(), open: 99, high: 101, low: 98, close: 100 },
      completed15mBar: { timestamp: new Date("2026-08-21T08:15:00.000Z").getTime(), open: 99, high: 101, low: 98, close: 100 }
    });
    const next = await cycle(db, nextReport);
    assert.ok(next.actions.some((item) => item.type === "OPEN"), "平仓后的下一轮可独立评估并开下一笔");
    assert.notEqual(db.getOpenPosition().id, originalId);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
