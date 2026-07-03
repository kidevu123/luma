// BATCH-LOST-QR-RESERVATION-REPAIR-1 — Read-only detector for receive/intake
// bags whose bag_qr_code points at a RAW_BAG QR card that drifted to IDLE (lost
// intake reservation), so the bag is not floor-ready even though it claims the
// QR. Classifies each row safe/unsafe with the SAME guard the repair uses.
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/detect-lost-qr-reservations.ts
//
// Read-only. No DB writes. No remediation.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { canRepairQrReservation } from "@/lib/db/queries/bag-edits";

type Row = {
  inventory_bag_id: string;
  bag_number: number | null;
  bag_qr_code: string;
  bag_status: string;
  internal_receipt_number: string | null;
  receive_name: string | null;
  qr_card_id: string;
  qr_card_type: string;
  qr_card_status: string;
  qr_assigned_workflow_bag_id: string | null;
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
           ib.internal_receipt_number, rc.receive_name,
           c.id AS qr_card_id, c.card_type AS qr_card_type, c.status AS qr_card_status,
           c.assigned_workflow_bag_id AS qr_assigned_workflow_bag_id,
           (SELECT count(*)::int FROM inventory_bags o WHERE o.bag_qr_code = ib.bag_qr_code) AS bags_with_token
    FROM inventory_bags ib
    JOIN qr_cards c ON c.scan_token = ib.bag_qr_code
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives rc ON rc.id = sb.receive_id
    WHERE c.card_type = 'RAW_BAG' AND c.status = 'IDLE' AND c.assigned_workflow_bag_id IS NULL
  `)) as unknown as Row[];

  let safe = 0;
  const reasonCounts = new Map<string, number>();
  const safeRows: Row[] = [];

  for (const r of rows) {
    const guard = canRepairQrReservation({
      bagStatus: r.bag_status,
      bagQrCode: r.bag_qr_code,
      card: {
        cardType: r.qr_card_type,
        status: r.qr_card_status,
        assignedWorkflowBagId: r.qr_assigned_workflow_bag_id,
      },
      otherBagClaimsToken: r.bags_with_token > 1,
    });
    const reason = guard.ok ? "SAFE_TO_REPAIR" : guard.reason;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (guard.ok) {
      safe++;
      safeRows.push(r);
    }
  }

  console.log(`Lost QR reservation candidates: ${rows.length}`);
  console.log(`  safe to repair: ${safe}`);
  console.log(`  unsafe/skip:    ${rows.length - safe}`);
  console.log("Reasons:");
  for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(3)}  ${reason}`);
  }
  console.log("\nSafe rows (up to 50):");
  for (const r of safeRows.slice(0, 50)) {
    console.log(
      `  bag ${r.bag_number ?? "?"} · receipt ${r.internal_receipt_number ?? "-"} · ${r.bag_qr_code} · ${r.receive_name ?? "-"} · ${r.inventory_bag_id}`,
    );
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
