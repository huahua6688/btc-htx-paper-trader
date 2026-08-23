import { RUNTIME_SETTING_LIMITS, RUNTIME_SETTINGS_DEFAULTS } from "./config.mjs";

export const RISK_PROFILES = Object.freeze(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]);
export const CONTROL_MODES = Object.freeze(["AUTO", "MANUAL"]);

export const RANGE_DEFINITIONS = Object.freeze({
  risk: Object.freeze({ mode: "riskMode", minimum: "riskMinPct", maximum: "riskMaxPct", manual: "riskManualPct", effective: "riskPerTradePct" }),
  margin: Object.freeze({ mode: "marginMode", minimum: "marginMinUsagePct", maximum: "marginMaxUsagePct", manual: "marginManualUsagePct", effective: "maxMarginUsagePct" }),
  leverage: Object.freeze({ mode: "leverageMode", minimum: "leverageMin", maximum: "leverageMax", manual: "leverageManual", effective: "userMaxLeverage" }),
  notional: Object.freeze({ mode: "notionalMode", minimum: "notionalMinMultiple", maximum: "notionalMaxMultiple", manual: "notionalManualMultiple", effective: "maxTotalNotionalMultiple" }),
  positions: Object.freeze({ mode: "positionLimitMode", minimum: "positionLimitMin", maximum: "positionLimitMax", manual: "positionLimitManual", effective: "maxOpenPositions", integer: true }),
  totalRisk: Object.freeze({ mode: "totalRiskMode", minimum: "totalRiskMinPct", maximum: "totalRiskMaxPct", manual: "totalRiskManualPct", effective: "maxTotalRiskPct" }),
  dailyLoss: Object.freeze({ mode: "dailyLossMode", minimum: "dailyLossMinPct", maximum: "dailyLossMaxPct", manual: "dailyLossManualPct", effective: "maxDailyLossPct" }),
  lossStreak: Object.freeze({ mode: "lossStreakMode", minimum: "lossStreakMin", maximum: "lossStreakMax", manual: "lossStreakManual", effective: "maxConsecutiveLosses", integer: true })
});

export const RUNTIME_SETTING_KEYS = Object.freeze([
  "riskProfile",
  ...Object.values(RANGE_DEFINITIONS).flatMap((definition) => [
    definition.mode, definition.minimum, definition.maximum, definition.manual, definition.effective
  ]),
  "allowPyramiding",
  "newEntriesPaused"
]);

const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function validateRange(key, rawValue) {
  if (!finite(rawValue)) throw new Error(`${key} 必须是数字`);
  const value = Number(rawValue);
  const [minimum, maximum] = RUNTIME_SETTING_LIMITS[key];
  if (value < minimum || value > maximum) throw new Error(`${key} 必须在 ${minimum} 到 ${maximum} 之间`);
  if (["positionLimitMin", "positionLimitMax", "positionLimitManual", "maxOpenPositions",
    "lossStreakMin", "lossStreakMax", "lossStreakManual", "maxConsecutiveLosses"].includes(key)
    && !Number.isInteger(value)) throw new Error(`${key} 必须是整数`);
  return value;
}

function autoFraction(profile) {
  if (profile === "CONSERVATIVE") return 0.25;
  if (profile === "AGGRESSIVE") return 0.75;
  return 0.5;
}

function autoValue(definition, settings) {
  const minimum = Number(settings[definition.minimum]);
  const maximum = Number(settings[definition.maximum]);
  if ([RANGE_DEFINITIONS.risk, RANGE_DEFINITIONS.margin, RANGE_DEFINITIONS.leverage, RANGE_DEFINITIONS.notional].includes(definition)) {
    return maximum;
  }
  const value = minimum + (maximum - minimum) * autoFraction(settings.riskProfile);
  return definition.integer ? Math.round(value) : Number(value.toFixed(12));
}

export function materializeRuntimeSettings(settings) {
  const output = { ...settings };
  for (const definition of Object.values(RANGE_DEFINITIONS)) {
    const selected = output[definition.mode] === "MANUAL"
      ? Number(output[definition.manual])
      : autoValue(definition, output);
    output[definition.effective] = definition.integer ? Math.round(selected) : selected;
  }
  if (!output.allowPyramiding) output.maxOpenPositions = 1;
  return output;
}

