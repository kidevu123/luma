// Read-only audit: why partial-packaged bags are missing from /partial-bags.
//
//   DATABASE_URL=postgres://... npx tsx scripts/audit-partial-bag-visibility.ts
//
// Optional limit (default 10):
//   AUDIT_LIMIT=5 DATABASE_URL=... npx tsx scripts/audit-partial-bag-visibility.ts

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const limit = Number(process.env.AUDIT_LIMIT ?? "10");

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required for read-only audit.");
    process.exit(1);
  }

  type Row = {
    workflow_bag_id: string;
    inventory_bag_id: string | null;
    inventory_status: string | null;
    bag_qr_code: string | null;
    bag_stage: string | null;
    is_finalized: boolean;
    qr_card_label: string | null;
    partial_close_at: string | null;
    partial_packaging_at: string | null;
    open_sessions: number;
    closed_sessions: number;
    returned_sessions: number;
    latest_ending_balance: number | null;
  };

  const rows = (await db.execute<Row>(sql`
    WITH partial_wf AS (
      SELECT DISTINCT wb.id AS workflow_bag_id
      FROM workflow_bags wb
      JOIN workflow_events we ON we.workflow_bag_id = wb.id
      WHERE we.event_type = 'SEALING_COMPLETE'
        AND (we.payload->>'partial_close')::boolean IS TRUE
    ),
    partial_pkg AS (
      SELECT DISTINCT wb.id AS workflow_bag_id
      FROM workflow_bags wb
      JOIN workflow_events we ON we.workflow_bag_id = wb.id
      WHERE we.event_type = 'PACKAGING_COMPLETE'
        AND (we.payload->>'partial_packaging')::boolean IS TRUE
    ),
    candidates AS (
      SELECT pw.workflow_bag_id
      FROM partial_wf pw
      LEFT JOIN partial_pkg pp ON pp.workflow_bag_id = pw.workflow_bag_id
      ORDER BY pw.workflow_bag_id
      LIMIT ${limit}
    )
    SELECT
      c.workflow_bag_id::text,
      wb.inventory_bag_id::text,
      ib.status::text AS inventory_status,
      ib.bag_qr_code,
      rbs.stage::text AS bag_stage,
      rbs.is_finalized,
      qc.label AS qr_card_label,
      (
        SELECT MAX(we.occurred_at)::text
        FROM workflow_events we
        WHERE we.workflow_bag_id = c.workflow_bag_id
          AND we.event_type = 'SEALING_COMPLETE'
          AND (we.payload->>'partial_close')::boolean IS TRUE
      ) AS partial_close_at,
      (
        SELECT MAX(we.occurred_at)::text
        FROM workflow_events we
        WHERE we.workflow_bag_id = c.workflow_bag_id
          AND we.event_type = 'PACKAGING_COMPLETE'
          AND (we.payload->>'partial_packaging')::boolean IS TRUE
      ) AS partial_packaging_at,
      (
        SELECT COUNT(*)::int FROM raw_bag_allocation_sessions s
        WHERE s.inventory_bag_id = wb.inventory_bag_id
          AND s.allocation_status = 'OPEN'
      ) AS open_sessions,
      (
        SELECT COUNT(*)::int FROM raw_bag_allocation_sessions s
        WHERE s.inventory_bag_id = wb.inventory_bag_id
          AND s.allocation_status = 'CLOSED'
      ) AS closed_sessions,
      (
        SELECT COUNT(*)::int FROM raw_bag_allocation_sessions s
        WHERE s.inventory_bag_id = wb.inventory_bag_id
          AND s.allocation_status = 'RETURNED_TO_STOCK'
      ) AS returned_sessions,
      (
        SELECT s.ending_balance_qty
        FROM raw_bag_allocation_sessions s
        WHERE s.inventory_bag_id = wb.inventory_bag_id
          AND s.allocation_status IN ('CLOSED', 'RETURNED_TO_STOCK')
        ORDER BY s.closed_at DESC NULLS LAST
        LIMIT 1
      ) AS latest_ending_balance
    FROM candidates c
    JOIN workflow_bags wb ON wb.id = c.workflow_bag_id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
    LEFT JOIN qr_cards qc ON qc.assigned_workflow_bag_id = wb.id
    ORDER BY partial_close_at DESC NULLS LAST
  `)) as unknown as Row[];

  console.log(`[audit-partial-bag-visibility] ${rows.length} partial-close workflow bag(s)`);
  for (const row of rows) {
    console.log("---");
    console.log(`workflow_bag_id     : ${row.workflow_bag_id}`);
    console.log(`inventory_bag_id    : ${row.inventory_bag_id ?? "NULL"}`);
    console.log(`inventory_status    : ${row.inventory_status ?? "NULL"}`);
    console.log(`bag_qr_code         : ${row.bag_qr_code ?? "NULL"}`);
    console.log(`qr_card_label       : ${row.qr_card_label ?? "NULL"}`);
    console.log(`read_bag_state      : ${row.bag_stage ?? "?"} finalized=${row.is_finalized}`);
    console.log(`partial_close_at    : ${row.partial_close_at ?? "NULL"}`);
    console.log(`partial_packaging_at: ${row.partial_packaging_at ?? "NULL"}`);
    console.log(
      `allocation sessions : open=${row.open_sessions} closed=${row.closed_sessions} returned=${row.returned_sessions}`,
    );
    console.log(`latest ending bal   : ${row.latest_ending_balance ?? "NULL"}`);

    if (!row.inventory_bag_id) {
      console.log("exclude reason      : Case C — workflow bag not linked to inventory_bag_id");
    } else if (row.inventory_status !== "AVAILABLE") {
      console.log(
        `exclude reason      : inventory status ${row.inventory_status} (needs AVAILABLE + closed/returned session)`,
      );
    } else if (row.closed_sessions + row.returned_sessions === 0) {
      console.log(
        "exclude reason      : Case B/D — no CLOSED/RETURNED allocation session (open=" +
          row.open_sessions +
          ")",
      );
    } else {
      console.log("exclude reason      : should appear on /partial-bags if ending balance > 0");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
