import { BAR_MS, hashObject, round } from "./research-utils.mjs";

export const TRADABLE_EDGE_HORIZONS = Object.freeze({
  "1h": 4,
  "4h": 16,
  "12h": 48,
  "24h": 96,
  "3d": 288
});

const SIDES = Object.freeze(["LONG", "SHORT"]);

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fundingCostPct(funding, from, to, side) {
  const start = lowerBound(funding, from);
  let signedCost = 0;
  let observations = 0;
  for (let index = start; index < funding.length && funding[index].timestamp <= to; index += 1) {
    const rate = Number(funding[index].fundingRate);
    if (!Number.isFinite(rate)) continue;
    signedCost += (side === "LONG" ? rate : -rate) * 100;
    observations += 1;
  }
  return { signedCostPct: signedCost, observations };
}

function firstIndex(values, target) {
  return values.findIndex((value) => value === target);
}

export function calculateForwardPath(candles, funding, index, bars, side, {
  feeRatePerSide,
  slippageRate
}) {
  if (!SIDES.includes(side)) throw new Error(`Unknown forward-path side: ${side}`);
  const entryCandle = candles[index];
  const path = candles.slice(index + 1, index + bars + 1);
  if (!entryCandle || path.length < bars) return null;
  const entry = Number(entryCandle.close);
  const direction = side === "LONG" ? 1 : -1;
  const directionalReturns = path.map((row) => direction * (Number(row.close) / entry - 1));
  const favorable = path.map((row) => side === "LONG"
    ? Number(row.high) / entry - 1
    : entry / Number(row.low) - 1);
  const adverse = path.map((row) => side === "LONG"
    ? Number(row.low) / entry - 1
    : entry / Number(row.high) - 1);
  const maximumFavorable = Math.max(...favorable);
  const maximumAdverse = Math.min(...adverse);
  const mfeIndex = firstIndex(favorable, maximumFavorable);
  const maeIndex = firstIndex(adverse, maximumAdverse);
  const endTimestamp = entryCandle.timestamp + (bars + 1) * BAR_MS;
  const fundingCost = fundingCostPct(funding, entryCandle.timestamp + BAR_MS, endTimestamp, side);
  const feesPct = 2 * Number(feeRatePerSide) * 100;
  const slippagePct = 2 * Number(slippageRate) * 100;
  const terminalReturnPct = directionalReturns.at(-1) * 100;
  const netTerminalReturnPct = terminalReturnPct - feesPct - slippagePct - fundingCost.signedCostPct;
  return {
    bars,
    endTimestamp,
    terminalReturnPct: round(terminalReturnPct, 6),
    mfePct: round(maximumFavorable * 100, 6),
    maePct: round(maximumAdverse * 100, 6),
    mfeMaeRatio: Math.abs(maximumAdverse) > 1e-12 ? round(maximumFavorable / Math.abs(maximumAdverse), 6) : null,
    timeToMfeMinutes: (mfeIndex + 1) * 15,
    timeToMaeMinutes: (maeIndex + 1) * 15,
    firstExtreme: mfeIndex < maeIndex ? "MFE_FIRST" : maeIndex < mfeIndex ? "MAE_FIRST" : "SAME_BAR",
    feesPct: round(feesPct, 6),
    slippagePct: round(slippagePct, 6),
    fundingCostPct: round(fundingCost.signedCostPct, 6),
    fundingObservations: fundingCost.observations,
    totalCostPct: round(feesPct + slippagePct + fundingCost.signedCostPct, 6),
    netTerminalReturnPct: round(netTerminalReturnPct, 6)
  };
}

export function buildForwardPathLabels(dataset, decisionRows, {
  feeRatePerSide,
  slippageRate
}) {
  const indexByTimestamp = new Map(dataset.candles.map((row, index) => [row.timestamp + BAR_MS, index]));
  const rows = decisionRows.map((decision) => {
    const index = indexByTimestamp.get(decision.timestamp);
    if (!Number.isInteger(index)) throw new Error(`Decision timestamp is not a completed catalog candle: ${decision.timestamp}`);
    return {
      ...decision,
      outcomes: Object.fromEntries(SIDES.map((side) => [side, Object.fromEntries(
        Object.entries(TRADABLE_EDGE_HORIZONS).map(([horizon, bars]) => [
          horizon,
          calculateForwardPath(dataset.candles, dataset.funding, index, bars, side, { feeRatePerSide, slippageRate })
        ])
      )]))
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dataManifestHash: dataset.manifest.manifestHash,
    horizons: TRADABLE_EDGE_HORIZONS,
    labelPolicy: {
      entry: "completed 15m candle close",
      pathStarts: "next 15m candle",
      fees: "round-trip fee charged on entry and exit notional",
      slippage: "round-trip adverse slippage charged on entry and exit",
      funding: "only timestamped historical settlements inside the forward horizon; no forward-fill",
      eligibleAsDecisionInput: false
    },
    rows,
    labelsHash: hashObject({ manifest: dataset.manifest.manifestHash, horizons: TRADABLE_EDGE_HORIZONS, rows })
  };
}

