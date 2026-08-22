import { analyzeSnapshot } from "./analysis-engine.mjs";
import { formatChinese } from "./format.mjs";
import { collectMarketSnapshot } from "./market-data.mjs";

try {
  const snapshot = await collectMarketSnapshot();
  const report = analyzeSnapshot(snapshot);
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatChinese(report)}\n`);
} catch (error) {
  process.stderr.write(`V1.1 analysis failed safely: ${error.message}\n`);
  process.exitCode = 1;
}
