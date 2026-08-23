import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PaperDatabase } from "../src/db.mjs";

test("runtime settings are atomic, audited, idempotent and survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-settings-"));
  const path = join(directory, "paper.sqlite");
  try {
    let db = new PaperDatabase(path);
    const firstDefaultsAt = db.getRuntimeSettings().updatedAt;
    const firstRevision = db.getRuntimeSettings().revision;
    const result = db.updateRuntimeSettings({
      allowPyramiding: true,
      maxOpenPositions: 2,
      riskPerTradePct: 0.0075
    }, {
      source: "TELEGRAM_ADMIN_CHAT",
      sourceEventId: "telegram:42",
      updatedAt: "2026-08-21T01:00:00.000Z"
    });
    assert.deepEqual(result.changed.sort(), ["allowPyramiding", "maxOpenPositions", "riskPerTradePct"].sort());
    const duplicate = db.updateRuntimeSettings({ riskPerTradePct: 0.005 }, {
      source: "TELEGRAM_ADMIN_CHAT",
      sourceEventId: "telegram:42"
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(db.getRuntimeSettings().riskPerTradePct, 0.0075);
    assert.equal(db.getRuntimeSettings().revision, firstRevision + 1);
    assert.equal(db.getRuntimeSettingAudit().length, 3);
    assert.ok(db.getRuntimeSettingAudit().every((item) => item.source === "TELEGRAM_ADMIN_CHAT"));
    assert.throws(() => db.updateRuntimeSettings({ userMaxLeverage: 50 }), /之间/);
    db.close();

    db = new PaperDatabase(path);
    assert.equal(db.getRuntimeSettings().allowPyramiding, true);
    assert.equal(db.getRuntimeSettings().maxOpenPositions, 2);
    assert.notEqual(db.getRuntimeSettings().updatedAt, firstDefaultsAt);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
