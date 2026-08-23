import { PAPER_CONFIG } from "./config.mjs";
import { openPaperDatabase, POSITION_GROUP_MIGRATION_VERSION } from "./db.mjs";

const db = openPaperDatabase();
try {
  const result = db.repairPositionGroups();
  const openPositions = db.getOpenPositions();
  const openGroups = db.getOpenPositionGroups();
  const problems = [];
  for (const position of openPositions) {
    const group = openGroups.find((item) => Number(item.group_id) === Number(position.position_group_id));
    if (!group) problems.push(`#${position.id} 没有 OPEN Position Group`);
    else if (group.side !== position.side) problems.push(`#${position.id} 与 group #${group.group_id} 方向不一致`);
  }
  for (const group of openGroups) {
    const sides = new Set(group.positions.filter((item) => item.status === "OPEN").map((item) => item.side));
    if (sides.size !== 1 || !sides.has(group.side)) problems.push(`group #${group.group_id} 混入相反方向仓位`);
  }
  if (problems.length) throw new Error(`Position Group 修复后仍不一致：${problems.join("；")}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    databasePath: db.path,
    backupPath: db.positionGroupMigrationBackup,
    migrationVersion: POSITION_GROUP_MIGRATION_VERSION,
    idempotentRepairChanges: {
      changedPositions: result.changedPositions,
      createdGroups: result.createdGroups,
      repairedGroups: result.repairedGroups,
      legacyUnknownPositions: result.legacyUnknownPositions
    },
    openGroups: openGroups.map((group) => ({
      groupId: Number(group.group_id),
      side: group.side,
      status: group.status,
      positionIds: group.positions.filter((item) => item.status === "OPEN").map((item) => Number(item.id))
    })),
    paperOnly: PAPER_CONFIG.paperOnly
  }, null, 2)}\n`);
} finally {
  db.close();
}
