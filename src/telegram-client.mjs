import { TELEGRAM_CONFIG } from "./config.mjs";

export function telegramEnabled(config = TELEGRAM_CONFIG) {
  return Boolean(config.botToken && config.chatId);
}

function safeErrorMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join("[REDACTED]") : message;
}

export async function sendTelegramMessage(text, {
  config = TELEGRAM_CONFIG,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!telegramEnabled(config)) {
    return { ok: false, skipped: true, error: "TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未配置" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(
      `${config.apiBaseUrl}/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: String(text).slice(0, 4_000)
        }),
        signal: controller.signal
      }
    );
    let payload = null;
    try { payload = await response.json(); } catch { /* keep the HTTP error below */ }
    if (!response.ok || payload?.ok !== true) {
      const description = payload?.description ?? `HTTP ${response.status}`;
      return { ok: false, skipped: false, error: `Telegram API ${response.status}: ${description}` };
    }
    return { ok: true, skipped: false, messageId: payload.result?.message_id ?? null };
  } catch (error) {
    return { ok: false, skipped: false, error: safeErrorMessage(error, config.botToken) };
  } finally {
    clearTimeout(timeout);
  }
}
