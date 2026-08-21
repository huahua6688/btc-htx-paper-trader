import { openPaperDatabase } from "./db.mjs";
import { formatStatus } from "./paper-format.mjs";

const db = openPaperDatabase();
try {
  process.stdout.write(`${formatStatus(db)}\n`);
} finally {
  db.close();
}
