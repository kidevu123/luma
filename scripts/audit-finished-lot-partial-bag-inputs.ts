/**
 * Audit script: find finished_lot_inputs that may have recorded the
 * full bag pill_count instead of the actual consumed quantity.
 *
 * A row is "suspect" when:
 *   - finished_lot_inputs.qty_consumed = inventory_bags.pill_count
 *   - a CLOSED/DEPLETED allocation session exists for the same bag
 *   - that session's consumed_qty differs from the lot input qty_consumed
 *
 * This is read-only. It does NOT modify any data.
 * Safe to run in production.
 *
 * Usage:
 *   npx tsx scripts/audit-finished-lot-partial-bag-inputs.ts
 *
 * Requires DATABASE_URL or the same env variables the app uses
 * (same .env or /etc/luma/.env).
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

type SuspectRow = {
  finished_lot_input_id: string;
  finished_lot_id: string;
  finished_lot_number: string;
  batch_id: string;
  inventory_bag_id: string | null;
  lot_input_qty_consumed: number;
  bag_pill_count: number | null;
  allocation_session_id: string;
  allocation_session_consumed_qty: number | null;
  allocation_status: string;
  session_closed_at: string | null;
};

async function main() {
  console.log("Auditing finished_lot_inputs for suspect partial-bag quantities...\n");

  const rows = (await db.execute<SuspectRow>(sql`
    SELECT
      fli.id::text                              AS finished_lot_input_id,
      fl.id::text                               AS finished_lot_id,
      fl.finished_lot_number                    AS finished_lot_number,
      fli.batch_id::text                        AS batch_id,
      ib.id::text                               AS inventory_bag_id,
      fli.qty_consumed                          AS lot_input_qty_consumed,
      ib.pill_count                             AS bag_pill_count,
      s.id::text                                AS allocation_session_id,
      s.consumed_qty                            AS allocation_session_consumed_qty,
      s.allocation_status                       AS allocation_status,
      s.closed_at::text                         AS session_closed_at
    FROM finished_lot_inputs fli
    JOIN finished_lots fl          ON fl.id  = fli.finished_lot_id
    JOIN batches b                 ON b.id   = fli.batch_id
    -- inventory_bags tie to batches via batch_id
    JOIN inventory_bags ib         ON ib.batch_id = fli.batch_id
    -- The allocation session must be for this specific bag and be CLOSED/DEPLETED
    JOIN raw_bag_allocation_sessions s
      ON s.inventory_bag_id = ib.id
     AND s.allocation_status IN ('CLOSED', 'DEPLETED')
    WHERE
      -- qty_consumed matches the full bag pill_count (the suspect condition)
      fli.qty_consumed = ib.pill_count
      -- but the allocation session recorded a different consumed_qty
      AND s.consumed_qty IS NOT NULL
      AND s.consumed_qty <> fli.qty_consumed
    ORDER BY fl.produced_on DESC, fl.finished_lot_number, fli.id
  `)) as unknown as SuspectRow[];

  if (rows.length === 0) {
    console.log("No suspect rows found. All finished_lot_inputs look consistent with allocation sessions.");
    return;
  }

  console.log(`Found ${rows.length} suspect finished_lot_inputs row(s):\n`);
  console.log(
    [
      "finished_lot_number",
      "lot_input_qty_consumed",
      "allocation_session_consumed_qty",
      "difference",
      "bag_id",
      "session_id",
      "allocation_status",
      "session_closed_at",
    ].join("\t"),
  );
  for (const r of rows) {
    const diff = (r.lot_input_qty_consumed ?? 0) - (r.allocation_session_consumed_qty ?? 0);
    console.log(
      [
        r.finished_lot_number,
        r.lot_input_qty_consumed,
        r.allocation_session_consumed_qty,
        diff > 0 ? `+${diff}` : String(diff),
        r.inventory_bag_id ?? "(no bag)",
        r.allocation_session_id,
        r.allocation_status,
        r.session_closed_at ?? "—",
      ].join("\t"),
    );
  }

  console.log("\nThese rows should be reviewed and corrected before enabling live Zoho writes.");
  console.log("Update finished_lot_inputs.qty_consumed to match the allocation session's consumed_qty.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exit(1);
  });
