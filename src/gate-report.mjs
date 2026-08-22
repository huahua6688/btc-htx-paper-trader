import { openPaperDatabase } from "./db.mjs";
import { calculateGateReport, formatGateReport } from "./gate-reporting.mjs";

const hoursArgument = process.argv.find((item) => item.startsWith("--hours="));
const hours = hoursArgument ? Number(hoursArgument.slice("--hours=".length)) : 24;
if (!(hours > 0)) throw new Error("--hours must be a positive number");
const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const db = openPaperDatabase();
try {
  process.stdout.write(`${formatGateReport(calculateGateReport(db, { since }))}\n`);
} finally {
  db.close();
}

