import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TELEGRAM_CONFIG } from "./config.mjs";

function stateFile(directory, key) {
  if (!/^[a-z0-9-]+$/i.test(key)) throw new Error(`Invalid notification state key: ${key}`);
  return join(directory, `${key}.json`);
}

export class NotificationStateStore {
  constructor(directory = TELEGRAM_CONFIG.stateDirectory) {
    this.directory = directory;
  }

  get(key) {
    try {
      const payload = JSON.parse(readFileSync(stateFile(this.directory, key), "utf8"));
      return typeof payload.value === "string" ? payload.value : null;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  set(key, value, updatedAt = new Date().toISOString()) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      stateFile(this.directory, key),
      `${JSON.stringify({ value: String(value), updatedAt })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
}
