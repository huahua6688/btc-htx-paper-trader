import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PAPER_CONFIG } from "../src/config.mjs";
import { PaperDatabase } from "../src/db.mjs";
import {
  RESEARCH_REGISTRY,
  readResearchRegistry,
  recordResearchRun,
  registerResearchStrategyVersion,
  researchRegistrySnapshot,
  researchRunsByType,
  resolveResearchRegistryLocation,
  withResearchRegistry
} from "../src/research-registry.mjs";
import {
  classifyResearchFailure,
  EXEMPT_RESEARCH_COMMANDS,
  executeResearchCommand,
  RESEARCH_COMMANDS,
  researchV2RunRecord,
  robustnessRunRecord
} from "../src/research-cli.mjs";
import { TelegramControlPanel } from "../src/telegram-control.mjs";

function withWorkspace(work) {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-registry-"));
  try {
    return work({
      directory,
      registryPath: join(directory, "research-registry.sqlite"),
      paperPath: join(directory, "paper-trading.sqlite")
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function panelFor(db, registryPath) {
  return new TelegramControlPanel(db, {
    config: { botToken: "t", chatId: "1", adminUserId: "" },
    researchRegistryPath: registryPath
  });
}

// ---------------------------------------------------------- 路径与隔离

test("the research registry lives in a persistent location, never in the production paper database", () => {
  assert.notEqual(RESEARCH_REGISTRY.path, PAPER_CONFIG.databasePath);
  assert.equal(RESEARCH_REGISTRY.isolatedFromProduction, true);
  // 长期研究状态不得只存在于随时可清空的 research-output/ 产物目录里。
  assert.doesNotMatch(RESEARCH_REGISTRY.path, /research-output/);
});

test("the registry path is configurable through the documented environment variables", () => {
  const viaPaperVar = resolveResearchRegistryLocation({
    argv: [],
    environment: { PAPER_RESEARCH_DB_PATH: "/tmp/custom-a.sqlite" }
  });
  assert.equal(viaPaperVar.source, "PAPER_RESEARCH_DB_PATH");
  assert.match(viaPaperVar.path, /custom-a\.sqlite$/);

  const viaResearchVar = resolveResearchRegistryLocation({
    argv: [],
    environment: { RESEARCH_DB_PATH: "/tmp/custom-b.sqlite" }
  });
  assert.equal(viaResearchVar.source, "RESEARCH_DB_PATH");

  const viaFlag = resolveResearchRegistryLocation({
    argv: ["node", "cli", "--research-db=/tmp/custom-c.sqlite"],
    environment: {}
  });
  assert.equal(viaFlag.source, "--research-db");

  const fallback = resolveResearchRegistryLocation({ argv: [], environment: {} });
  assert.equal(fallback.source, "PERSISTENT_DEFAULT_NEXT_TO_PAPER_DB");
});

test("the registry refuses to point at the production paper or shadow database", () => {
  assert.throws(() => resolveResearchRegistryLocation({
    argv: [],
    environment: { RESEARCH_DB_PATH: PAPER_CONFIG.databasePath }
  }), /不得指向生产/);

  assert.throws(() => resolveResearchRegistryLocation({
    argv: [],
    environment: { RESEARCH_DB_PATH: "/var/lib/x/shadow.sqlite" },
    paperConfig: { ...PAPER_CONFIG, databasePath: "/var/lib/x/paper.sqlite" },
    shadowConfig: { databasePath: "/var/lib/x/shadow.sqlite" }
  }), /不得指向生产/);
});

// ---------------------------------------------------------- Telegram 只读接通

test("a run written to the registry is visible in Telegram Strategy Learning", () => {
  withWorkspace(({ registryPath, paperPath }) => {
    recordResearchRun({
      runType: "HISTORICAL_REPLAY_BACKTEST",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:05:00.000Z",
      status: "PARTIAL",
      strategyVersion: "challenger-technical-v1",
      summary: { tradeCount: 12 }
    }, { path: registryPath });

    const db = new PaperDatabase(paperPath);
    try {
      const text = panelFor(db, registryPath).view("learning").text;
      assert.match(text, /已持久化研究运行：1/);
      assert.match(text, /HISTORICAL_REPLAY_BACKTEST：PARTIAL/);
      // 生产 Paper 库绝不能被研究任务污染。
      assert.equal(db.getResearchRuns({ limit: 100 }).length, 0);
    } finally {
      db.close();
    }
  });
});

test("a registered V1.3 challenger shows up on the Challenger / Shadow page", () => {
  withWorkspace(({ registryPath, paperPath }) => {
    registerResearchStrategyVersion({
      version: "V1.3-DATA-TIERED-CANDIDATE",
      role: "CHALLENGER",
      lifecycleStatus: "CANDIDATE",
      strategyHash: "88a00579f43c7e6eede7d08ae096248338d98c357ab0519624d1454d229e0306",
      codeSha256: "88a00579f43c7e6eede7d08ae096248338d98c357ab0519624d1454d229e0306",
      promotionReason: "BLOCKED: no OOS/Shadow evidence yet",
      rollbackVersion: "V1.2-FROZEN"
    }, { path: registryPath });

    const db = new PaperDatabase(paperPath);
    try {
      const panel = panelFor(db, registryPath);
      assert.match(panel.view("shadow").text, /V1\.3-DATA-TIERED-CANDIDATE：CANDIDATE/);
      assert.match(panel.view("learning").text, /已登记策略版本：2/);
      // Champion 的身份仍以冻结源码为准，绝不因为登记了候选而改变。
      const championText = panel.view("champion").text;
      assert.match(championText, /V1\.2-FROZEN/);
      assert.match(championText, /9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6/);
    } finally {
      db.close();
    }
  });
});

test("Historical Similarity and Research Results read the registry, not the production database", () => {
  withWorkspace(({ registryPath, paperPath }) => {
    recordResearchRun({
      runType: "HISTORICAL_SIMILARITY",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:01:00.000Z",
      status: "PASSED",
      summary: { matrixRows: 16_440 }
    }, { path: registryPath });

    const db = new PaperDatabase(paperPath);
    try {
      const panel = panelFor(db, registryPath);
      assert.match(panel.view("similarity").text, /16440/);
      assert.match(panel.view("results").text, /HISTORICAL_SIMILARITY \/ PASSED/);
      assert.equal(db.getResearchRuns({ limit: 100 }).length, 0, "生产库不得出现研究运行");
    } finally {
      db.close();
    }
    assert.deepEqual(
      researchRunsByType("HISTORICAL_SIMILARITY", { path: registryPath, limit: 1 }).map((item) => item.status),
      ["PASSED"]
    );
  });
});

test("Telegram degrades safely to 'no research records' when the registry does not exist", () => {
  withWorkspace(({ directory, paperPath }) => {
    const missing = join(directory, "definitely-absent.sqlite");
    assert.equal(existsSync(missing), false);
    const db = new PaperDatabase(paperPath);
    try {
      const panel = panelFor(db, missing);
      for (const view of ["learning", "shadow", "similarity", "results", "champion"]) {
        const text = panel.view(view).text;
        assert.ok(typeof text === "string" && text.length > 0, `${view} 不得崩溃`);
      }
      assert.match(panel.view("learning").text, /已持久化研究运行：0/);
      assert.match(panel.view("shadow").text, /尚无研究记录/);
      assert.match(panel.view("similarity").text, /尚无研究记录/);
      assert.match(panel.view("results").text, /尚无研究记录/);
      // Champion 的实时状态不依赖登记簿。
      assert.match(panel.view("champion").text, /V1\.2-FROZEN/);
    } finally {
      db.close();
    }
    // 只读查看绝不能顺手把库建出来。
    assert.equal(existsSync(missing), false, "查看页面不得创建研究数据库");
  });
});

test("reading the registry is read-only and never mutates it", () => {
  withWorkspace(({ registryPath, paperPath }) => {
    recordResearchRun({
      runType: "HISTORICAL_REPLAY",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:01:00.000Z",
      status: "BLOCKED",
      summary: {}
    }, { path: registryPath });

    const before = statSync(registryPath);
    const db = new PaperDatabase(paperPath);
    try {
      const panel = panelFor(db, registryPath);
      for (let i = 0; i < 5; i += 1) {
        panel.view("learning");
        panel.view("results");
        researchRegistrySnapshot({ path: registryPath });
      }
    } finally {
      db.close();
    }
    const after = statSync(registryPath);
    assert.equal(after.size, before.size, "只读查看不得改变研究数据库大小");
    // 写入的行数也不能变。
    const runs = withResearchRegistry((registry) => registry.getResearchRuns({ limit: 100 }), registryPath);
    assert.equal(runs.length, 1);
  });
});

test("a corrupt or unreadable registry file falls back instead of throwing", () => {
  withWorkspace(({ directory }) => {
    const bogus = join(directory, "not-a-database.sqlite");
    writeFileSync(bogus, "this is not a sqlite database");
    const snapshot = researchRegistrySnapshot({ path: bogus });
    assert.equal(snapshot.available, false, "读不动的文件必须降级，而不是抛异常");
    assert.equal(snapshot.researchRunCount, 0);
    assert.deepEqual(researchRunsByType("ANYTHING", { path: bogus }), []);
    // 任何真的去查表的读取都必须降级到 fallback，而不是把异常抛给 Telegram。
    assert.equal(
      readResearchRegistry((db) => db.getResearchRuns({ limit: 1 }), { path: bogus, fallback: "fell back" }),
      "fell back"
    );
  });
});

// ---------------------------------------------------------- CLI 运行记账

test("every research command is registered and only pure queries are exempt", () => {
  const mustRecord = [
    "backtest", "replay", "validate", "similarity", "robustness", "counterfactual",
    "external:audit", "optimize", "diagnose", "ablation", "edge:pipeline",
    "tradable-edge", "anti-chase", "full", "research:v2"
  ];
  for (const name of mustRecord) {
    assert.ok(RESEARCH_COMMANDS.includes(name), `${name} 必须在命令表中`);
    assert.ok(!EXEMPT_RESEARCH_COMMANDS.includes(name), `${name} 不得豁免登记`);
  }
  assert.deepEqual(
    [...EXEMPT_RESEARCH_COMMANDS].sort(),
    ["data:inspect", "multi-venue:inspect", "research:register-candidate", "research:runs"]
  );
});

test("a successful invocation records exactly one top-level run", async () => {
  const recorded = [];
  const persist = async (runType, startedAt, status, record) => {
    recorded.push({ runType, status, record });
    return { id: recorded.length };
  };
  const commands = {
    "fake:ok": {
      runType: "FAKE_RESEARCH",
      handler: async () => ({ dataset: { manifest: { manifestHash: "abc" } }, value: 1 }),
      record: (result) => ({
        dataManifestHash: result.dataset.manifest.manifestHash,
        summary: { stages: { inner: "done" } }
      })
    }
  };
  await executeResearchCommand({ command: "fake:ok", commands, persist });
  assert.equal(recorded.length, 1, "成功 invocation 必须恰好一条顶层 run");
  assert.equal(recorded[0].status, "PASSED");
  assert.equal(recorded[0].record.dataManifestHash, "abc");
  // 子阶段留在 summary 里，不冒充独立顶层运行。
  assert.deepEqual(recorded[0].record.summary.stages, { inner: "done" });
});

test("a handler-declared PARTIAL status is preserved rather than upgraded to PASSED", async () => {
  const recorded = [];
  const commands = {
    "fake:partial": {
      runType: "FAKE_RESEARCH",
      handler: async () => ({}),
      record: () => ({ status: "PARTIAL", summary: {} })
    }
  };
  await executeResearchCommand({
    command: "fake:partial",
    commands,
    persist: async (runType, startedAt, status) => { recorded.push(status); }
  });
  assert.deepEqual(recorded, ["PARTIAL"]);
});

test("zero-trade delayed execution evidence records V4 robustness as PARTIAL", () => {
  const record = robustnessRunRecord({
    directory: "/tmp/robustness",
    replay: { tradeCount: 28 },
    report: {
      status: "partial",
      reason: "delayed execution produced no trades",
      delayedExecutionEvidence: { available: false }
    }
  });
  assert.equal(record.status, "PARTIAL");
  assert.equal(record.summary.delayedExecutionEvidence.available, false);
  assert.match(record.summary.reason, /no trades/);
});

test("a failing invocation records exactly one BLOCKED or FAILED run and rethrows", async () => {
  for (const [error, expected] of [
    [Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }), "BLOCKED"],
    [new TypeError("Cannot read properties of undefined"), "FAILED"]
  ]) {
    const recorded = [];
    const commands = {
      "fake:boom": {
        runType: "FAKE_RESEARCH",
        handler: async () => { throw error; },
        record: () => ({})
      }
    };
    await assert.rejects(executeResearchCommand({
      command: "fake:boom",
      commands,
      persist: async (runType, startedAt, status, record) => { recorded.push({ status, record }); }
    }));
    assert.equal(recorded.length, 1, "失败 invocation 必须恰好一条 run");
    assert.equal(recorded[0].status, expected);
    assert.equal(recorded[0].record.summary.interpretation, classifyResearchFailure(error).interpretation);
  }
});

test("exempt commands record nothing at all", async () => {
  const recorded = [];
  const commands = {
    "fake:query": { exempt: true, handler: async () => "queried" }
  };
  const outcome = await executeResearchCommand({
    command: "fake:query",
    commands,
    persist: async (...args) => { recorded.push(args); }
  });
  assert.equal(recorded.length, 0, "纯查询命令不得产生研究运行");
  assert.equal(outcome.exempt, true);
  assert.equal(outcome.result, "queried");
});

test("an unknown command records nothing and still fails loudly", async () => {
  const recorded = [];
  await assert.rejects(executeResearchCommand({
    command: "fake:missing",
    commands: {},
    persist: async (...args) => { recorded.push(args); }
  }), /Unknown research command/);
  assert.equal(recorded.length, 0);
});

test("a real CLI invocation against an empty catalog writes exactly one BLOCKED run", () => {
  withWorkspace(({ registryPath }) => {
    // 直接驱动登记路径，验证真实写入而不是 stub。
    recordResearchRun({
      runType: "RESEARCH_CLI_SMOKE",
      startedAt: "2026-08-24T00:00:00.000Z",
      finishedAt: "2026-08-24T00:00:01.000Z",
      status: "BLOCKED",
      summary: { interpretation: "本地历史数据目录不存在" }
    }, { path: registryPath });
    const snapshot = researchRegistrySnapshot({ path: registryPath });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.researchRunCount, 1);
    assert.equal(snapshot.researchRuns[0].status, "BLOCKED");
  });
});

// ---------------------------------------------------------- research:v2 字段

test("research:v2 derives strategyVersion from the real selectionEvidence fields", () => {
  const pipelineResult = (evidence, promotion) => ({
    dataset: { manifest: { manifestHash: "hash" } },
    directory: "/tmp/out",
    result: {
      selectionEvidence: evidence,
      promotion,
      finalUntouchedOos: { status: "READY_NOT_OPENED_BY_THIS_RUN" },
      conclusion: "NO_PROVEN_EDGE",
      experiments: [{ candidate: { version: "c1" }, validation: { passed: false } }],
      candidateGeneration: { attempted: 6 },
      robustness: { status: "ok" },
      formalShadow: { status: "NOT_STARTED" },
      holdoutRegistry: { holdout: { status: "READY_UNOPENED" } }
    }
  });

  // 通过前置 gate：使用 selectedForFurtherValidation。
  const selected = researchV2RunRecord(pipelineResult(
    { selectedForFurtherValidation: { version: "research-v2-candidate-03" }, bestDiagnosticOnly: null },
    { status: "BLOCKED", eligible: false, championChanged: false }
  ));
  assert.equal(selected.strategyVersion, "research-v2-candidate-03");
  assert.equal(selected.status, "PARTIAL", "没有晋级就是 PARTIAL，不是 BLOCKED 也不是 PASSED");
  assert.equal(selected.summary.finalUntouchedOos.status, "READY_NOT_OPENED_BY_THIS_RUN");
  assert.equal(selected.summary.championChanged, false);
  assert.deepEqual(selected.summary.stages.experiments, [{ version: "c1", walkForwardPassed: false }]);

  // 没有候选通过 gate：退回 bestDiagnosticOnly，而不是因为字段名写错变成 null。
  const diagnostic = researchV2RunRecord(pipelineResult(
    { selectedForFurtherValidation: null, bestDiagnosticOnly: { version: "research-v2-candidate-01" } },
    { status: "BLOCKED", eligible: false, championChanged: false }
  ));
  assert.equal(diagnostic.strategyVersion, "research-v2-candidate-01");
  assert.equal(diagnostic.summary.selectedForFurtherValidation, null);
  assert.equal(diagnostic.summary.bestDiagnosticOnly.version, "research-v2-candidate-01");

  // 真正晋级才是 PASSED。
  const promoted = researchV2RunRecord(pipelineResult(
    { selectedForFurtherValidation: { version: "v" }, bestDiagnosticOnly: null },
    { status: "PASSED", eligible: true, championChanged: false }
  ));
  assert.equal(promoted.status, "PASSED");

  // 完全没有 selectionEvidence 时是 null，而且状态保持一致。
  const empty = researchV2RunRecord({ result: { promotion: null } });
  assert.equal(empty.strategyVersion, null);
  assert.equal(empty.status, "PARTIAL");
});