export function expandLegacyRuntimePatch(patch) {
  const output = { ...patch };
  for (const definition of Object.values(RANGE_DEFINITIONS)) {
    if (Object.hasOwn(patch, definition.effective)
      && !Object.hasOwn(patch, definition.mode)
      && !Object.hasOwn(patch, definition.manual)) {
      output[definition.mode] = "MANUAL";
      output[definition.manual] = patch[definition.effective];
    }
  }
  return output;
}

export function validateRuntimePatch(patch) {
  const output = {};
  for (const [key, rawValue] of Object.entries(patch)) {
    if (!RUNTIME_SETTING_KEYS.includes(key)) throw new Error(`不支持的运行时参数：${key}`);
    if (key === "riskProfile") {
      const value = String(rawValue).toUpperCase();
      if (!RISK_PROFILES.includes(value)) throw new Error(`风险偏好必须是 ${RISK_PROFILES.join("/")}`);
      output[key] = value;
    } else if (Object.values(RANGE_DEFINITIONS).some((definition) => definition.mode === key)) {
      const value = String(rawValue).toUpperCase();
      if (!CONTROL_MODES.includes(value)) throw new Error(`${key} 必须是 AUTO/MANUAL`);
      output[key] = value;
    } else if (["allowPyramiding", "newEntriesPaused"].includes(key)) {
      if (typeof rawValue !== "boolean") throw new Error(`${key} 必须是 true/false`);
      output[key] = rawValue;
    } else {
      output[key] = validateRange(key, rawValue);
    }
  }
  const combined = { ...RUNTIME_SETTINGS_DEFAULTS, ...output };
  for (const [name, definition] of Object.entries(RANGE_DEFINITIONS)) {
    const minimum = Number(combined[definition.minimum]);
    const maximum = Number(combined[definition.maximum]);
    const manual = Number(combined[definition.manual]);
    if (minimum > maximum) throw new Error(`${name} 的最低值不能高于最高值`);
    if (manual < minimum || manual > maximum) throw new Error(`${name} 的手动值必须处于最低值和最高值之间`);
  }
  const resolved = materializeRuntimeSettings(combined);
  if (resolved.riskPerTradePct > resolved.maxTotalRiskPct) throw new Error("单笔风险不能高于当前总风险限制");
  return output;
}

export function validateCompleteRuntimeSettings(settings) {
  const selected = Object.fromEntries(RUNTIME_SETTING_KEYS.map((key) => [key, settings[key]]));
  const normalized = validateRuntimePatch(selected);
  return materializeRuntimeSettings({ ...RUNTIME_SETTINGS_DEFAULTS, ...normalized });
}

export function selectRiskPct(settings, { opportunityScore = 50, volatilityPct = 0.02, marketRiskFactor = 1 } = {}) {
  if (settings.riskMode === "MANUAL") return Number(settings.riskManualPct);
  const quality = clamp((Number(opportunityScore) - 60) / 40, 0, 1);
  const volatilityControl = clamp(0.025 / Math.max(Number(volatilityPct), 0.005), 0.35, 1);
  const selected = Number(settings.riskMinPct)
    + (Number(settings.riskMaxPct) - Number(settings.riskMinPct)) * quality * volatilityControl * riskProfileFactor(settings.riskProfile);
  return clamp(selected * Number(marketRiskFactor), Number(settings.riskMinPct), Number(settings.riskMaxPct));
}

export function riskProfileFactor(profile) {
  if (profile === "CONSERVATIVE") return 0.7;
  if (profile === "AGGRESSIVE") return 1;
  return 0.85;
}

export function riskProfileChinese(profile) {
  if (profile === "CONSERVATIVE") return "保守";
  if (profile === "AGGRESSIVE") return "积极";
  return "均衡";
}

export function controlModeChinese(mode) {
  return mode === "MANUAL" ? "手动" : "自动";
}
