import { TELEGRAM_CONFIG } from "./config.mjs";
import { sendTelegramMessage, telegramEnabled } from "./telegram-client.mjs";

if (!telegramEnabled(TELEGRAM_CONFIG)) {
  process.stderr.write("Telegram test skipped safely: TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 必须通过环境变量配置。\n");
  process.exitCode = 1;
} else {
  const message = [
    "✅ BTC/USDT V1 Telegram 测试成功",
    `时间：${new Date().toISOString()}`,
    "模式：Paper Trading",
    "HTX：仅公开行情；没有真实交易能力。"
  ].join("\n");
  const result = await sendTelegramMessage(message);
  if (result.ok) {
    process.stdout.write(`Telegram test message sent successfully (message_id=${result.messageId ?? "unknown"}).\n`);
  } else {
    process.stderr.write(`Telegram test failed safely: ${result.error}\n`);
    process.exitCode = 1;
  }
}
