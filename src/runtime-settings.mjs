import { RUNTIME_SETTING_LIMITS, RUNTIME_SETTINGS_DEFAULTS } from "./config.mjs";

export const RISK_PROFILES = Object.freeze(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]);
export const CONTROL_MODES = Object.freeze(["AUTO", "MANUAL"]);
export const INDICATOR_PROFILE_KEYS = Object.freeze(["SHORT_SWING", "STANDARD_SWING", "LONG_SWING", "AUTO"]);
export const MONITOR_INTERVAL_CHOICES = Object.freeze([5, 15, 60, 240]);
export const POSITION_MODES = Object.freeze(["NET", "HEDGE"]);

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
  "positionMode",
  "riskProfile",
  ...Object.values(RANGE_DEFINITIONS).flatMap((definition) => [
    definition.mode, definition.minimum, definition.maximum, definition.manual, definition.effective
  ]),
  "allowPyramiding",
  "newEntriesPaused",
  "indicatorProfile",
  "monitorIntervalMinutes",
  "dataPolicyMode"
]);

export const DATA_POLICY_MODES = Object.freeze(["FROZEN_V12_STRICT", "TIERED_DEGRADED"]);

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

// AUTO 的“有效值”只是用户区间的硬天花板，写入 SQLite 并被 openPosition 的原子复核使用。
// 每一轮真正采用的 AUTO 值由 resolveDynamicLimits 在下单时按当时市场与账户状态计算，
// 并且永远不会高于这里的天花板，因此原子复核始终成立。
const CEILING_DEFINITIONS = Object.freeze([
  RANGE_DEFINITIONS.risk,
  RANGE_DEFINITIONS.margin,
  RANGE_DEFINITIONS.leverage,
  RANGE_DEFINITIONS.notional
]);

