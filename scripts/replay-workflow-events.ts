// Phase E.6 — replay-workflow-events.
//
// Walks workflow_events for BAG_FINALIZED rows whose corresponding
// workflow_bags row has no finalized_at, copies the timestamp,
// then rebuilds every read model so the dashboards reflect the
// canonical state.
//
// Idempotent. Safe to run repeatedly. Never mints workflow_events.
// Never fabricates output. SKIPPED bags are reported with the
// specific missing input + suggested fix.
//
// Usage:
//   tsx scripts/replay-workflow-events.ts                # apply
//   tsx scripts/replay-workflow-events.ts --dry-run      # report only
//   tsx scripts/replay-workflow-events.ts --bag-id <id>  # one bag

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { replayFinalizedBags } from "@/lib/legacy/replay-finalized-bags";
import { synthesizeReadModelsFromEvents } from "@/lib/legacy/read-model-synthesizer";
import { rebuildQueueState } from "@/lib/projector/queue-state";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildMaterialReconciliation } from "@/lib/projector/material-reconciliation";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const bagIdFlagIndex = args.indexOf("--bag-id");
  const bagId =
    bagIdFlagIndex >= 0 ? args[bagIdFlagIndex + 1] : undefined;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log(
    `[replay] ${dryRun ? "DRY-RUN — no changes will be written" : "LIVE — will backfill workflow_bags.finalized_at and rebuild read models"}${bagId ? ` (bag ${bagId})` : ""}`,
  );

  // BEFORE counts.
  for (const t of [
    "workflow_events",
    "workflow_bags",
    "read_bag_state",
    "read_bag_metrics",
    "read_sku_daily",
    "read_material_reconciliation",
    "read_station_quality_daily",
    "read_queue_state",
  ]) {
    const rows = (await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${t};`),
    )) as Array<{ count: number }>;
    console.log(`[before] ${t.padEnd(36)} ${rows[0]?.count ?? 0} rows`);
  }
  const finalizedRows = (await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM workflow_bags WHERE finalized_at IS NOT NULL;`,
  )) as Array<{ count: number }>;
  console.log(
    `[before] workflow_bags.finalized_at NOT NULL  ${finalizedRows[0]?.count ?? 0} rows`,
  );

  // PHASE 1: backfill finalized_at where the BAG_FINALIZED event exists.
  console.log("[replay] phase 1: backfill workflow_bags.finalized_at…");
  const replayOpts: { dryRun?: boolean; bagId?: string } = {};
  if (dryRun) replayOpts.dryRun = true;
  if (bagId) replayOpts.bagId = bagId;
  const result = await replayFinalizedBags(replayOpts);
  console.log(
    `  candidates: ${result.candidatesScanned}, backfilled: ${result.backfilled}, already-finalized: ${result.alreadyFinalized}, skipped: ${result.skipped}`,
  );
  if (result.skipped > 0) {
    console.log(`  [skipped detail]`);
    for (const r of result.reports) {
      if (r.status === "SKIPPED") {
        console.log(
          `    bag ${r.workflowBagId.slice(0, 8)}… missing=${r.missingInputs.join(",") || "—"} reason=${r.reason}`,
        );
      }
    }
  }

  if (!dryRun) {
    // PHASE 2: rebuild read models that depend on finalized bags.
    console.log("[replay] phase 2: rebuild read models…");
    await db.transaction(async (tx) => {
      console.log("  rebuildQueueState…");
      await rebuildQueueState(tx);
    });
    // synthesizeReadModelsFromEvents owns its own deletes — runs at
    // top level, not inside a tx.
    console.log("  synthesizeReadModelsFromEvents…");
    const synth = await synthesizeReadModelsFromEvents();
    console.log(
      `    bagState=${synth.bagStateRows} bagMetrics=${synth.bagMetricsRows} dailyThroughput=${synth.dailyThroughputRows} operatorDaily=${synth.operatorDailyRows}`,
    );
    await db.transaction(async (tx) => {
      console.log("  rebuildSkuDaily…");
      await rebuildSkuDaily(tx);
      console.log("  rebuildMaterialReconciliation…");
      await rebuildMaterialReconciliation(tx);
      console.log("  rebuildStationQualityDaily…");
      await rebuildStationQualityDaily(tx);
    });
  }

  // AFTER counts.
  for (const t of [
    "workflow_events",
    "workflow_bags",
    "read_bag_state",
    "read_bag_metrics",
    "read_sku_daily",
    "read_material_reconciliation",
    "read_station_quality_daily",
    "read_queue_state",
  ]) {
    const rows = (await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${t};`),
    )) as Array<{ count: number }>;
    console.log(`[after]  ${t.padEnd(36)} ${rows[0]?.count ?? 0} rows`);
  }
  const finalizedAfter = (await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM workflow_bags WHERE finalized_at IS NOT NULL;`,
  )) as Array<{ count: number }>;
  console.log(
    `[after]  workflow_bags.finalized_at NOT NULL  ${finalizedAfter[0]?.count ?? 0} rows`,
  );

  await client.end();
  console.log(`[replay] done${dryRun ? " (dry-run)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
