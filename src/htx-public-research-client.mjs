const DEFAULT_ORIGIN = "https://api.hbdm.vn";

export const HTX_RESEARCH_ENDPOINTS = Object.freeze({
  kline: "/linear-swap-ex/market/history/kline",
  funding: "/linear-swap-api/v1/swap_historical_funding_rate",
  openInterest: "/linear-swap-api/v1/swap_his_open_interest",
  eliteAccount: "/linear-swap-api/v1/swap_elite_account_ratio",
  elitePosition: "/linear-swap-api/v1/swap_elite_position_ratio",
  markPrice: "/index/market/history/linear_swap_mark_price_kline",
  premium: "/index/market/history/linear_swap_premium_index_kline",
  basis: "/index/market/history/linear_swap_basis",
  liquidations: "/linear-swap-api/v3/swap_liquidation_orders",
  depth: "/linear-swap-ex/market/depth",
  settlement: "/linear-swap-api/v1/swap_settlement_records",
  insuranceFund: "/linear-swap-api/v1/swap_insurance_fund"
});

const PERIODS = new Set(["1min", "5min", "15min", "30min", "60min", "4hour", "12hour", "1day", "1week", "1mon"]);
const RULES = Object.freeze({
  [HTX_RESEARCH_ENDPOINTS.kline]: { keys: ["contract_code", "period", "from", "to", "size"], size: 2000 },
  [HTX_RESEARCH_ENDPOINTS.funding]: { keys: ["contract_code", "page_index", "page_size"], pageSize: 50 },
  [HTX_RESEARCH_ENDPOINTS.openInterest]: { keys: ["contract_code", "period", "amount_type", "size"], size: 200 },
  [HTX_RESEARCH_ENDPOINTS.eliteAccount]: { keys: ["contract_code", "period"] },
  [HTX_RESEARCH_ENDPOINTS.elitePosition]: { keys: ["contract_code", "period"] },
  [HTX_RESEARCH_ENDPOINTS.markPrice]: { keys: ["contract_code", "period", "size"], size: 2000 },
  [HTX_RESEARCH_ENDPOINTS.premium]: { keys: ["contract_code", "period", "size"], size: 2000 },
  [HTX_RESEARCH_ENDPOINTS.basis]: { keys: ["contract_code", "period", "basis_price_type", "size"], size: 2000 },
  [HTX_RESEARCH_ENDPOINTS.liquidations]: { keys: ["contract", "pair", "trade_type"] },
  [HTX_RESEARCH_ENDPOINTS.depth]: { keys: ["contract_code", "type"] },
  [HTX_RESEARCH_ENDPOINTS.settlement]: { keys: ["contract_code", "start_time", "end_time", "page_index", "page_size"], pageSize: 50 },
  [HTX_RESEARCH_ENDPOINTS.insuranceFund]: { keys: ["contract_code"] }
});

export function assertAllowedResearchRequest(path, params = {}) {
  const rule = RULES[path];
  if (!rule) throw new Error(`Blocked non-public HTX research endpoint: ${path}`);
  const keys = new Set(rule.keys);
  for (const [key, raw] of Object.entries(params)) {
    if (!keys.has(key)) throw new Error(`Blocked HTX research parameter: ${key}`);
    const value = String(raw);
    if (!value) throw new Error(`Empty HTX research parameter: ${key}`);
    if (key === "contract_code" && value !== "BTC-USDT") throw new Error("Research client only permits BTC-USDT");
    if (key === "contract" && value !== "BTC-USDT") throw new Error("Research client only permits BTC-USDT");
    if (key === "pair" && value !== "BTC-USDT") throw new Error("Research client only permits BTC-USDT");
    if (key === "period" && !PERIODS.has(value)) throw new Error(`Unsupported HTX research period: ${value}`);
    if (key === "size" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > rule.size)) {
      throw new Error(`Unsafe HTX research size: ${value}`);
    }
    if (key === "page_size" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > rule.pageSize)) {
      throw new Error(`Unsafe HTX research page_size: ${value}`);
    }
    if (key === "page_index" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 20_000)) {
      throw new Error(`Unsafe HTX research page_index: ${value}`);
    }
    if (["from", "to"].includes(key) && (!Number.isInteger(Number(value)) || Number(value) <= 0)) {
      throw new Error(`Unsafe HTX research timestamp: ${key}`);
    }
    if (["start_time", "end_time"].includes(key) && (!Number.isInteger(Number(value)) || Number(value) <= 0)) {
      throw new Error(`Unsafe HTX research timestamp: ${key}`);
    }
    if (key === "amount_type" && ![1, 2].includes(Number(value))) throw new Error("Unsupported OI amount_type");
    if (key === "basis_price_type" && !["open", "close"].includes(value)) throw new Error("Unsupported basis_price_type");
    if (key === "trade_type" && ![0, 1, 2, 3, 4].includes(Number(value))) throw new Error("Unsupported liquidation trade_type");
    if (key === "type" && value !== "step0") throw new Error("Research depth only permits step0");
  }
  return true;
}

function retryAfterMs(response, nowMs = Date.now()) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HtxPublicResearchClient {
  constructor({
    origin = process.env.HTX_PUBLIC_RESEARCH_ORIGIN?.trim() || DEFAULT_ORIGIN,
    fetchImpl = globalThis.fetch,
    delay = sleep,
    attempts = 5,
    baseBackoffMs = 500,
    maximumBackoffMs = 15_000
  } = {}) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || !["api.hbdm.vn", "api.hbdm.com"].includes(parsed.hostname)) {
      throw new Error("HTX research origin must be an official public HTTPS host");
    }
    this.origin = parsed.origin;
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    this.attempts = attempts;
    this.baseBackoffMs = baseBackoffMs;
    this.maximumBackoffMs = maximumBackoffMs;
  }

  async get(path, params = {}) {
    assertAllowedResearchRequest(path, params);
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "btc-htx-paper-research/2" },
          signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) {
          const error = new Error(`HTX public research HTTP ${response.status}`);
          error.status = response.status;
          error.retryAfterMs = response.status === 429 ? retryAfterMs(response) : null;
          throw error;
        }
        const payload = await response.json();
        if (payload?.status && payload.status !== "ok") throw new Error(`HTX status=${payload.status}: ${payload.err_msg ?? "unknown"}`);
        if (payload?.code !== undefined && Number(payload.code) !== 200) throw new Error(`HTX code=${payload.code}: ${payload.msg ?? "unknown"}`);
        return { payload, fetchedAt: new Date().toISOString(), url: url.toString() };
      } catch (error) {
        lastError = error;
        if (attempt >= this.attempts) break;
        const exponential = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maximumBackoffMs);
        await this.delay(Math.max(exponential, Number(error.retryAfterMs ?? 0)));
      }
    }
    throw lastError;
  }
}

export async function mapWithSafeConcurrency(items, worker, { concurrency = 3 } = {}) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(6, Number(concurrency) || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export const HTX_PUBLIC_RESEARCH_ORIGIN = DEFAULT_ORIGIN;
