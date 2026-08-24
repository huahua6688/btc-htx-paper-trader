import { openPaperDatabase } from "./db.mjs";
import { formatStatus } from "./paper-format.mjs";
import { buildDataInfrastructureStatus } from "./data-infrastructure-status.mjs";

const db = openPaperDatabase();
try {
  const infrastructure = await buildDataInfrastructureStatus(db);
  process.stdout.write(`${formatStatus(db, infrastructure)}\n`);
} finally {
  db.close();
}
