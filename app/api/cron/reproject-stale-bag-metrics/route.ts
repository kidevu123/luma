// STALE-SNAPSHOT-MATH-1 — maintenance endpoint: reproject read_bag_metrics
// rows whose finalize-time units_yielded snapshot no longer matches the
// live recompute from counts × the product's CURRENT packaging structure
// (bags finalized before a product-structure correction).
//
// Same contract as the other /api/cron routes: bearer-authed, NEVER runs on
// deploy or on a timer — invoked explicitly:
//
//   POST http://localhost:3000/api/cron/reproject-stale-bag-metrics?dryRun=1
//   POST http://localhost:3000/api/cron/reproject-stale-bag-metrics
//   Authorization: Bearer <LUMA_CRON_SECRET>
//
// Dry run reports the stale rows without touching anything. The real run
// calls the canonical reprojectBagMetricsForWorkflowBag per bag (which also
// refreshes the sku-daily / material-reconciliation / station-daily
// rollups) and writes one audit row for the pass.

import { type NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cronAuthHttpStatus, validateCronBearer } from "@/lib/zoho/cron-auth";
import { reprojectBagMetricsForWorkflowBag } from "@/lib/projector/reproject-bag-metrics";
import { writeAudit } from "@/lib/db/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REPAIR_CAP = 200;

type StaleRow = {
  workflow_bag_id: string;
  receipt: string | null;
  snapshot_units: number;
  live_units: number;
};

async function findStaleRows(): Promise<StaleRow[]> {
  return (await db.execute<StaleRow>(sql`
    SELECT m.workflow_bag_id::text AS workflow_bag_id,
           ib.internal_receipt_number AS receipt,
           m.units_yielded AS snapshot_units,
           (CASE WHEN p.units_per_display IS NOT NULL AND p.displays_per_case IS NOT NULL
             THEN m.master_cases * p.units_per_display * p.displays_per_case
                + m.displays_made * p.units_per_display + m.loose_cards
             ELSE m.loose_cards END)::int AS live_units
    FROM read_bag_metrics m
    JOIN workflow_bags wb ON wb.id = m.workflow_bag_id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    LEFT JOIN products p ON p.id = wb.product_id
    WHERE m.units_yielded <> (
      CASE WHEN p.units_per_display IS NOT NULL AND p.displays_per_case IS NOT NULL
        THEN m.master_cases * p.units_per_display * p.displays_per_case
           + m.displays_made * p.units_per_display + m.loose_cards
        ELSE m.loose_cards END)
    ORDER BY ib.internal_receipt_number
    LIMIT ${REPAIR_CAP}
  `)) as unknown as StaleRow[];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = validateCronBearer(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.reason },
      { status: cronAuthHttpStatus(auth.reason) },
    );
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  try {
    const stale = await findStaleRows();
    if (dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, staleCount: stale.length, stale });
    }

    let repaired = 0;
    for (const row of stale) {
      await db.transaction(async (tx) => {
        const r = await reprojectBagMetricsForWorkflowBag(tx, row.workflow_bag_id);
        if (r.updated) repaired += 1;
      });
    }

    await writeAudit({
      actorId: null,
      actorRole: null,
      action: "read_model.stale_bag_metrics_reprojection",
      targetType: "ReadBagMetrics",
      targetId: "maintenance-pass",
      before: { stale_count: stale.length },
      after: {
        repaired,
        capped: stale.length === REPAIR_CAP,
        receipts: stale.map((s) => s.receipt),
      },
    });

    return NextResponse.json({ ok: true, dryRun: false, staleCount: stale.length, repaired });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "reprojection failed" },
      { status: 500 },
    );
  }
}
