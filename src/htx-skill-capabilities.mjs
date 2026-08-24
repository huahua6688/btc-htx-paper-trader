/**
 * Audited against the public htx-exchange/htx-skills-hub catalog.
 *
 * "Used" does not mean that every skill may influence a trade.  Public market
 * skills may feed the catalog or a derived research feature.  Private account
 * and trading skills are deliberately interface-only while this repository is
 * Paper-only.  Keeping those states separate prevents a capability checklist
 * from silently turning into exchange-write permission.
 */
export const HTX_SKILL_CAPABILITIES = Object.freeze([
  { skill: "spot-market", family: "SPOT", access: "PUBLIC_READ", integration: "RESEARCH_DATA", effect: "spot/perpetual basis and long-horizon reference" },
  { skill: "spot-account", family: "SPOT", access: "PRIVATE_READ", integration: "INTERFACE_ONLY", effect: "disabled until a separately approved live phase" },
  { skill: "spot-trading", family: "SPOT", access: "PRIVATE_WRITE", integration: "INTERFACE_ONLY", effect: "disabled; no exchange writes" },
  { skill: "futures-market", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_RUNTIME_AND_HISTORY", effect: "ticker, Kline, depth and contract metadata" },
  { skill: "funding-rate", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_RUNTIME_AND_HISTORY", effect: "timestamped carry and crowdedness" },
  { skill: "oi-tracker", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_BOUNDED_AND_ARCHIVE", effect: "participation context; never backfilled" },
  { skill: "elite-positioning", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_BOUNDED_AND_ARCHIVE", effect: "positioning context; never backfilled" },
  { skill: "liquidation-stream", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_BOUNDED_AND_ARCHIVE", effect: "stress context; never backfilled" },
  { skill: "mark-price", family: "FUTURES", access: "PUBLIC_READ", integration: "ACTIVE_BOUNDED_AND_ARCHIVE", effect: "mark, premium and basis context" },
  { skill: "settlement", family: "FUTURES", access: "PUBLIC_READ", integration: "RESEARCH_DATA_PARTIAL", effect: "settlement history and venue-risk diagnostics; insurance-fund endpoint may be suspended" },
  { skill: "futures-account", family: "FUTURES", access: "PRIVATE_READ", integration: "INTERFACE_ONLY", effect: "disabled until a separately approved live phase" },
  { skill: "futures-trading", family: "FUTURES", access: "PRIVATE_WRITE", integration: "INTERFACE_ONLY", effect: "disabled; no exchange writes" },
  { skill: "technical-analysis", family: "ANALYSIS", access: "LOCAL_COMPUTE", integration: "ACTIVE_RESEARCH", effect: "deduplicated trend, momentum, volatility and structure" },
  { skill: "derivatives-analyst", family: "ANALYSIS", access: "LOCAL_COMPUTE", integration: "ACTIVE_RESEARCH", effect: "HTX and multi-venue derivatives context" },
  { skill: "sentiment-analyst", family: "ANALYSIS", access: "LOCAL_COMPUTE", integration: "RESEARCH_ONLY", effect: "catalogued; zero production weight until point-in-time OOS evidence exists" },
  { skill: "market-overview", family: "ANALYSIS", access: "LOCAL_COMPUTE", integration: "ACTIVE_RESEARCH", effect: "cross-layer market summary and data quality" },
  { skill: "ta-master", family: "ANALYSIS", access: "LOCAL_COMPUTE", integration: "ACTIVE_RESEARCH", effect: "multi-timeframe profile orchestration" }
]);

export const HTX_SKILL_NAMES = Object.freeze(HTX_SKILL_CAPABILITIES.map((item) => item.skill));

export function htxSkillCapabilityReport() {
  const counts = HTX_SKILL_CAPABILITIES.reduce((output, item) => {
    output[item.integration] = (output[item.integration] ?? 0) + 1;
    return output;
  }, {});
  return {
    auditedCatalog: "htx-exchange/htx-skills-hub",
    auditedSkillCount: HTX_SKILL_CAPABILITIES.length,
    paperOnly: true,
    apiKeyRequiredNow: false,
    exchangeWriteEnabled: false,
    counts,
    capabilities: HTX_SKILL_CAPABILITIES
  };
}
