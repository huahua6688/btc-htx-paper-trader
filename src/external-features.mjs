import { join } from "node:path";
import { hashObject, round, sha256, writeJsonAtomic } from "./research-utils.mjs";

const SPOT_HOST = "https://api.huobi.pro";
const SPOT_KLINE_PATH = "/market/history/kline";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekStartUtcMonday(timestamp) {
  const date = new Date(timestamp);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
}

async function fetchSpotDaily(fetchImpl = fetch) {
  const url = new URL(SPOT_KLINE_PATH, SPOT_HOST);
  url.search = new URLSearchParams({ symbol: "btcusdt", period: "1day", size: "2000" });
  if (url.origin !== SPOT_HOST || url.pathname !== SPOT_KLINE_PATH) throw new Error("Blocked external data URL");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "btc-htx-paper-research/1.0" },
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`HTX spot daily HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.status !== "ok") throw new Error(`HTX spot daily status=${payload?.status ?? "unknown"}`);
  return (payload.data ?? []).map((row) => ({
    timestamp: Number(row.id) * 1000,
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volumeBtc: Number(row.amount ?? 0)
  })).filter((row) => [row.timestamp, row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function calculate200Week(candles, now = Date.now()) {
  const weeks = new Map();
  for (const candle of candles) {
    const start = weekStartUtcMonday(candle.timestamp);
    if (start + WEEK_MS > now) continue;
    const existing = weeks.get(start);
    if (!existing || candle.timestamp > existing.timestamp) weeks.set(start, candle);
  }
  const rows = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([timestamp, candle]) => ({ timestamp, close: candle.close }));
  if (rows.length < 200) return { status: "insufficient evidence", completedWeeks: rows.length, requiredWeeks: 200 };
  const window = rows.slice(-200);
  const value = window.reduce((sum, row) => sum + row.close, 0) / window.length;
  const current = candles.at(-1).close;
  return {
    status: "research-only",
    formulaVersion: "HTX_SPOT_WEEKLY_CLOSE_UTC_MONDAY_SMA200_V1",
    definition: "Arithmetic mean of the latest 200 fully completed UTC-Monday weekly BTC/USDT spot closes derived from HTX public daily candles.",
    completedWeeks: rows.length,
    windowStart: new Date(window[0].timestamp).toISOString(),
    windowEnd: new Date(window.at(-1).timestamp + WEEK_MS).toISOString(),
    valueUsdt: round(value, 2),
    currentSpotCloseUsdt: round(current, 2),
    distancePct: round((current / value - 1) * 100, 4),
    productionWeight: 0,
    allowedEffectIfValidated: "LONG_TERM risk multiplier only",
    intradayTriggerAllowed: false
  };
}

export async function auditExternalMarketFeatures({ directory, fetchImpl = fetch } = {}) {
  if (!directory) throw new Error("External feature audit requires an output directory");
  let spotCandles = [];
  let spotError = null;
  try { spotCandles = await fetchSpotDaily(fetchImpl); } catch (error) { spotError = error.message; }
  if (spotCandles.length) await writeJsonAtomic(join(directory, "htx-spot-btcusdt-1d.json"), spotCandles);
  const gaps = [];
  for (let index = 1; index < spotCandles.length; index += 1) {
    const days = Math.round((spotCandles[index].timestamp - spotCandles[index - 1].timestamp) / (24 * 60 * 60 * 1000));
    if (days > 1) gaps.push({ after: new Date(spotCandles[index - 1].timestamp).toISOString(), missingDays: days - 1 });
  }
  const serialized = spotCandles.length ? `${JSON.stringify(spotCandles, null, 2)}\n` : "";
  const twoHundredWeek = spotCandles.length ? calculate200Week(spotCandles) : { status: "unavailable", reason: spotError };
  const registry = [
    {
      key: "btc_200_week_ma", layer: "LONG_TERM", status: twoHundredWeek.status === "research-only" ? "research-only" : "unavailable",
      source: `${SPOT_HOST}${SPOT_KLINE_PATH}`, sourceType: "HTX public BTC/USDT spot daily candles", updatedAt: new Date().toISOString(),
      historicalCoverageStart: spotCandles.length ? new Date(spotCandles[0].timestamp).toISOString() : null,
      historicalCoverageEnd: spotCandles.length ? new Date(spotCandles.at(-1).timestamp).toISOString() : null,
      observations: spotCandles.length, missingRate: spotCandles.length ? round(gaps.reduce((sum, item) => sum + item.missingDays, 0) / (spotCandles.length + gaps.reduce((sum, item) => sum + item.missingDays, 0)), 8) : null,
      dataQuality: spotCandles.length >= 1400 && !gaps.length ? "VALID" : spotCandles.length >= 1400 ? "DEGRADED" : "INSUFFICIENT_HISTORY",
      value: twoHundredWeek, productionWeight: 0, reason: "Real data and a fixed formula are implemented, but incremental OOS benefit is not yet proven."
    },
    {
      key: "btc_rainbow_valuation", layer: "LONG_TERM", status: "unavailable", source: null, updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "UNAVAILABLE",
      productionWeight: 0, reason: "A defensible Rainbow model needs a fixed formula/version and BTC history back to the early network era; the selected HTX source does not provide that coverage. No webpage color was scraped."
    },
    {
      key: "btc_realized_price_mvrv", layer: "LONG_TERM", status: "unavailable", source: null, updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "UNAVAILABLE",
      productionWeight: 0, reason: "No credential-free, reproducible, point-in-time on-chain history with acceptable coverage was selected; current values are not backfilled."
    },
    {
      key: "btc_onchain_context", layer: "MEDIUM_TERM", status: "unavailable", source: null, updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "UNAVAILABLE",
      productionWeight: 0, reason: "Provider/version/revision semantics remain unresolved."
    },
    {
      key: "btc_options_context", layer: "MEDIUM_TERM", status: "research-only", source: "DERIBIT_PUBLIC_CURRENT_ONLY_NOT_CATALOGED", updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "INSUFFICIENT_HISTORY",
      productionWeight: 0, reason: "Public current option data exists, but a timestamp-complete historical volatility/skew/term-structure catalog has not been built."
    },
    {
      key: "cross_exchange_derivatives", layer: "SHORT_TERM", status: "research-only", source: "HTX_FUNDING_ONLY_IN_CURRENT_CATALOG", updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "INCOMPLETE_CROSS_EXCHANGE_COVERAGE",
      productionWeight: 0, reason: "HTX historical Funding is real, but cross-exchange Funding/OI/Basis is not yet synchronized and therefore cannot enter scoring."
    },
    {
      key: "cross_market_liquidity", layer: "MEDIUM_TERM", status: "unavailable", source: null, updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "UNAVAILABLE",
      productionWeight: 0, reason: "No point-in-time historical liquidity catalog with stable instrument mappings is available in this build."
    },
    {
      key: "macro_market_context", layer: "LONG_TERM", status: "unavailable", source: null, updatedAt: new Date().toISOString(),
      historicalCoverageStart: null, historicalCoverageEnd: null, observations: 0, missingRate: 1, dataQuality: "UNAVAILABLE",
      productionWeight: 0, reason: "Macro series require release-time and vintage/revision alignment; final revised values are forbidden as historical inputs."
    }
  ];
  const result = {
    runType: "EXTERNAL_FEATURE_SOURCE_AND_QUALITY_AUDIT",
    generatedAt: new Date().toISOString(),
    sourceManifest: {
      source: `${SPOT_HOST}${SPOT_KLINE_PATH}`, authentication: "none", writeOperations: false,
      observations: spotCandles.length, sha256: spotCandles.length ? sha256(serialized) : null,
      coverageStart: spotCandles.length ? new Date(spotCandles[0].timestamp).toISOString() : null,
      coverageEnd: spotCandles.length ? new Date(spotCandles.at(-1).timestamp).toISOString() : null,
      gaps, error: spotError
    },
    features: registry
  };
  result.auditHash = hashObject(result);
  await writeJsonAtomic(join(directory, "external-feature-audit.json"), result);
  return result;
}
