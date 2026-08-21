import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = new URL("../src/", import.meta.url);
const forbidden = [
  /futures-trading/i,
  /spot-trading/i,
  /futures-account/i,
  /spot-account/i,
  /set-key/i,
  /set-secret/i,
  /place-order/i,
  /cancel-order/i,
  /switch-lever/i
];
const telegramTokenPattern = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/;

const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".mjs"));
const violations = [];
for (const file of files) {
  const text = await readFile(new URL(file, sourceRoot), "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
}

async function scanTelegramCredentials(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await scanTelegramCredentials(target, relative);
    else if (/\.(?:mjs|json|md|service|timer|example)$/.test(entry.name) || entry.name === "btc-htx-paper") {
      const text = await readFile(target, "utf8");
      if (telegramTokenPattern.test(text)) violations.push(`${relative}: possible committed Telegram Bot Token`);
    }
  }
}

await scanTelegramCredentials(new URL("../src/", import.meta.url), "src");
await scanTelegramCredentials(new URL("../deploy/", import.meta.url), "deploy");
for (const name of ["README.md", ".env.example", "package.json"]) {
  const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  if (telegramTokenPattern.test(text)) violations.push(`${name}: possible committed Telegram Bot Token`);
}

if (violations.length) {
  process.stderr.write(`Safety check failed in ${root}:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Safety check passed: no exchange write commands or committed Telegram Bot Token patterns are present.\n");
}
