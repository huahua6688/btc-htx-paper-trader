import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PAPER_CONFIG } from "../src/config.mjs";
import { PaperDatabase } from "../src/db.mjs";
import {
  CAPITAL_PROFILES,
  DEFAULT_REFERENCE_CAPITAL_CNY,
  resolveCapitalProfile
} from "../src/replay-engine.mjs";

function withTempDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-research-"));
  const db = new PaperDatabase(join(directory, "research.sqlite"));
  try {
    return work(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- C. 两种资金视角

test("PRODUCTION_FAITHFUL keeps the real Paper capital and is not research-only", () => {
  const resolved = resolveCapitalProfile(PAPER_CONFIG, { capitalProfile: CAPITAL_PROFILES.PRODUCTION_FAITHFUL });
  assert.equal(resolved.initialCapitalCny, PAPER_CONFIG.initialCapitalCny);
  assert.equal(resolved.initialCapitalCny, 1_000, "生产资金规模不得被偷偷改成 2 万/5 万");
  assert.equal(resolved.researchOnly, false);
});

test("EDGE_REFERENCE_CAPITAL is configurable and always flagged research-only", () => {
  const fallback = resolveCapitalProfile(PAPER_CONFIG, { capitalProfile: CAPITAL_PROFILES.EDGE_REFERENCE_CAPITAL });
  assert.equal(fallback.initialCapitalCny, DEFAULT_REFERENCE_CAPITAL_CNY);
  assert.equal(fallback.researchOnly, true);
  assert.match(fallback.note, /RESEARCH_ONLY/);

  const explicit = resolveCapitalProfile(PAPER_CONFIG, {
    capitalProfile: CAPITAL_PROFILES.EDGE_REFERENCE_CAPITAL,
    referenceCapitalCny: 50_000
  });
  assert.equal(explicit.initialCapitalCny, 50_000);
  assert.equal(explicit.researchOnly, true);
});

test("an unknown or invalid capital profile is rejected rather than silently defaulted", () => {
  assert.throws(() => resolveCapitalProfile(PAPER_CONFIG, { capitalProfile: "WHATEVER" }), /Unknown capital profile/);
  assert.throws(() => resolveCapitalProfile(PAPER_CONFIG, {
    capitalProfile: CAPITAL_PROFILES.EDGE_REFERENCE_CAPITAL,
    referenceCapitalCny: -1
  }), /positive number/);
});

test("the default PAPER_CONFIG production capital is untouched by this refactor", () => {
  assert.equal(PAPER_CONFIG.initialCapitalCny, 1_000);
});

// ---------------------------------------------------------------- G. 研究运行真的会被持久化

test("research runs and strategy versions actually persist", () => {
  withTempDatabase((db) => {
    assert.equal(db.getResearchRuns({ limit: 100 }).length, 0, "全新库应当没有研究运行");
    const id = db.recordResearchRun({
      runType: "HISTORICAL_REPLAY_BACKTEST",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:05:00.000Z",
      status: "PASSED",
      artifactPath: "/tmp/x.json",
      dataManifestHash: "deadbeef",
      strategyVersion: "challenger-technical-v1",
      summary: { tradeCount: 12 }
    });
    assert.ok(id > 0);
    const runs = db.getResearchRuns({ limit: 100 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_type, "HISTORICAL_REPLAY_BACKTEST");
    assert.equal(runs[0].status, "PASSED");
  });
});

test("a blocked research run is recorded as BLOCKED, never dressed up as a pass", () => {
  withTempDatabase((db) => {
    db.recordResearchRun({
      runType: "RESEARCH_CLI_BACKTEST",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:00:01.000Z",
      status: "BLOCKED",
      summary: { blockedReason: "no local catalog" }
    });
    const [run] = db.getResearchRuns({ limit: 10 });
    assert.equal(run.status, "BLOCKED");
    assert.equal(JSON.parse(run.summary_json).blockedReason, "no local catalog");
  });
});

test("the frozen Champion is registered and a new candidate never overwrites it", () => {
  withTempDatabase((db) => {
    const champion = db.getStrategyVersion("V1.2-FROZEN");
    assert.ok(champion, "冻结 Champion 必须已登记");
    assert.equal(champion.role, "CHAMPION");
    assert.equal(champion.lifecycle_status, "FROZEN");

    db.registerStrategyVersion({
      version: "V1.3-DATA-TIERED-CANDIDATE",
      role: "CHALLENGER",
      lifecycleStatus: "CANDIDATE",
      strategyHash: "abc123",
      codeSha256: "abc123",
      promotionReason: "BLOCKED: no OOS evidence yet",
      rollbackVersion: "V1.2-FROZEN"
    });
    const after = db.getStrategyVersion("V1.2-FROZEN");
    assert.equal(after.role, "CHAMPION", "登记候选不得改变 Champion");
    assert.equal(after.lifecycle_status, "FROZEN");
    assert.equal(db.getStrategyVersions({ limit: 100 }).length, 2);

    // 同名不同哈希必须被拒绝，防止静默改写一个已登记的版本。
    assert.throws(() => db.registerStrategyVersion({
      version: "V1.3-DATA-TIERED-CANDIDATE",
      role: "CHALLENGER",
      lifecycleStatus: "CANDIDATE",
      strategyHash: "different"
    }), /哈希不同/);
  });
});

test("the frozen Champion source is byte-identical to its published hash", async () => {
  const { createHash } = await import("node:crypto");
  const source = await readFile(new URL("../src/analysis-engine.mjs", import.meta.url));
  const hash = createHash("sha256").update(source).digest("hex");
  assert.equal(hash, "9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6",
    "本次重构不得修改冻结的 V1.2 分析引擎");
});
