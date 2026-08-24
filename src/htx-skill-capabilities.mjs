/**
 * Audited against the 17 public skill packages in htx-exchange/htx-skills-hub.
 *
 * Status is wiring evidence, not a marketing capability mapping:
 *   ACTUALLY_INVOKED — repository code invokes the official public surface.
 *   LOCAL_EQUIVALENT — equivalent computation exists locally; official skill code is not invoked.
 *   AUDITED_ONLY     — official package was reviewed but no honest input/wiring exists yet.
 *   RESEARCH_ONLY    — invoked only inside an isolated research workflow.
 *   INTERFACE_ONLY   — disabled future port; no credential or exchange operation is loaded.
 */
export const HTX_SKILL_WIRING_STATUSES = Object.freeze([
  "AUDITED_ONLY", "ACTUALLY_INVOKED", "LOCAL_EQUIVALENT", "RESEARCH_ONLY", "INTERFACE_ONLY"
]);

export const HTX_SKILL_CAPABILITIES = Object.freeze([
  {
    skill: "spot-market", family: "SPOT", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_ARCHIVE",
    commands: ["market-detail-merged", "kline", "depth", "history-trade"],
    evidence: ["src/market-data.mjs: MARKET_TASKS spotTicker/spotKline1h/spotDepth/spotTrades", "src/htx-cli.mjs: fixed btcusdt public allowlist"],
    effect: "observed spot/perpetual premium is research-only and has zero Champion decision weight"
  },
  {
    skill: "spot-account", family: "SPOT", access: "PRIVATE_READ", status: "INTERFACE_ONLY", scope: "DISABLED",
    commands: [], evidence: ["src/exchange-live-interface.mjs: disabled port"], effect: "no credential loaded and no private read"
  },
  {
    skill: "spot-trading", family: "SPOT", access: "PRIVATE_WRITE", status: "INTERFACE_ONLY", scope: "DISABLED",
    commands: [], evidence: ["src/exchange-live-interface.mjs: LIVE_EXCHANGE_WRITE_DISABLED"], effect: "no exchange writes"
  },
  {
    skill: "futures-market", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_HISTORY",
    commands: ["detail-merged", "kline", "depth", "query-elements"], evidence: ["src/market-data.mjs", "src/historical-data.mjs"],
    effect: "ticker, Kline, depth and contract metadata"
  },
  {
    skill: "funding-rate", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_HISTORY",
    commands: ["current", "history"], evidence: ["src/market-data.mjs", "src/historical-data.mjs", "src/htx-download-center.mjs"],
    effect: "timestamped carry; missing history is never forward-filled"
  },
  {
    skill: "oi-tracker", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_SELF_ARCHIVE",
    commands: ["current", "history"], evidence: ["src/market-data.mjs: oiCurrent/oiHistory"],
    effect: "bounded participation context; never copied backwards"
  },
  {
    skill: "elite-positioning", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_SELF_ARCHIVE",
    commands: ["account-ratio", "position-ratio"], evidence: ["src/market-data.mjs: eliteAccount/elitePosition"],
    effect: "bounded positioning context; never copied backwards"
  },
  {
    skill: "liquidation-stream", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_AND_SELF_ARCHIVE",
    commands: ["recent"], evidence: ["src/market-data.mjs: liquidations"], effect: "latest public liquidation stress context"
  },
  {
    skill: "mark-price", family: "FUTURES", access: "PUBLIC_READ", status: "ACTUALLY_INVOKED", scope: "RUNTIME_HISTORY_AND_DOWNLOAD_CENTER",
    commands: ["mark-price-kline", "premium-kline", "basis"], evidence: ["src/market-data.mjs", "src/htx-download-center.mjs"],
    effect: "mark/premium/basis context plus official daily mark archives"
  },
  {
    skill: "settlement", family: "FUTURES", access: "PUBLIC_READ", status: "RESEARCH_ONLY", scope: "RESEARCH_CATALOG",
    commands: ["historical-settlement-records"], evidence: ["src/historical-data.mjs: fetchSettlementRange"],
    effect: "retention-bounded venue-risk diagnostics; explicitly not represented as Historical Data Download"
  },
  {
    skill: "futures-account", family: "FUTURES", access: "PRIVATE_READ", status: "INTERFACE_ONLY", scope: "DISABLED",
    commands: [], evidence: ["src/exchange-live-interface.mjs: disabled port"], effect: "no credential loaded and no private read"
  },
  {
    skill: "futures-trading", family: "FUTURES", access: "PRIVATE_WRITE", status: "INTERFACE_ONLY", scope: "DISABLED",
    commands: [], evidence: ["src/exchange-live-interface.mjs: LIVE_EXCHANGE_WRITE_DISABLED"], effect: "no exchange writes"
  },
  {
    skill: "technical-analysis", family: "ANALYSIS", access: "LOCAL_COMPUTE", status: "LOCAL_EQUIVALENT", scope: "RUNTIME_AND_RESEARCH",
    commands: [], evidence: ["src/indicators.mjs", "src/indicator-profiles.mjs"],
    effect: "local EMA/RSI/MACD/ATR/structure implementation; official skill scripts are not invoked"
  },
  {
    skill: "derivatives-analyst", family: "ANALYSIS", access: "LOCAL_COMPUTE", status: "LOCAL_EQUIVALENT", scope: "RESEARCH",
    commands: [], evidence: ["src/research-challenger-v2.mjs", "src/multi-venue-challenger.mjs"],
    effect: "local derivatives composition; official orchestrator is not invoked"
  },
  {
    skill: "sentiment-analyst", family: "ANALYSIS", access: "LOCAL_COMPUTE", status: "AUDITED_ONLY", scope: "ZERO_WEIGHT",
    commands: [], evidence: ["No timestamped auditable sentiment input is wired"],
    effect: "zero production/research signal weight until point-in-time evidence exists"
  },
  {
    skill: "market-overview", family: "ANALYSIS", access: "LOCAL_COMPUTE", status: "LOCAL_EQUIVALENT", scope: "RUNTIME_DISPLAY",
    commands: [], evidence: ["src/market-context.mjs: attachMultiLayerMarketContext"],
    effect: "local cross-layer summary and data quality; official orchestrator is not invoked"
  },
  {
    skill: "ta-master", family: "ANALYSIS", access: "LOCAL_COMPUTE", status: "LOCAL_EQUIVALENT", scope: "RESEARCH",
    commands: [], evidence: ["src/indicator-profiles.mjs: buildMultiScaleContext"],
    effect: "local multi-timeframe profile orchestration; official skill scripts are not invoked"
  }
]);

export const HTX_SKILL_NAMES = Object.freeze(HTX_SKILL_CAPABILITIES.map((item) => item.skill));

export function htxSkillCapabilityReport() {
  const counts = Object.fromEntries(HTX_SKILL_WIRING_STATUSES.map((status) => [status, 0]));
  for (const item of HTX_SKILL_CAPABILITIES) counts[item.status] += 1;
  return {
    auditedCatalog: "htx-exchange/htx-skills-hub",
    auditedSkillCount: HTX_SKILL_CAPABILITIES.length,
    actuallyInvokedCount: counts.ACTUALLY_INVOKED,
    claim: "17_SKILLS_AUDITED_NOT_17_ACTUALLY_INVOKED",
    paperOnly: true,
    apiKeyRequiredNow: false,
    privateCapabilitiesEnabled: false,
    exchangeWriteEnabled: false,
    counts,
    capabilities: HTX_SKILL_CAPABILITIES
  };
}
