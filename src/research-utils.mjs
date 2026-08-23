import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BAR_MS = 15 * 60 * 1000;
export const RESEARCH_ROOT = fileURLToPath(new URL("../data/research/", import.meta.url));
export const OUTPUT_ROOT = fileURLToPath(new URL("../research-output/", import.meta.url));

export const round = (value, digits = 6) => Number.isFinite(Number(value))
  ? Number(Number(value).toFixed(digits))
  : null;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value) { return sha256(stableJson(value)); }

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function parseIso(value, label = "timestamp") {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}: ${value}`);
  return ms;
}

export function floorBar(ms, intervalMs = BAR_MS) { return Math.floor(ms / intervalMs) * intervalMs; }
export function ceilBar(ms, intervalMs = BAR_MS) { return Math.ceil(ms / intervalMs) * intervalMs; }

export function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function standardDeviation(values) {
  const average = mean(values);
  if (average === null || values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function resolveResearchPath(...parts) { return resolve(RESEARCH_ROOT, ...parts); }
export function resolveOutputPath(...parts) { return resolve(OUTPUT_ROOT, ...parts); }

export function seededRandom(seed = 42) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
