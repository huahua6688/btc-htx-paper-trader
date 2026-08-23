import { TELEGRAM_CONFIG } from "./config.mjs";

export function telegramEnabled(config = TELEGRAM_CONFIG) {
  return Boolean(config.botToken && config.chatId);
}

function safeErrorMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join("[REDACTED]") : message;
}

export async function callTelegramApi(method, payload = {}, {
  config = TELEGRAM_CONFIG,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!telegramEnabled(config)) {
    return { ok: false, skipped: true, error: "TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未配置" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.apiBaseUrl}/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let body = null;
    try { body = await response.json(); } catch { /* preserve HTTP error */ }
    if (!response.ok || body?.ok !== true) {
      const description = body?.description ?? `HTTP ${response.status}`;
      return { ok: false, skipped: false, error: `Telegram API ${response.status}: ${description}` };
    }
    return { ok: true, skipped: false, result: body.result };
  } catch (error) {
    return { ok: false, skipped: false, error: safeErrorMessage(error, config.botToken) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTelegramMessage(text, {
  config = TELEGRAM_CONFIG,
  fetchImpl = globalThis.fetch,
  replyMarkup = undefined
} = {}) {
  const response = await callTelegramApi("sendMessage", {
    chat_id: config.chatId,
    text: String(text).slice(0, 4_000),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }, { config, fetchImpl });
  return response.ok
    ? { ...response, messageId: response.result?.message_id ?? null }
    : response;
}

export async function editTelegramMessage(messageId, text, {
  config = TELEGRAM_CONFIG,
  fetchImpl = globalThis.fetch,
  replyMarkup = undefined
} = {}) {
  const response = await callTelegramApi("editMessageText", {
    chat_id: config.chatId,
    message_id: Number(messageId),
    text: String(text).slice(0, 4_000),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }, { config, fetchImpl });
  if (!response.ok && /message is not modified/i.test(response.error ?? "")) {
    return { ok: true, skipped: false, unchanged: true, messageId: Number(messageId) };
  }
  return response.ok ? { ...response, messageId: Number(messageId) } : response;
}

export async function getTelegramUpdates(offset, options = {}) {
  return callTelegramApi("getUpdates", {
    offset,
    timeout: 0,
    allowed_updates: ["message", "callback_query"]
  }, options);
}

export async function answerTelegramCallback(callbackQueryId, text, options = {}) {
  return callTelegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: String(text).slice(0, 180),
    show_alert: false
  }, options);
}
