// Completion step for the 352183 card->bottle route conversion
// (scripts/convert-352183-card-to-bottle.ts).
//
// projectMetricsForFinalizedBag is insert-only by design ("finalize is
// at-most-once"), so the conversion's new BAG_FINALIZED could not replace
// the stale read_bag_metrics snapshot left by the original card finalize.
// The daily-throughput / SKU-daily / station-quality finalized rollups
// source read_bag_metrics, so they still attributed 586 units to the CARD
// product on 2026-06-03.
//
// This script rewrites the single read_bag_metrics row with exactly the
// values the projector would compute from the workflow's current (bottle)
// events, then re-runs the three rollup rebuilds that source it.
// read_bag_metrics is a derived read model; the source events are already
// correct and untouched.
//
//   npx tsx scripts/fix-352183-metrics-snapshot.ts            (dry-run)
//   ALLOW_PRODUCTION_REPAIR=true npx tsx scripts/fix-352183-metrics-snapshot.ts --apply

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { rebuildDailyThroughput } from "@/lib/projector/daily-throughput";
import { rebuildSkuDaily } from "@/lib/projector/sku-daily";
import { rebuildStationQualityDaily } from "@/lib/projector/station-daily";

const SCRIPT_VERSION = "fix-352183-metrics-snapshot-v1";
const WORKFLOW_BAG = "f7ce73e2-ed8d-4a39-82a7-3ff5aa0cdb41";
const BOTTLE_PRODUCT = "67388d2d-97f7-4ac4-8c90-3da471a2cfd9";
const CARD_PRODUCT = "3e8feb72-09a0-4068-8231-c965715c33a9";

// Derived from the workflow's current events, mirroring
// projectMetricsForFinalizedBag exactly:
//   started_at (kept)      2026-06-03 14:34:01.479
//   BOTTLE_HANDPACK 15:00  -> bottle_handpack_seconds 1558
//   CAP_SEAL 15:15         -> bottle_cap_seal_seconds 900
//   STICKER 15:30          -> bottle_sticker_seconds 900
//   PACKAGING 15:50        -> packaging_seconds 1200
//   BAG_FINALIZED 15:50:05 -> total/active 4563
//   counts {8,1,4,0,0}     -> units (8*12+1)*6+4 = 586
//   machines: Bottle Sealer d24f4492, Bottle Stickering 78bced44
const NEW_ROW = {
  finalizedAt: "2026-06-03T15:50:05Z",
  totalSeconds: 4563,
  activeSeconds: 4563,
  packagingSeconds: 1200,
  bottleHandpackSeconds: 1558,
  bottleCapSealSeconds: 900,
  bottleStickerSeconds: 900,
  masterCases: 8,
  displaysMade: 1,
  looseCards: 4,
  unitsYielded: 586,
  yieldPct: "8.113",
  machineIds: [
    "d24f4492-0634-463f-9a7b-1abf826ab34d",
    "78bced44-71cd-4fab-8cd3-c2263c420c08",
  ],
} as const;

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");
  console.log(`[${SCRIPT_VERSION}] mode=${applyMode ? "APPLY" : "DRY-RUN"}`);
  if (applyMode && process.env.ALLOW_PRODUCTION_REPAIR !== "true") {
    console.error("Refusing apply: set ALLOW_PRODUCTION_REPAIR=true");
    process.exit(1);
  }

  const rows = (await db.execute(sql`
    SELECT product_id::text, finalized_at, master_cases, displays_made, loose_cards,
           units_yielded
    FROM read_bag_metrics WHERE workflow_bag_id = ${WORKFLOW_BAG}::uuid
  `)) as unknown as Array<Record<string, unknown>>;
  const stale = rows[0];
  if (
    !stale ||
    stale.product_id !== CARD_PRODUCT ||
    Number(stale.master_cases) !== 0 ||
    Number(stale.loose_cards) !== 586
  ) {
    console.error(`ABORT: metrics row not in expected stale state: ${JSON.stringify(stale)}`);
    process.exit(1);
  }

  console.log("Stale row:", JSON.stringify(stale));
  console.log("Will rewrite to bottle snapshot + rebuild throughput/SKU/station-quality rollups.");
  if (!applyMode) {
    console.log("\nDry-run complete — no mutations written.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await writeAudit(
      {
        actorId: null,
        actorRole: null,
        action: "live_ops_repair.route_conversion_352183_metrics_fix",
        targetType: "WorkflowBag",
        targetId: WORKFLOW_BAG,
        before: stale,
        after: { ...NEW_ROW, product_id: BOTTLE_PRODUCT, script: SCRIPT_VERSION },
      },
      tx,
    );
    await tx.execute(sql`
      UPDATE read_bag_metrics SET
        product_id = ${BOTTLE_PRODUCT}::uuid,
        finalized_at = ${NEW_ROW.finalizedAt}::timestamptz,
        total_seconds = ${NEW_ROW.totalSeconds},
        paused_seconds = 0,
        active_seconds = ${NEW_ROW.activeSeconds},
        blister_seconds = NULL,
        sealing_seconds = NULL,
        packaging_seconds = ${NEW_ROW.packagingSeconds},
        bottle_handpack_seconds = ${NEW_ROW.bottleHandpackSeconds},
        bottle_cap_seal_seconds = ${NEW_ROW.bottleCapSealSeconds},
        bottle_sticker_seconds = ${NEW_ROW.bottleStickerSeconds},
        master_cases = ${NEW_ROW.masterCases},
        displays_made = ${NEW_ROW.displaysMade},
        loose_cards = ${NEW_ROW.looseCards},
        damaged_packaging = 0,
        ripped_cards = 0,
        units_yielded = ${NEW_ROW.unitsYielded},
        yield_pct = ${NEW_ROW.yieldPct},
        operator_codes = '{}',
        machine_ids = ${sql.raw(`'{${NEW_ROW.machineIds.join(",")}}'::uuid[]`)}
      WHERE workflow_bag_id = ${WORKFLOW_BAG}::uuid
    `);
    await rebuildDailyThroughput(tx);
    await rebuildSkuDaily(tx);
    await rebuildStationQualityDaily(tx);
  });

  const after = (await db.execute(sql`
    SELECT rdt.day, p.kind, rdt.bags_finalized, rdt.units_produced, rdt.cases_produced
    FROM read_daily_throughput rdt JOIN products p ON p.id = rdt.product_id
    WHERE rdt.product_id IN (${CARD_PRODUCT}::uuid, ${BOTTLE_PRODUCT}::uuid)
      AND rdt.day = '2026-06-03'
    ORDER BY p.kind
  `)) as unknown as Array<Record<string, unknown>>;
  console.log("\nJune 3 throughput after fix:", JSON.stringify(after, null, 2));
  console.log("\nApply complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
