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
    assert.ok(["allowPyramiding", "maxOpenPositions", "riskPerTradePct", "riskMode", "riskManualPct"]
      .every((key) => result.changed.includes(key)));
    const duplicate = db.updateRuntimeSettings({ riskPerTradePct: 0.005 }, {
      source: "TELEGRAM_ADMIN_CHAT",
      sourceEventId: "telegram:42"
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(db.getRuntimeSettings().riskPerTradePct, 0.0075);
    assert.equal(db.getRuntimeSettings().revision, firstRevision + 1);
    assert.equal(db.getRuntimeSettingAudit().length, result.changed.length);
    assert.ok(db.getRuntimeSettingAudit().every((item) => item.source === "TELEGRAM_ADMIN_CHAT"));
    const ranged = db.updateRuntimeSettings({
      leverageMode: "AUTO", leverageMin: 3, leverageMax: 120,
      riskMode: "AUTO", riskMinPct: 0.005, riskMaxPct: 0.06
    }, { source: "TELEGRAM_ADMIN_CHAT", sourceEventId: "telegram:43" });
    assert.equal(ranged.settings.leverageMax, 120);
    assert.equal(ranged.settings.riskMaxPct, 0.06);
    const revisionBeforeNoop = ranged.settings.revision;
    const noChange = db.updateRuntimeSettings({ leverageMode: "AUTO" }, {
      source: "TELEGRAM_ADMIN_CHAT", sourceEventId: "telegram:44"
    });
    assert.equal(noChange.noChange, true);
    assert.equal(db.getRuntimeSettings().revision, revisionBeforeNoop);
    assert.throws(() => db.updateRuntimeSettings({ leverageMax: 201 }), /之间/);
    db.close();

    db = new PaperDatabase(path);
    assert.equal(db.getRuntimeSettings().allowPyramiding, true);
    assert.equal(db.getRuntimeSettings().maxOpenPositions, 2);
    assert.equal(db.getRuntimeSettings().leverageMax, 120);
    assert.equal(db.getRuntimeSettings().riskMaxPct, 0.06);
    assert.notEqual(db.getRuntimeSettings().updatedAt, firstDefaultsAt);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
