import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PAPER_CONFIG } from "../src/config.mjs";
import { PaperDatabase } from "../src/db.mjs";
import { REPLAY_STRATEGIES, runHistoricalReplay } from "../src/replay-engine.mjs";
import {
  analyzeDataTiered,
  applyTieredDataPolicy,
  DATA_TIERED_PARAMETERS
} from "../src/data-tiered-strategy.mjs";
import { classifyDataQuality, DATA_POLICIES, PROVENANCE } from "../src/data-quality.mjs";
import { analyzeSnapshot } from "../src/analysis-engine.mjs";
import { classifyResearchFailure, strategyOption } from "../src/research-cli.mjs";

function withTempDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), "btc-paper-v13-"));
  const db = new PaperDatabase(join(directory, "research.sqlite"));
  try {
    return work(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// 仅用于验证接线的确定性构造，不代表任何真实行情，也不产生任何研究结论。
function candles(count, price, startSecond = Math.floor(Date.UTC(2026, 0, 1) / 1000)) {
  return Array.from({ length: count }, (_, index) => ({
    id: startSecond + index * 900,
    open: price,
    high: price * 1.003,
    low: price * 0.997,
    close: price,
    vol: 100,
    amount: 1,
    trade_turnover: price,
    count: 10
  }));
}

function plumbingMarket() {
  return {
    ticker: { ts: Date.UTC(2026, 0, 3), tick: { close: 100_000, ts: Date.UTC(2026, 0, 3) } },
    kline15m: { data: candles(220, 100_000) },
    kline1h: { data: candles(220, 100_000) },
    kline4h: { data: candles(220, 100_000) },
    kline1d: { data: candles(220, 100_000) }
  };
}

// ------------------------------------------------- 3. V1.3 真正接入 Replay

test("data-tiered is a first-class replay strategy id", () => {
  assert.ok(REPLAY_STRATEGIES.includes("data-tiered"));
  // Champion 与既有候选都还在，没有被替换掉。
  for (const known of ["champion", "challenger", "historical-compatible", "tradable-edge", "anti-chase", "research-v2"]) {
    assert.ok(REPLAY_STRATEGIES.includes(known), `${known} 不应从回放策略里消失`);
  }
});

test("runHistoricalReplay accepts data-tiered instead of rejecting it as unknown", async () => {
  const bogus = runHistoricalReplay({ manifest: { requestedCoverage: {} }, candles: [], funding: [] }, {
    strategy: "not-a-strategy"
  });
  await assert.rejects(bogus, /Unknown replay strategy/);

  // data-tiered 必须通过策略校验，之后才因为空数据集失败 —— 说明它已经在回放路径上。
  const accepted = runHistoricalReplay({ manifest: { requestedCoverage: {} }, candles: [], funding: [] }, {
    strategy: "data-tiered"
  });
  await assert.rejects(accepted, (error) => {
    assert.doesNotMatch(error.message, /Unknown replay strategy/);
    return true;
  });
});

test("replay and live share one V1.3 implementation, not two copies of the behaviour", () => {
  const market = plumbingMarket();
  // 回放侧入口
  const viaStrategy = analyzeDataTiered(market, DATA_TIERED_PARAMETERS, PAPER_CONFIG);
  // 实时 monitor 侧的组合方式
  const base = analyzeSnapshot(market, PAPER_CONFIG);
  const quality = classifyDataQuality(base, market, {
    policy: DATA_POLICIES.TIERED_DEGRADED,
    degradationBudget: DATA_TIERED_PARAMETERS.degradationBudget
  });
  const viaPolicy = applyTieredDataPolicy(base, market, quality, DATA_TIERED_PARAMETERS, PAPER_CONFIG);

  assert.equal(viaStrategy.decision, viaPolicy.decision);
  assert.deepEqual(viaStrategy.plan, viaPolicy.plan);
  assert.deepEqual(viaStrategy.dataPolicy.missingByTier, viaPolicy.dataPolicy.missingByTier);
  assert.equal(viaStrategy.dataPolicy.riskMultiplier, viaPolicy.dataPolicy.riskMultiplier);
  assert.equal(viaStrategy.dataPolicy.status, viaPolicy.dataPolicy.status);
  assert.equal(viaStrategy.strategy.version, DATA_TIERED_PARAMETERS.version);
});

test("the tiered candidate never claims to be the Champion", () => {
  const report = analyzeDataTiered(plumbingMarket(), DATA_TIERED_PARAMETERS, PAPER_CONFIG);
  assert.equal(report.strategy.role, "CANDIDATE");
  assert.equal(report.strategy.frozenChampionUnchanged, true);
  assert.equal(report.dataPolicy.baseStrategy, "V1.2-FROZEN");
  assert.equal(report.dataPolicy.unavailableNeverSynthesized, true);
  // 冻结 Champion 原本的判断必须被保留下来供对照。
  assert.ok(["LONG", "SHORT", "WAIT"].includes(report.dataPolicy.championDecisionUnchanged));
});

test("point-in-time replay data is labelled historically unavailable, not as a live failure", () => {
  const base = analyzeSnapshot(plumbingMarket(), PAPER_CONFIG);
  // 回放里 report.replay 要等策略跑完才填上，因此必须能从行情快照的标记判断来源。
  const market = { ...plumbingMarket(), replay: { pointInTime: true, visibleAt: Date.UTC(2026, 0, 3) } };
  const quality = classifyDataQuality(base, market, { policy: DATA_POLICIES.TIERED_DEGRADED });
  assert.ok(quality.missing.length > 0, "本用例需要至少一项缺失");
  assert.deepEqual(quality.liveFailureKeys, [], "回放缺失不得被标成实时接口失败");
  assert.equal(quality.missing.every((item) => item.provenance === PROVENANCE.HISTORICAL_UNAVAILABLE), true);
});

// ------------------------------------------------- 4. 研究登记簿

test("missing local artifacts and unreachable endpoints are BLOCKED", () => {
  const cases = [
    Object.assign(new Error("ENOENT: no such file or directory, open '/x/candles-15m.json'"), { code: "ENOENT" }),
    new Error("HTTP 403"),
    new Error("HTTP 503"),
    new Error("fetch failed"),
    Object.assign(new Error("getaddrinfo ENOTFOUND api.hbdm.com"), { code: "ENOTFOUND" }),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
  ];
  for (const error of cases) {
    assert.equal(classifyResearchFailure(error).status, "BLOCKED", `应判为 BLOCKED：${error.message}`);
  }
});

test("code defects, assertion failures and usage errors are FAILED, never hidden as BLOCKED", () => {
  const cases = [
    new TypeError("Cannot read properties of undefined (reading 'close')"),
    Object.assign(new Error("Expected values to be strictly equal"), { name: "AssertionError" }),
    new RangeError("Invalid array length"),
    new Error("Misaligned candle: 1700000000"),
    new Error("Both --from=<ISO> and --to=<ISO> are required."),
    new Error("Position Group contains mixed LONG/SHORT legs")
  ];
  for (const error of cases) {
    const result = classifyResearchFailure(error);
    assert.equal(result.status, "FAILED", `应判为 FAILED：${error.message}`);
    assert.match(result.interpretation, /代码异常/);
  }
});

test("an immature untouched holdout is BLOCKED rather than FAILED", () => {
  assert.equal(classifyResearchFailure(new Error("Final OOS holdout is not mature")).status, "BLOCKED");
});

test("research runs record the real status; PARTIAL is not dressed up and BLOCKED is not overused", () => {
  withTempDatabase((db) => {
    const rows = [
      ["RESEARCH_V2_PIPELINE", "PARTIAL"],
      ["RESEARCH_CLI_BACKTEST", "BLOCKED"],
      ["RESEARCH_CLI_VALIDATE", "FAILED"]
    ];
    for (const [runType, status] of rows) {
      db.recordResearchRun({
        runType,
        startedAt: "2026-08-24T00:00:00.000Z",
        finishedAt: "2026-08-24T00:01:00.000Z",
        status,
        summary: {}
      });
    }
    const persisted = db.getResearchRuns({ limit: 100 });
    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted.map((item) => item.status).sort(), ["BLOCKED", "FAILED", "PARTIAL"]);
  });
});

test("one CLI invocation maps to exactly one top-level run, sub-stages stay in the summary", async () => {
  const { RESEARCH_COMMANDS, EXEMPT_RESEARCH_COMMANDS } = await import("../src/research-cli.mjs");
  // 复核要求覆盖的每一个研究命令都必须在命令表里，并且不是 exempt。
  const mustRecord = [
    "backtest", "replay", "validate", "similarity", "robustness", "counterfactual",
    "external:audit", "optimize", "diagnose", "ablation", "edge:pipeline",
    "tradable-edge", "anti-chase", "full", "research:v2"
  ];
  for (const name of mustRecord) {
    assert.ok(RESEARCH_COMMANDS.includes(name), `${name} 必须在命令表中`);
    assert.ok(!EXEMPT_RESEARCH_COMMANDS.includes(name), `${name} 不得被豁免登记`);
  }
  for (const name of ["data:inspect", "research:runs", "research:register-candidate"]) {
    assert.ok(EXEMPT_RESEARCH_COMMANDS.includes(name), `${name} 应当是豁免的纯查询命令`);
  }

  const read = (await import("node:fs/promises")).readFile;
  // 管线不再自行登记，顶层 run 唯一由 dispatcher 写入。
  const pipeline = await read(new URL("../src/research-v2-pipeline.mjs", import.meta.url), "utf8");
  assert.match(pipeline, /recordPipelineRun = true/, "管线必须提供可关闭的自登记开关");
  assert.match(pipeline, /if \(recordPipelineRun\) \{/, "自登记必须受该开关控制");
  const cli = await read(new URL("../src/research-cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /recordPipelineRun: false/, "CLI 必须关闭管线自登记以避免重复登记");
  // 各处理函数不得再各自登记；登记只发生在 dispatcher 的成功/失败两条路径。
  assert.equal((cli.match(/await persist\(/g) ?? []).length, 2,
    "登记只应在 dispatcher 的成功路径和失败路径各发生一次");
  const handlerRegion = cli.slice(cli.indexOf("async function backtest(args)"), cli.indexOf("export async function executeResearchCommand"));
  assert.doesNotMatch(handlerRegion, /await recordRun\(/,
    "各命令处理函数不得自行登记顶层 run");
});
test("strategyOption only accepts registered replay strategies", () => {
  assert.equal(strategyOption({ strategy: "data-tiered" }, "strategy", "challenger"), "data-tiered");
  assert.equal(strategyOption({}, "strategy", "challenger"), "challenger");
  // 裸 --strategy 没有值时退回默认，而不是变成布尔 true。
  assert.equal(strategyOption({ strategy: true }, "strategy", "challenger"), "challenger");
  assert.throws(() => strategyOption({ strategy: "bogus" }, "strategy", "challenger"), /Unknown replay strategy/);
});

test("a bogus strategy is FAILED while a missing dataset is BLOCKED", async () => {
  // 用法/逻辑错误必须暴露成 FAILED，绝不能被外部前置条件的 BLOCKED 掩盖。
  const usageError = new Error("Unknown replay strategy: bogus. Known: champion, challenger");
  assert.equal(classifyResearchFailure(usageError).status, "FAILED");
  const missingDataset = Object.assign(
    new Error("ENOENT: no such file or directory, open '/x/candles-15m.json'"),
    { code: "ENOENT" }
  );
  assert.equal(classifyResearchFailure(missingDataset).status, "BLOCKED");
});

test("replay and validate expose the V1.3 candidate through the CLI", async () => {
  const { RESEARCH_COMMANDS } = await import("../src/research-cli.mjs");
  assert.ok(RESEARCH_COMMANDS.includes("replay"), "必须有单策略回放入口，V1.3 才能进入研究路径");
  assert.ok(RESEARCH_COMMANDS.includes("validate"));
  const cli = await (await import("node:fs/promises"))
    .readFile(new URL("../src/research-cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /candidateStrategy,/, "validate 必须能把候选策略传给 walk-forward/Purged OOS");
  // 参数校验必须发生在数据集加载之前，否则未知策略会被误判成 BLOCKED。
  const replayBody = cli.slice(cli.indexOf("async function replay(args)"), cli.indexOf("async function validation(args)"));
  assert.ok(
    replayBody.indexOf('strategyOption(args, "strategy"') < replayBody.indexOf("await load(args)"),
    "策略校验必须早于数据集加载"
  );
});

test("research:v2 reads the real selectionEvidence field names", async () => {
  const read = (await import("node:fs/promises")).readFile;
  const source = await read(new URL("../src/research-v2-pipeline.mjs", import.meta.url), "utf8");
  // 管线真实产出的字段。
  assert.match(source, /finalUntouchedOos: finalOos/);
  assert.match(source, /promotion: \{/);
  assert.match(source, /selectedForFurtherValidation: selected/);
  assert.match(source, /bestDiagnosticOnly: !selected/);
  assert.doesNotMatch(source, /promotionGate:/);

  const cli = await read(new URL("../src/research-cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /selectedForFurtherValidation\?\.version/,
    "strategyVersion 必须读真实字段 selectedForFurtherValidation");
  assert.match(cli, /bestDiagnosticOnly\?\.version/,
    "没有候选通过 gate 时必须退回 diagnostic candidate，而不是因为字段名写错变成 null");
  assert.doesNotMatch(cli, /selectionEvidence\?\.selected\?\./,
    "selectionEvidence.selected 这个字段并不存在");
  assert.doesNotMatch(cli, /promotionGate/, "promotionGate 这个字段并不存在，必须移除");
});
