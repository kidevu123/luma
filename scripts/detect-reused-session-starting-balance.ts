// REUSE-STARTING-BALANCE-1 — Read-only detector for allocation sessions that
// opened from the wrong starting balance: a reused partial bag whose new session
// started from a value DIFFERENT than the latest prior TERMINAL session's ending
// balance (CLOSED / RETURNED_TO_STOCK / DEPLETED). This is the pattern behind the
// bag-card-104 bug (session started at declared 7,197 instead of returned 3,598).
//
// Usage:
//   DATABASE_URL=postgres://... tsx scripts/detect-reused-session-starting-balance.ts
//
// Read-only. No DB writes. No remediation. Excludes self-matches (a session's
// own closed_at can slightly precede its created_at).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

type Row = {
  session_id: string;
  inventory_bag_id: string;
  allocation_status: string;
  started_at: number | null;
  prior_session_id: string | null;
  prior_ending: number | null;
  prior_status: string | null;
  created_at: string;
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
    WITH prior AS (
      SELECT
        s.id AS session_id,
        s.inventory_bag_id,
        s.allocation_status,
        s.starting_balance_qty AS started_at,
        s.created_at,
        (SELECT p.id FROM raw_bag_allocation_sessions p
           WHERE p.inventory_bag_id = s.inventory_bag_id AND p.id <> s.id
             AND p.allocation_status IN ('CLOSED','RETURNED_TO_STOCK','DEPLETED')
             AND p.ending_balance_qty IS NOT NULL AND p.closed_at < s.created_at
           ORDER BY p.closed_at DESC LIMIT 1) AS prior_session_id,
        (SELECT p.ending_balance_qty FROM raw_bag_allocation_sessions p
           WHERE p.inventory_bag_id = s.inventory_bag_id AND p.id <> s.id
             AND p.allocation_status IN ('CLOSED','RETURNED_TO_STOCK','DEPLETED')
             AND p.ending_balance_qty IS NOT NULL AND p.closed_at < s.created_at
           ORDER BY p.closed_at DESC LIMIT 1) AS prior_ending,
        (SELECT p.allocation_status FROM raw_bag_allocation_sessions p
           WHERE p.inventory_bag_id = s.inventory_bag_id AND p.id <> s.id
             AND p.allocation_status IN ('CLOSED','RETURNED_TO_STOCK','DEPLETED')
             AND p.ending_balance_qty IS NOT NULL AND p.closed_at < s.created_at
           ORDER BY p.closed_at DESC LIMIT 1) AS prior_status
      FROM raw_bag_allocation_sessions s
    )
    SELECT session_id, inventory_bag_id, allocation_status, started_at,
           prior_session_id, prior_ending, prior_status, created_at
    FROM prior
    WHERE prior_ending IS NOT NULL
      AND started_at IS DISTINCT FROM prior_ending
    ORDER BY (allocation_status = 'OPEN') DESC, created_at DESC
  `)) as unknown as Row[];

  console.log("=== Reused-session wrong-starting-balance detector ===");
  console.log(`Suspicious sessions: ${rows.length}\n`);

  const open = rows.filter((r) => r.allocation_status === "OPEN");
  console.log(`  OPEN (active, higher severity): ${open.length}`);
  console.log(`  Non-OPEN (historical): ${rows.length - open.length}\n`);

  for (const r of rows) {
    const sev = r.allocation_status === "OPEN" ? "HIGH" : "review";
    console.log(
      `[${sev}] session ${r.session_id} (${r.allocation_status}) bag ${r.inventory_bag_id}\n` +
        `        started_at=${r.started_at} but prior ${r.prior_status} session ` +
        `${r.prior_session_id} ended at ${r.prior_ending}`,
    );
  }

  if (rows.length > 0) {
    console.log(
      "\nRemediation (DO NOT run without approval) — for an OPEN session, correct" +
        " its starting balance to the prior ending via an audited admin action, e.g.:\n" +
        "  UPDATE raw_bag_allocation_sessions SET starting_balance_qty = <prior_ending>,\n" +
        "         starting_balance_source = 'PRIOR_RETURNED_BALANCE'\n" +
        "  WHERE id = '<session_id>' AND allocation_status = 'OPEN';\n" +
        "Prefer an admin/workbench correction that writes an audit + event over raw SQL.",
    );
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
