// Phase VALIDATION-2C — replay-blister-segments.
//
// One-shot recovery for BLISTER_COMPLETE workflow events whose
// segment hook didn't run (e.g. due to the count_total/machine_count
// payload-key drift introduced and fixed in 2C). For each
// BLISTER_COMPLETE with a non-zero counter that has NO
// ROLL_COUNTER_SEGMENT_RECORDED event sharing its workflowBagId, we
// invoke emitMaterialConsumedFromBlister with the original payload.
//
// Idempotent: bag_segment_sequence + roll_segment_sequence keys mean
// re-running this on an already-segmented bag is a no-op (the hook
// reads SUM() of existing segments to compute new sequences, and a
// freshly added duplicate would just bump them — so we gate on
// "no segments for this bag" instead of relying on dedup).
//
// Usage:
//   tsx scripts/replay-blister-segments.ts          # apply
//   tsx scripts/replay-blister-segments.ts --dry    # report only

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rebuildRollUsage } from "@/lib/projector/roll-usage";
import { rebuildMaterialLotState } from "@/lib/projector/material-lot-state";
import { emitMaterialConsumedFromBlister } from "@/lib/projector/material-consumption-hook";

async function main() {
  const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  console.log(`[replay-segments] ${dryRun ? "DRY-RUN" : "LIVE"} starting…`);

  type Row = {
    workflow_event_id: string;
    workflow_bag_id: string;
    station_id: string;
    payload: Record<string, unknown>;
    occurred_at: string;
    client_event_id: string | null;
  };

  const candidates = (await db.execute<Row>(sql`
    SELECT
      we.id::text                AS workflow_event_id,
      we.workflow_bag_id::text   AS workflow_bag_id,
      we.station_id::text        AS station_id,
      we.payload                 AS payload,
      we.occurred_at::text       AS occurred_at,
      we.client_event_id         AS client_event_id
    FROM workflow_events we
    WHERE we.event_type = 'BLISTER_COMPLETE'
      AND we.station_id IS NOT NULL
      AND COALESCE((we.payload->>'count_total')::int, (we.payload->>'machine_count')::int, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM material_inventory_events ev
        WHERE ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
          AND (ev.payload->>'workflow_bag_id')::uuid = we.workflow_bag_id
      )
    ORDER BY we.occurred_at ASC
  `)) as unknown as Row[];

  console.log(`[replay-segments] found ${candidates.length} BLISTER_COMPLETE event(s) without segments`);
  if (candidates.length === 0) {
    process.exit(0);
  }

  for (const r of candidates) {
    const counter =
      Number(r.payload?.["count_total"]) ||
      Number(r.payload?.["machine_count"]) ||
      0;
    console.log(
      `[replay-segments] bag=${r.workflow_bag_id.slice(0, 8)} station=${r.station_id.slice(0, 8)} counter=${counter} occurred=${r.occurred_at}`,
    );
    if (dryRun) continue;
    await db.transaction(async (tx) => {
      await emitMaterialConsumedFromBlister(tx, {
        workflowBagId: r.workflow_bag_id,
        stationId: r.station_id,
        payload: r.payload,
        occurredAt: new Date(r.occurred_at),
        upstreamClientEventId: r.client_event_id,
      });
    });
  }

  if (!dryRun) {
    console.log("[replay-segments] rebuilding read_roll_usage + read_material_lot_state…");
    await db.transaction(async (tx) => {
      await rebuildRollUsage(tx);
      await rebuildMaterialLotState(tx);
    });
  }

  console.log("[replay-segments] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[replay-segments] failed:", err);
  process.exit(1);
});