function autoValue(definition, settings) {
  const minimum = Number(settings[definition.minimum]);
  const maximum = Number(settings[definition.maximum]);
  if (CEILING_DEFINITIONS.includes(definition)) return maximum;
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
  // 加仓开关只控制同方向增加新腿。HEDGE 下即使关闭加仓，也可以在
  // maxOpenPositions 允许时各持有一条 LONG 与 SHORT。
  if (!output.allowPyramiding && output.positionMode === "NET") output.maxOpenPositions = 1;
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
    if (key === "positionMode") {
      const value = String(rawValue).toUpperCase();
      if (!POSITION_MODES.includes(value)) throw new Error(`positionMode 必须是 ${POSITION_MODES.join("/")}`);
      output[key] = value;
    } else if (key === "riskProfile") {
      const value = String(rawValue).toUpperCase();
      if (!RISK_PROFILES.includes(value)) throw new Error(`风险偏好必须是 ${RISK_PROFILES.join("/")}`);
      output[key] = value;
    } else if (key === "indicatorProfile") {
      const value = String(rawValue).toUpperCase();
      if (!INDICATOR_PROFILE_KEYS.includes(value)) throw new Error(`indicatorProfile 必须是 ${INDICATOR_PROFILE_KEYS.join("/")}`);
      output[key] = value;
    } else if (key === "dataPolicyMode") {
      const value = String(rawValue).toUpperCase();
      if (!DATA_POLICY_MODES.includes(value)) throw new Error(`dataPolicyMode 必须是 ${DATA_POLICY_MODES.join("/")}`);
      output[key] = value;
    } else if (key === "monitorIntervalMinutes") {
      const value = Number(rawValue);
      if (!MONITOR_INTERVAL_CHOICES.includes(value)) throw new Error(`monitorIntervalMinutes 必须是 ${MONITOR_INTERVAL_CHOICES.join("/")}`);
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

const DYNAMIC_DEFINITIONS = Object.freeze({
  risk: RANGE_DEFINITIONS.risk,
  margin: RANGE_DEFINITIONS.margin,
  leverage: RANGE_DEFINITIONS.leverage,
  notional: RANGE_DEFINITIONS.notional,
  totalRisk: RANGE_DEFINITIONS.totalRisk
});

export const DYNAMIC_LIMIT_KEYS = Object.freeze(Object.keys(DYNAMIC_DEFINITIONS));

function blend(minimum, maximum, factor) {
  return minimum + (maximum - minimum) * clamp(factor, 0, 1);
}

/**
 * 把账户与市场状态压缩成一组 0~1 的收缩因子。1 表示没有任何理由收紧，
 * 越小表示越应该收紧。每个因子都带一句中文解释，供 Telegram 展示“为什么是这个值”。
 */
export function describeExposureContext(settings, context = {}) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const opportunityScore = number(context.opportunityScore, 60);
  const volatilityPct = Math.max(number(context.volatilityPct, 0.02), 0.0005);
  const stopDistancePct = Math.max(number(context.stopDistancePct, volatilityPct), 0.0005);
  const equityCny = Math.max(number(context.equityCny, 0), 0);
  const marginUsedCny = Math.max(number(context.marginUsedCny, 0), 0);
  const totalRiskCny = Math.max(number(context.totalRiskCny, 0), 0);
  const grossNotionalCny = Math.max(number(context.grossNotionalCny, 0), 0);
  const sameSideNotionalCny = Math.max(number(context.sameSideNotionalCny, 0), 0);
  const drawdownPct = clamp(number(context.drawdownPct, 0), 0, 1);
  const dailyLossPct = clamp(number(context.dailyLossPct, 0), 0, 1);
  const lossStreak = Math.max(Math.trunc(number(context.lossStreak, 0)), 0);
  const positionCount = Math.max(Math.trunc(number(context.positionCount, 0)), 0);
  const maxOpenPositions = Math.max(Math.trunc(number(settings.maxOpenPositions, 1)), 1);
  const marginCeiling = Math.max(number(settings.maxMarginUsagePct, 0.8), 1e-6);
  const totalRiskCeiling = Math.max(number(settings.maxTotalRiskPct, 0.1), 1e-6);
  const dailyLossCeiling = Math.max(number(settings.maxDailyLossPct, 0.1), 1e-6);
  const lossStreakCeiling = Math.max(Math.trunc(number(settings.maxConsecutiveLosses, 3)), 1);

  const marginUsagePct = equityCny > 0 ? marginUsedCny / equityCny : 0;
  const totalRiskPct = equityCny > 0 ? totalRiskCny / equityCny : 0;
  const notionalMultiple = equityCny > 0 ? grossNotionalCny / equityCny : 0;
  const sameSideMultiple = equityCny > 0 ? sameSideNotionalCny / equityCny : 0;

  const factors = {
    quality: {
      value: clamp((opportunityScore - 60) / 30, 0, 1),
      reason: `机会质量 ${round2(opportunityScore)} 分（60→0、90→1）`
    },
    volatility: {
      value: clamp(0.02 / volatilityPct, 0.3, 1),
      reason: `波动 ${round2(volatilityPct * 100)}%（越高越收紧）`
    },
    stopDistance: {
      value: clamp(0.015 / stopDistancePct, 0.3, 1),
      reason: `止损距离 ${round2(stopDistancePct * 100)}%（越宽越收紧）`
    },
    marginHeadroom: {
      value: clamp(1 - marginUsagePct / marginCeiling, 0, 1),
      reason: `已用保证金 ${round2(marginUsagePct * 100)}% / 上限 ${round2(marginCeiling * 100)}%`
    },
    riskHeadroom: {
      value: clamp(1 - totalRiskPct / totalRiskCeiling, 0, 1),
      reason: `已占用总风险 ${round2(totalRiskPct * 100)}% / 上限 ${round2(totalRiskCeiling * 100)}%`
    },
    drawdown: {
      value: clamp(1 - drawdownPct / 0.2, 0.25, 1),
      reason: `账户回撤 ${round2(drawdownPct * 100)}%`
    },
    dailyLoss: {
      value: clamp(1 - dailyLossPct / dailyLossCeiling, 0.25, 1),
      reason: `当日已亏 ${round2(dailyLossPct * 100)}% / 暂停线 ${round2(dailyLossCeiling * 100)}%`
    },
    lossStreak: {
      value: lossStreak > 0 ? clamp(1 - lossStreak / lossStreakCeiling, 0.2, 1) : 1,
      reason: `当日连亏 ${lossStreak} 笔 / 暂停线 ${lossStreakCeiling} 笔`
    },
    crowding: {
      value: positionCount > 0 ? clamp(1 - positionCount / maxOpenPositions * 0.5, 0.4, 1) : 1,
      reason: `已有 ${positionCount} / ${maxOpenPositions} 个仓位`
    },
    sameSide: {
      value: sameSideMultiple > 0 ? clamp(1 - sameSideMultiple / 4, 0.4, 1) : 1,
      reason: `同方向名义敞口 ${round2(sameSideMultiple)}x 权益`
    },
    profile: {
      value: riskProfileFactor(settings.riskProfile),
      reason: `风险偏好 ${riskProfileChinese(settings.riskProfile)}`
    }
  };
  return {
    factors,
    observed: {
      opportunityScore,
      volatilityPct,
      stopDistancePct,
      equityCny,
      marginUsagePct,
      totalRiskPct,
      notionalMultiple,
      sameSideMultiple,
      drawdownPct,
      dailyLossPct,
      lossStreak,
      positionCount
    }
  };
}

function round2(value) {
  return Number(Number(value).toFixed(2));
}

const DYNAMIC_RECIPES = Object.freeze({
  // 单笔风险：机会质量主导，波动/回撤/连亏/拥挤度收紧。
  risk: ["quality", "volatility", "profile", "drawdown", "dailyLoss", "lossStreak", "crowding"],
  // 保证金占用上限：质量与波动主导，账户健康度收紧；不看当前占用以免自我循环。
  margin: ["quality", "volatility", "profile", "drawdown", "dailyLoss", "lossStreak"],
  // 杠杆上限：止损距离与波动主导，越宽的止损越不需要高杠杆。
  leverage: ["quality", "volatility", "stopDistance", "profile", "drawdown", "lossStreak"],
  // 名义仓位上限：质量、波动、同方向敞口与拥挤度共同决定。
  notional: ["quality", "volatility", "profile", "drawdown", "dailyLoss", "lossStreak", "crowding", "sameSide"],
  // 组合总风险上限：账户健康度主导。
  totalRisk: ["profile", "drawdown", "dailyLoss", "lossStreak", "riskHeadroom"]
});

/**
 * 计算本轮真正采用的 AUTO 值。MANUAL 直接使用用户值；AUTO 在 [min, max] 内按
 * 权益、机会质量、波动、止损距离、已有敞口、保证金占用、总风险、回撤、日内亏损、
 * 连亏和仓位数动态插值。返回值永远被夹在用户区间内，且不超过已存储的天花板。
 */
export function resolveDynamicLimits(settings, context = {}) {
  const exposure = describeExposureContext(settings, context);
  const limits = {};
  for (const [name, definition] of Object.entries(DYNAMIC_DEFINITIONS)) {
    const minimum = Number(settings[definition.minimum]);
    const maximum = Number(settings[definition.maximum]);
    const ceiling = Number(settings[definition.effective]);
    const manual = settings[definition.mode] === "MANUAL";
    if (manual) {
      const manualValue = clamp(Number(settings[definition.manual]), minimum, maximum);
      limits[name] = {
        key: definition.effective,
        mode: "MANUAL",
        minimum,
        maximum,
        value: definition.integer ? Math.round(manualValue) : manualValue,
        factor: null,
        reasons: ["手动模式：直接使用用户设定值"]
      };
      continue;
    }
    const used = DYNAMIC_RECIPES[name];
    let factor = 1;
    const reasons = [];
    for (const factorName of used) {
      const item = exposure.factors[factorName];
      factor *= item.value;
      reasons.push(`${item.reason} → ×${round2(item.value)}`);
    }
    const raw = blend(minimum, maximum, factor);
    const bounded = Math.min(clamp(raw, minimum, maximum), Number.isFinite(ceiling) ? ceiling : maximum);
    limits[name] = {
      key: definition.effective,
      mode: "AUTO",
      minimum,
      maximum,
      ceiling: Number.isFinite(ceiling) ? ceiling : maximum,
      value: definition.integer ? Math.round(bounded) : Number(bounded.toFixed(12)),
      factor: Number(factor.toFixed(6)),
      reasons
    };
  }
  return { limits, exposure };
}

/**
 * 把动态限额投影回 runtime settings 的形状，方便直接交给现有的仓位计算函数。
 * 其余字段保持不变，因此 NET/HEDGE、加仓开关和暂停逻辑完全不受影响。
 */
export function applyDynamicLimits(settings, context = {}) {
  const resolved = resolveDynamicLimits(settings, context);
  const applied = { ...settings };
  for (const item of Object.values(resolved.limits)) applied[item.key] = item.value;
  // 单笔风险不得高于当前动态总风险上限。收紧之后必须把 limits 一起改写，
  // 否则 Telegram 显示的「本轮实际值」会和 buildPaperCandidate 真正使用的值不一致。
  if (applied.riskPerTradePct > applied.maxTotalRiskPct) {
    applied.riskPerTradePct = applied.maxTotalRiskPct;
    resolved.limits.risk = {
      ...resolved.limits.risk,
      value: applied.maxTotalRiskPct,
      reasons: [...resolved.limits.risk.reasons, `被当前总风险上限 ${round2(applied.maxTotalRiskPct * 100)}% 压低`]
    };
  }
  return { settings: applied, ...resolved };
}

export function riskProfileChinese(profile) {
  if (profile === "CONSERVATIVE") return "保守";
  if (profile === "AGGRESSIVE") return "积极";
  return "均衡";
}

export function controlModeChinese(mode) {
  return mode === "MANUAL" ? "手动" : "自动";
}
