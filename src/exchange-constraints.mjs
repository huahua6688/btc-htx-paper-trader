import { PAPER_EXCHANGE_CONSTRAINTS } from "./config.mjs";

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

export function resolveExchangeConstraints(marketData = {}, paper = PAPER_EXCHANGE_CONSTRAINTS) {
  const rows = marketData.contractElements?.data ?? [];
  const btc = rows.find((item) => item.contract_code === "BTC-USDT") ?? null;
  const publicAdvertisedMax = finite(btc?.max_level) ? Number(btc.max_level) : null;
  const contractSizeBtc = finite(btc?.instrument_value)
    ? Number(btc.instrument_value)
    : finite(btc?.instrument_values?.find((item) => Number(item.business_type) === 1)?.price)
      ? Number(btc.instrument_values.find((item) => Number(item.business_type) === 1).price)
      : 0.001;
  const hardMaxLeverage = Math.min(
    paper.maxLeverage,
    publicAdvertisedMax ?? paper.maxLeverage
  );
  return {
    contractCode: "BTC-USDT",
    contractSizeBtc,
    publicAdvertisedMaxLeverage: publicAdvertisedMax,
    verifiedPositionTierMaxLeverage: null,
    hardMaxLeverage,
    tierLimitVerified: false,
    maintenanceMarginRate: paper.paperMaintenanceMarginRateEstimate,
    maintenanceMarginRateVerified: false,
    liquidationFormulaVerified: false,
    source: btc
      ? "HTX_PUBLIC_QUERY_ELEMENTS_PLUS_PAPER_TIER_FALLBACK"
      : paper.source,
    note: paper.note
  };
}

export function estimatePaperLiquidation({ side, entry, quantityBtc, marginCny, usdtCnyRate, maintenanceMarginRate }) {
  const quantity = Number(quantityBtc);
  const marginUsdt = Number(marginCny) / Number(usdtCnyRate);
  const mmr = Number(maintenanceMarginRate);
  if (!(quantity > 0) || !(marginUsdt > 0) || !(entry > 0) || !(mmr >= 0 && mmr < 1)) return null;
  const price = side === "LONG"
    ? (quantity * entry - marginUsdt) / (quantity * (1 - mmr))
    : (marginUsdt + quantity * entry) / (quantity * (1 + mmr));
  if (!(price > 0)) return null;
  return {
    price: round(price, 2),
    distancePct: round(Math.abs(price - entry) / entry * 100, 4),
    source: "PAPER_ISOLATED_MARGIN_ESTIMATE_NOT_HTX_LIQUIDATION_PRICE"
  };
}

export function minimumMarginForStopBeforeLiquidation({
  side,
  entry,
  stopLoss,
  quantityBtc,
  usdtCnyRate,
  maintenanceMarginRate,
  safetyBufferPct
}) {
  const quantity = Number(quantityBtc);
  const buffer = Number(entry) * Number(safetyBufferPct);
  const desiredLiquidation = side === "LONG" ? Number(stopLoss) - buffer : Number(stopLoss) + buffer;
  const marginUsdt = side === "LONG"
    ? quantity * entry - desiredLiquidation * quantity * (1 - maintenanceMarginRate)
    : desiredLiquidation * quantity * (1 + maintenanceMarginRate) - quantity * entry;
  return round(Math.max(0, marginUsdt * usdtCnyRate), 6);
}
