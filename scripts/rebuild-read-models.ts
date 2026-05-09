// Phase C — full read-model rebuild.
//
// Wipes and re-aggregates every Phase A read model from
// workflow_events + read_bag_metrics. Source-of-truth tables
// (workflow_events, workflow_bags, read_bag_metrics, etc.) are
// untouched. Idempotent — safe to run multiple times.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/rebuild-read-models.ts
//   DATABASE_URL=postgres://... tsx scripts/rebuild-read-models.ts --dry-run
//
// Dry-run prints the row counts the rebuild would clear without
// actually wiping. Useful before running against a populated DB.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { rebuildQueueState } from "@/lib/projector/queue-state";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildMaterialReconciliation } from "@/lib/projector/material-reconciliation";
import { rebuildMaterialReconciliationV2 } from "@/lib/projector/material-reconciliation-v2";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { rebuildMaterialConsumptionDaily } from "@/lib/projector/material-consumption-daily";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { rebuildMaterialUsageLearning } from "@/lib/projector/material-usage-learning";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const dryRun = process.argv.includes("--dry-run");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log(
    `[rebuild-read-models] ${dryRun ? "DRY-RUN — no changes will be written" : "LIVE — rebuilding read models"}`,
  );

  const tables = [
    "read_queue_state",
    "read_sku_daily",
    "read_material_reconciliation",
    "read_material_reconciliation_v2",
    "read_station_quality_daily",
    "read_material_lot_state",
    "read_material_consumption_daily",
    "read_roll_usage",
    "read_material_usage_learning",
  ] as const;

  // Pre-rebuild row counts.
  for (const t of tables) {
    const rows = (await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${t};`),
    )) as Array<{ count: number }>;
    const count = rows[0]?.count ?? 0;
    console.log(`[before] ${t.padEnd(36)} ${count} rows`);
  }

  if (dryRun) {
    console.log("[rebuild-read-models] dry-run complete; no rebuild performed.");
    await client.end();
    return;
  }

  await db.transaction(async (tx) => {
    console.log("[rebuild-read-models] rebuilding read_queue_state…");
    await rebuildQueueState(tx);
    console.log("[rebuild-read-models] rebuilding read_sku_daily…");
    await rebuildSkuDaily(tx);
    console.log("[rebuild-read-models] rebuilding read_material_reconciliation…");
    await rebuildMaterialReconciliation(tx);
    console.log(
      "[rebuild-read-models] rebuilding read_material_reconciliation_v2…",
    );
    const v2Result = await rebuildMaterialReconciliationV2(tx);
    console.log(
      `[rebuild-read-models]   v2 scanned=${v2Result.scanned} written=${v2Result.written}`,
    );
    console.log("[rebuild-read-models] rebuilding read_station_quality_daily…");
    await rebuildStationQualityDaily(tx);
    console.log("[rebuild-read-models] rebuilding read_material_lot_state…");
    await rebuildMaterialLotState(tx);
    console.log("[rebuild-read-models] rebuilding read_material_consumption_daily…");
    await rebuildMaterialConsumptionDaily(tx);
    console.log("[rebuild-read-models] rebuilding read_roll_usage…");
    await rebuildRollUsage(tx);
    console.log("[rebuild-read-models] rebuilding read_material_usage_learning…");
    await rebuildMaterialUsageLearning(tx);
  });

  // Post-rebuild row counts.
  for (const t of tables) {
    const rows = (await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${t};`),
    )) as Array<{ count: number }>;
    const count = rows[0]?.count ?? 0;
    console.log(`[after]  ${t.padEnd(36)} ${count} rows`);
  }

  await client.end();
  console.log("[rebuild-read-models] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
