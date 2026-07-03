// BATCH-LOST-QR-RESERVATION-REPAIR-1 (follow-up) — Read-only report that
// classifies every bag pointing at an IDLE RAW_BAG card into intake vs
// production-side categories, so IN_USE production rows are never confused with
// a safe intake lost reservation.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/detect-qr-production-desync.ts
//
// Read-only. No DB writes. No remediation.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { classifyQrIdlePointedBag } from "@/lib/db/queries/lost-qr-reservations";
import { canRepairQrReservation } from "@/lib/db/queries/bag-edits";

type Row = {
  inventory_bag_id: string;
  bag_number: number | null;
  bag_qr_code: string;
  bag_status: string;
  receipt: string | null;
  receive_name: string | null;
  card_type: string;
  card_status: string;
  card_wf: string | null;
  workflow_bag_id: string | null;
  finalized: boolean;
  bags_with_token: number;
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Error: DATABASE_URL env var is required");
    process.exit(1);
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  const rows = (await db.execute(sql`
    SELECT ib.id AS inventory_bag_id, ib.bag_number, ib.bag_qr_code, ib.status AS bag_status,
           ib.internal_receipt_number AS receipt, rc.receive_name,
           c.card_type, c.status AS card_status, c.assigned_workflow_bag_id AS card_wf,
           wb.id AS workflow_bag_id, (wb.finalized_at IS NOT NULL) AS finalized,
           (SELECT count(*)::int FROM inventory_bags o WHERE o.bag_qr_code = ib.bag_qr_code) AS bags_with_token
    FROM inventory_bags ib
    JOIN qr_cards c ON c.scan_token = ib.bag_qr_code
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives rc ON rc.id = sb.receive_id
    LEFT JOIN workflow_bags wb ON wb.inventory_bag_id = ib.id
    WHERE c.card_type = 'RAW_BAG' AND c.status = 'IDLE' AND c.assigned_workflow_bag_id IS NULL
  `)) as unknown as Row[];

  const counts = new Map<string, number>();
  const byCat = new Map<string, Row[]>();

  for (const r of rows) {
    const guard = canRepairQrReservation({
      bagStatus: r.bag_status,
      bagQrCode: r.bag_qr_code,
      card: { cardType: r.card_type, status: r.card_status, assignedWorkflowBagId: r.card_wf },
      otherBagClaimsToken: r.bags_with_token > 1,
    });
    const { category } = classifyQrIdlePointedBag({
      bagStatus: r.bag_status,
      hasWorkflow: r.workflow_bag_id != null,
      workflowFinalized: r.finalized,
      intakeGuardOk: guard.ok,
    });
    counts.set(category, (counts.get(category) ?? 0) + 1);
    (byCat.get(category) ?? byCat.set(category, []).get(category)!).push(r);
  }

  console.log(`QR idle-pointed bags: ${rows.length}\n`);
  for (const [category, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(3)}  ${category}`);
  }
  console.log("\nActionable (safe intake repair): SAFE_INTAKE_LOST_RESERVATION only.");
  console.log("Needs manual production review: IN_USE_ACTIVE_QR_IDLE, IN_USE_NO_WORKFLOW, AVAILABLE_NEEDS_REVIEW, OTHER_NEEDS_REVIEW.");
  console.log("Expected history (no action): IN_USE_FINALIZED_QR_RELEASED, DEPLETED_QR_RELEASED.\n");

  const review = ["IN_USE_ACTIVE_QR_IDLE", "IN_USE_NO_WORKFLOW", "AVAILABLE_NEEDS_REVIEW", "OTHER_NEEDS_REVIEW"];
  for (const cat of review) {
    for (const r of byCat.get(cat) ?? []) {
      console.log(`  [${cat}] bag ${r.bag_number ?? "?"} · receipt ${r.receipt ?? "-"} · ${r.bag_qr_code} · ${r.receive_name ?? "-"} · ${r.inventory_bag_id}`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
