import { MARKET_ARCHIVE_CONFIG } from "./config.mjs";
import { readMarketArchiveStatus } from "./market-archive.mjs";

const command = process.argv[2] ?? "status";
if (command !== "status") throw new Error("Usage: npm run archive:status");
const status = readMarketArchiveStatus();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else {
  const lines = [
    "HTX Market Archive 状态",
    `数据库：${status.path}（${MARKET_ARCHIVE_CONFIG.pathSource}）`,
    `状态：${status.available ? "AVAILABLE" : "尚未建立"}`
  ];
  if (status.storage) lines.push(`记录：${status.storage.records}；文件：${status.storage.bytes} bytes；retention：${status.storage.retentionPolicy}`);
  for (const item of status.coverage) lines.push(`- ${item.type}: ${item.records} / ${item.earliest} → ${item.latest} / gaps ${item.gaps.length}`);
  lines.push("安全：独立研究库；归档失败不会控制 monitor，也不具备交易权限。");
  process.stdout.write(`${lines.join("\n")}\n`);
}
