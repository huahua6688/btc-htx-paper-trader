import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const HTX_RAW_PAYLOAD = Symbol.for("btc-htx-paper.htxRawPayload");

export function resolveCliPath({ platform = process.platform, arch = process.arch } = {}) {
  if (arch !== "x64") throw new Error(`Unsupported HTX CLI architecture: ${platform}/${arch}`);
  if (platform === "win32") return fileURLToPath(new URL("../vendor/htx-cli-windows-x64.exe", import.meta.url));
  if (platform === "linux") return fileURLToPath(new URL("../vendor/htx-cli-linux-x64", import.meta.url));
  throw new Error(`Unsupported HTX CLI platform: ${platform}/${arch}`);
}

const RULES = Object.freeze({
  "futures-market": Object.freeze({
    "detail-merged": ["contract_code"],
    "kline": ["contract_code", "period", "size"],
    "depth": ["contract_code", "type"],
    "query-elements": ["contract_code"]
  }),
  "funding-rate": Object.freeze({
    "current": ["contract_code"],
    "history": ["contract_code", "page_index", "page_size"]
  }),
  "oi-tracker": Object.freeze({
    "current": ["contract_code"],
    "history": ["contract_code", "period", "size"]
  }),
  "elite-positioning": Object.freeze({
    "account-ratio": ["contract_code", "period"],
    "position-ratio": ["contract_code", "period"]
  }),
  "liquidation-stream": Object.freeze({
    "recent": ["contract"]
  }),
  "mark-price": Object.freeze({
    "mark-price-kline": ["contract_code", "period", "size"],
    "premium-kline": ["contract_code", "period", "size"],
    "basis": ["contract_code", "period", "basis_price_type", "size"]
  })
});

const VALID_PERIODS = new Set(["15min", "60min", "4hour", "1day"]);
const SECRET_NAMES = [
  "HTX_API_KEY",
  "HTX_SECRET_KEY",
  "HUOBI_API_KEY",
  "HUOBI_SECRET_KEY",
  "ACCESS_KEY",
  "SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ADMIN_USER_ID"
];

export function scrubEnvironment(source = process.env) {
  const clean = { ...source };
  for (const name of SECRET_NAMES) delete clean[name];
  return clean;
}

export function assertAllowedCommand(skill, subcommand, params = {}) {
  const skillRules = RULES[skill];
  if (!skillRules || !skillRules[subcommand]) {
    throw new Error(`Blocked non-public HTX command: ${skill}/${subcommand}`);
  }

  const allowedParams = new Set(skillRules[subcommand]);
  for (const [key, rawValue] of Object.entries(params)) {
    if (!allowedParams.has(key)) throw new Error(`Blocked HTX parameter: ${key}`);
    const value = String(rawValue);
    if (value.length === 0 || /key|secret|sign|auth|order|lever/i.test(key)) {
      throw new Error(`Blocked unsafe HTX parameter: ${key}`);
    }
    if ((key === "contract_code" || key === "contract") && value !== "BTC-USDT") {
      throw new Error(`V0 only permits BTC-USDT, received: ${value}`);
    }
    if (key === "period" && !VALID_PERIODS.has(value)) {
      throw new Error(`Blocked unsupported period: ${value}`);
    }
    if (key === "size" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 300)) {
      throw new Error(`Blocked unsafe size: ${value}`);
    }
    if (key === "page_size" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 50)) {
      throw new Error(`Blocked unsafe page_size: ${value}`);
    }
    if (key === "page_index" && Number(value) !== 1) throw new Error("V0 only reads the first public page");
    if (key === "type" && value !== "step0") throw new Error(`Blocked depth aggregation: ${value}`);
    if (key === "basis_price_type" && value !== "close") throw new Error(`Blocked basis type: ${value}`);
  }
  return true;
}

function assertSuccessfulPayload(payload, skill, subcommand) {
  if (payload?.status && payload.status !== "ok") {
    throw new Error(`${skill}/${subcommand} returned status=${payload.status}`);
  }
  if (payload?.code !== undefined && Number(payload.code) !== 200) {
    throw new Error(`${skill}/${subcommand} returned code=${payload.code}: ${payload.msg ?? "unknown error"}`);
  }
  return payload;
}

// Keep the public integration boundary byte-shape compatible with the frozen
// V1.2 accessors in analysis-engine.mjs. Only OI-current is consumed as
// data[0]; OI-history and both elite ratios are consumed as object data.
// Raw archive storage still preserves the exact CLI payload received.
export function normalizePublicCommandPayload(skill, subcommand, payload) {
  let normalized = payload;
  if (skill === "oi-tracker" && subcommand === "current"
    && payload?.data && !Array.isArray(payload.data)) {
    normalized = { ...payload, data: [payload.data] };
  }
  if (skill === "oi-tracker" && subcommand === "history" && Array.isArray(payload?.data)) {
    normalized = { ...payload, data: payload.data[0] ?? null };
  }
  if (skill === "elite-positioning" && ["account-ratio", "position-ratio"].includes(subcommand)
    && Array.isArray(payload?.data)) {
    normalized = { ...payload, data: payload.data[0] ?? null };
  }
  if (normalized !== payload) Object.defineProperty(normalized, HTX_RAW_PAYLOAD, { value: payload, enumerable: false });
  return normalized;
}

export async function runPublicCommandWithBinary(cliPath, skill, subcommand, params = {}, {
  execFileImpl = execFileAsync,
  timeoutMs = 20_000
} = {}) {
  assertAllowedCommand(skill, subcommand, params);
  const args = [skill, subcommand];
  for (const [key, value] of Object.entries(params)) args.push("-p", `${key}=${value}`);

  const { stdout, stderr } = await execFileImpl(cliPath, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
    env: scrubEnvironment()
  });
  if (stderr?.trim()) throw new Error(`${skill}/${subcommand}: ${stderr.trim()}`);

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`${skill}/${subcommand} returned invalid JSON`);
  }
  return normalizePublicCommandPayload(skill, subcommand, assertSuccessfulPayload(payload, skill, subcommand));
}

export async function runPublicCommand(skill, subcommand, params = {}) {
  return runPublicCommandWithBinary(resolveCliPath(), skill, subcommand, params);
}

export const publicCommandRules = RULES;
