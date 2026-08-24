import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
const exchangeCredentialPattern = /\b(?:HTX|HUOBI)_(?:API|SECRET|ACCESS)_?KEY\b/;
const frozenChampionSha256 = "9b7d3c533b9c1d971e3695348d22f1d3f2feacb8f22519d619a4a63aa7990fa6";

const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".mjs"));
const violations = [];
for (const file of files) {
  const text = await readFile(new URL(file, sourceRoot), "utf8");
  // The audited capability matrix must name the official private skill families
  // so it can prove they are INTERFACE_ONLY.  The executable source whitelist
  // remains strict everywhere else.
  let executableText = text;
  if (file === "htx-skill-capabilities.mjs") {
    executableText = text.replace(/skill:\s*"(?:spot-account|spot-trading|futures-account|futures-trading)"/gi, "skill: \"AUDITED_PRIVATE_SKILL\"");
    const privateRows = text.match(/\{\s*skill:\s*"(?:spot-account|spot-trading|futures-account|futures-trading)"[\s\S]*?\n\s{2}\}/gi) ?? [];
    if (privateRows.length !== 4 || privateRows.some((row) => !/status:\s*"INTERFACE_ONLY"/.test(row))
      || !/exchangeWriteEnabled:\s*false/.test(text)) {
      violations.push(`${file}: every private skill must remain interface-only with exchange writes disabled`);
    }
  }
  for (const pattern of forbidden) if (pattern.test(executableText)) violations.push(`${file}: ${pattern}`);
  if (file !== "htx-cli.mjs" && exchangeCredentialPattern.test(text)) violations.push(`${file}: exchange credential variable is forbidden`);
}

const champion = await readFile(new URL("../src/analysis-engine.mjs", import.meta.url));
const championHash = createHash("sha256").update(champion).digest("hex");
if (championHash !== frozenChampionSha256) violations.push(`analysis-engine.mjs: frozen V1.2 hash changed (${championHash})`);

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
await scanTelegramCredentials(new URL("../test/", import.meta.url), "test");
await scanTelegramCredentials(new URL("../deploy/", import.meta.url), "deploy");
for (const name of ["README.md", "ARCHITECTURE_REVIEW.md", ".env.example", "package.json"]) {
  const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
  if (telegramTokenPattern.test(text)) violations.push(`${name}: possible committed Telegram Bot Token`);
}

if (violations.length) {
  process.stderr.write(`Safety check failed in ${root}:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Safety check passed: frozen Champion ${championHash}; no exchange credentials/write commands or committed Telegram Bot Token patterns are present.\n`);
}
