import { RUNTIME_SETTING_LIMITS, RUNTIME_SETTINGS_DEFAULTS } from "./config.mjs";

export const RISK_PROFILES = Object.freeze(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]);

export const RUNTIME_SETTING_KEYS = Object.freeze([
  "riskProfile",
  "riskPerTradePct",
  "maxMarginUsagePct",
  "userMaxLeverage",
  "maxTotalNotionalMultiple",
  "allowPyramiding",
  "maxOpenPositions",
  "maxTotalRiskPct",
  "maxDailyLossPct",
  "maxConsecutiveLosses",
  "newEntriesPaused"
]);

const finite = (value) => Number.isFinite(Number(value));

function validateRange(key, rawValue) {
  if (!finite(rawValue)) throw new Error(`${key} 必须是数字`);
  const value = Number(rawValue);
  const [minimum, maximum] = RUNTIME_SETTING_LIMITS[key];
  if (value < minimum || value > maximum) {
    throw new Error(`${key} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  if (["maxOpenPositions", "maxConsecutiveLosses"].includes(key) && !Number.isInteger(value)) {
    throw new Error(`${key} 必须是整数`);
  }
  return value;
}

export function validateRuntimePatch(patch) {
  const output = {};
  for (const [key, rawValue] of Object.entries(patch)) {
    if (!RUNTIME_SETTING_KEYS.includes(key)) throw new Error(`不支持的运行时参数：${key}`);
    if (key === "riskProfile") {
      const value = String(rawValue).toUpperCase();
      if (!RISK_PROFILES.includes(value)) throw new Error(`风险偏好必须是 ${RISK_PROFILES.join("/")}`);
      output[key] = value;
    } else if (["allowPyramiding", "newEntriesPaused"].includes(key)) {
      if (typeof rawValue !== "boolean") throw new Error(`${key} 必须是 true/false`);
      output[key] = rawValue;
    } else {
      output[key] = validateRange(key, rawValue);
    }
  }
  const combined = { ...RUNTIME_SETTINGS_DEFAULTS, ...output };
  if (combined.riskPerTradePct > combined.maxTotalRiskPct) {
    throw new Error("单笔风险不能高于总风险上限");
  }
  if (!combined.allowPyramiding && combined.maxOpenPositions !== 1 && "maxOpenPositions" in output) {
    throw new Error("启用加仓后才能把最大同时仓位数设为 2 以上");
  }
  return output;
}

export function validateCompleteRuntimeSettings(settings) {
  const normalized = validateRuntimePatch(settings);
  return { ...RUNTIME_SETTINGS_DEFAULTS, ...normalized };
}

export function riskProfileFactor(profile) {
  if (profile === "CONSERVATIVE") return 0.75;
  if (profile === "AGGRESSIVE") return 1;
  return 0.9;
}

export function riskProfileChinese(profile) {
  if (profile === "CONSERVATIVE") return "保守";
  if (profile === "AGGRESSIVE") return "积极";
  return "均衡";
}
