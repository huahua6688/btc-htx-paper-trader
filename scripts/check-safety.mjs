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

const files = (await readdir(sourceRoot)).filter((name) => name.endsWith(".mjs"));
const violations = [];
for (const file of files) {
  const text = await readFile(new URL(file, sourceRoot), "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
}

if (violations.length) {
  process.stderr.write(`Safety check failed in ${root}:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Safety check passed: no account, trading, order, leverage, or credential-write commands are present.\n");
}
