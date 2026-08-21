import { TELEGRAM_CONFIG } from "./config.mjs";
import { NotificationStateStore } from "./notification-state.mjs";
import { calculatePerformance, getDailyRiskState } from "./paper-engine.mjs";
import { sendTelegramMessage, telegramEnabled } from "./telegram-client.mjs";
import {
  formatCloseTelegram,
  formatDailySummaryTelegram,
  formatHealthTelegram,
  formatOpenTelegram,
  formatRiskPauseTelegram
} from "./telegram-format.mjs";

export function shanghaiClock(timestamp) {
  const local = new Date(new Date(timestamp).getTime() + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(local.getTime())) throw new Error("Invalid Telegram event timestamp");
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return {
    dayKey: `${year}-${month}-${day}`,
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

export class TelegramNotifier {
  constructor({
    config = TELEGRAM_CONFIG,
    stateStore = new NotificationStateStore(config.stateDirectory),
    sender = sendTelegramMessage,
    logger = (message) => process.stderr.write(`${message}\n`)
  } = {}) {
    this.config = config;
    this.stateStore = stateStore;
    this.sender = sender;
    this.logger = logger;
  }

  get enabled() {
    return telegramEnabled(this.config);
  }

  readState(key) {
    try { return this.stateStore.get(key); }
    catch (error) {
      this.logger(`Telegram state read failed safely (${key}): ${error.message}`);
      return null;
    }
  }

  writeState(key, value, updatedAt) {
    try {
      this.stateStore.set(key, value, updatedAt);
      return true;
    } catch (error) {
      this.logger(`Telegram state write failed safely (${key}): ${error.message}`);
      return false;
    }
  }

  async sendSafely(label, text) {
    if (!this.enabled) return { ok: false, skipped: true };
    try {
      const result = await this.sender(text, { config: this.config });
      if (!result.ok && !result.skipped) {
        this.logger(`Telegram ${label} notification failed safely: ${result.error}`);
      }
      return result;
    } catch (error) {
      this.logger(`Telegram ${label} notification failed safely: ${error.message}`);
      return { ok: false, skipped: false, error: error.message };
    }
  }

  async notifyRiskPause(dailyRisk) {
    if (!dailyRisk?.paused || !dailyRisk.dayStart) return;
    if (this.readState("risk-pause") === dailyRisk.dayStart) return;
    const sent = await this.sendSafely("risk-pause", formatRiskPauseTelegram(dailyRisk));
    if (sent.ok) this.writeState("risk-pause", dailyRisk.dayStart, new Date().toISOString());
  }

  async maybeSendDailySummary(result, db) {
    const clock = shanghaiClock(result.report.generatedAt);
    const threshold = this.config.dailySummaryHour * 60 + this.config.dailySummaryMinute;
    if (clock.minuteOfDay < threshold || this.readState("daily-summary") === clock.dayKey) return;
    const text = formatDailySummaryTelegram({
      performance: calculatePerformance(db),
      dailyRisk: getDailyRiskState(db, result.report.generatedAt),
      openPosition: db.getOpenPosition(),
      generatedAt: result.report.generatedAt
    });
    const sent = await this.sendSafely("daily-summary", text);
    if (sent.ok) this.writeState("daily-summary", clock.dayKey, result.report.generatedAt);
  }

  async notifyMonitorResult(result, db) {
    if (!this.enabled) return;
    try {
      for (const action of result.actions) {
        if (action.type === "OPEN") {
          await this.sendSafely(action.position.side === "LONG" ? "paper-long" : "paper-short", formatOpenTelegram(action.position));
        } else if (action.type === "CLOSE") {
          await this.sendSafely(action.exit.exitReason === "TP" ? "paper-tp" : "paper-sl", formatCloseTelegram(action.position));
        } else if (action.type === "NO_ENTRY" && action.dailyRisk?.paused) {
          await this.notifyRiskPause(action.dailyRisk);
        }
      }
      await this.maybeSendDailySummary(result, db);
    } catch (error) {
      this.logger(`Telegram monitor notifications failed safely: ${error.message}`);
    }
  }

  async notifyHealthResult(result) {
    if (!this.enabled) return;
    const previous = this.readState("health");
    if (result.healthy) {
      if (previous === "unhealthy") {
        const sent = await this.sendSafely("health-recovered", formatHealthTelegram(result, true));
        if (sent.ok) this.writeState("health", "healthy", result.checkedAt);
      } else if (previous === null) {
        this.writeState("health", "healthy", result.checkedAt);
      }
      return;
    }
    if (previous === "unhealthy") return;
    const sent = await this.sendSafely("health-failed", formatHealthTelegram(result, false));
    if (sent.ok) this.writeState("health", "unhealthy", result.checkedAt);
  }
}
