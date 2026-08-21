import { openPaperDatabase } from "./db.mjs";
import { formatReport } from "./paper-format.mjs";

const db = openPaperDatabase();
try {
  process.stdout.write(`${formatReport(db)}\n`);
} finally {
  db.close();
}
