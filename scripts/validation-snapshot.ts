// VALIDATION-2B — Read-only validation snapshot.
//
// Prints the current state every QA auditor needs after a human
// performs a step in the manual test packet. Strictly read-only —
// no INSERT, UPDATE, DELETE. Refuses production unless
// ALLOW_STAGING_QA_DATA=true.
//
// Usage (local or inside container):
//   ALLOW_STAGING_QA_DATA=true npm run validation:snapshot
//
// Output is structured so a diff between two runs makes the change
// obvious:
//
//   ── Roll lots ──
//   ── Material events ──
//   ── Active rolls ──
//   ── Read models ──
//   ── Allocation sessions ──
//   ── Allocation events ──
//   ── Variety pack ──
//   ── PO reconciliation summary ──
//   ── Pass/fail hints ──
//
// Each section ends with a "hint" line indicating the expected
// state for the current test step (NOT_STARTED / READY / PASS /
// FAIL / BLOCKED), based on whether the obvious counters look
// reasonable for a given test position.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  reconcileBagTotal,
  formatBagTotalLine,
} from "@/lib/production/snapshot-helpers";

function refuseInProduction() {
  const envSaysProd = process.env.NODE_ENV === "production";
  const allow = process.env.ALLOW_STAGING_QA_DATA === "true";
  if (envSaysProd && !allow) {
    console.error(
      "[validation-snapshot] Refusing to run: NODE_ENV=production and ALLOW_STAGING_QA_DATA != true.",
    );
    process.exit(2);
  }
}

async function main() {
  refuseInProduction();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  const stamp = new Date().toISOString();
  console.log(`════════════════════════════════════════════════════════`);
  console.log(`  VALIDATION SNAPSHOT — ${stamp}`);
  console.log(`════════════════════════════════════════════════════════`);

  // ── Roll lots ──
  type RollLotRow = {
    roll_number: string | null;
    material_kind: string;
    status: string;
    net_weight_grams: number | null;
    current_weight_grams_estimate: number | null;
  };
  const rollLots = (await db.execute<RollLotRow>(sql`
    SELECT pl.roll_number, pm.kind::text AS material_kind, pl.status::text AS status,
           pl.net_weight_grams, pl.current_weight_grams_estimate
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    WHERE pm.sku LIKE 'QA_TEST_%' OR pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    ORDER BY pm.kind, pl.roll_number
  `)) as unknown as RollLotRow[];
  section("Roll lots", () => {
    if (rollLots.length === 0) {
      console.log("  (no roll lots)");
    } else {
      for (const r of rollLots) {
        console.log(
          `  ${(r.roll_number ?? "—").padEnd(28)} ${r.material_kind.padEnd(14)} ${r.status.padEnd(10)} ` +
            `net=${String(r.net_weight_grams ?? "—").padStart(6)}g  ` +
            `est=${String(r.current_weight_grams_estimate ?? "—").padStart(6)}g`,
        );
      }
    }
  });

  // ── Material events ──
  type EventCountRow = { event_type: string; n: number };
  const matEvents = (await db.execute<EventCountRow>(sql`
    SELECT event_type::text AS event_type, COUNT(*)::int AS n
    FROM material_inventory_events
    GROUP BY event_type
    ORDER BY event_type
  `)) as unknown as EventCountRow[];
  section("Material events", () => {
    if (matEvents.length === 0) {
      console.log("  (no events)");
    } else {
      for (const e of matEvents) {
        console.log(`  ${e.event_type.padEnd(34)} ${String(e.n).padStart(5)}`);
      }
    }
  });

  // ── Active rolls (per machine) ──
  type ActiveRollRow = {
    machine_name: string | null;
    role: string | null;
    roll_number: string | null;
    starting_weight_grams: number | null;
    blisters_produced: number | null;
    confidence: string;
  };
  const activeRolls = (await db.execute<ActiveRollRow>(sql`
    SELECT m.name AS machine_name, rru.material_role AS role,
           rru.roll_number, rru.starting_weight_grams,
           rru.blisters_produced, rru.confidence
    FROM read_roll_usage rru
    LEFT JOIN machines m ON m.id = rru.machine_id
    WHERE rru.mounted_at IS NOT NULL AND rru.unmounted_at IS NULL
    ORDER BY m.name, rru.material_role
  `)) as unknown as ActiveRollRow[];
  section("Active rolls (per machine)", () => {
    if (activeRolls.length === 0) {
      console.log("  (no active rolls mounted)");
    } else {
      for (const r of activeRolls) {
        console.log(
          `  ${(r.machine_name ?? "—").padEnd(20)} ${(r.role ?? "—").padEnd(6)} ` +
            `${(r.roll_number ?? "—").padEnd(28)} ` +
            `start=${String(r.starting_weight_grams ?? "—").padStart(6)}g  ` +
            `yield=${String(r.blisters_produced ?? 0).padStart(6)}  ` +
            `conf=${r.confidence}`,
        );
      }
    }
  });

  // ── Roll segment ledger (VALIDATION-2C primary signal) ──
  type SegmentByRollRow = {
    roll_number: string | null;
    role: string | null;
    status: string;
    net_weight_grams: number | null;
    segments: number;
    yield_blisters: number;
    g_per_blister: string | null;
  };
  const segByRoll = (await db.execute<SegmentByRollRow>(sql`
    SELECT
      pl.roll_number,
      (CASE pm.kind::text
        WHEN 'PVC_ROLL' THEN 'PVC'
        WHEN 'FOIL_ROLL' THEN 'FOIL'
        WHEN 'BLISTER_FOIL' THEN 'FOIL'
       END) AS role,
      pl.status::text AS status,
      pl.net_weight_grams,
      COUNT(ev.id)::int AS segments,
      COALESCE(SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int), 0)::int AS yield_blisters,
      CASE
        WHEN pl.status = 'DEPLETED'
             AND pl.net_weight_grams IS NOT NULL
             AND COALESCE(SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int), 0) > 0
          THEN ROUND(
            pl.net_weight_grams::numeric /
            COALESCE(SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int), 0)::numeric,
            5
          )::text
        ELSE NULL
      END AS g_per_blister
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN material_inventory_events ev
      ON ev.packaging_lot_id = pl.id
     AND ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
    WHERE pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    GROUP BY pl.id, pl.roll_number, pm.kind, pl.status, pl.net_weight_grams
    ORDER BY pm.kind, pl.roll_number
  `)) as unknown as SegmentByRollRow[];
  section("Roll yield from segments (primary signal)", () => {
    if (segByRoll.length === 0) {
      console.log("  (no roll lots)");
    } else {
      for (const r of segByRoll) {
        console.log(
          `  ${(r.roll_number ?? "—").padEnd(28)} ${(r.role ?? "—").padEnd(6)} ${r.status.padEnd(10)} ` +
            `net=${String(r.net_weight_grams ?? "—").padStart(6)}g  ` +
            `segments=${String(r.segments).padStart(3)}  ` +
            `yield=${String(r.yield_blisters).padStart(8)} blisters` +
            (r.g_per_blister != null ? `  g/blister=${r.g_per_blister}` : ""),
        );
      }
    }
  });

  // ── Roll segments by bag ──
  // Bag total = matched PVC/FOIL segment sum (both rolls advance
  // through the same blister cycles, so the totals MUST be equal).
  // We compute pvc_total + foil_total in SQL, then reconcile in TS
  // so the logic is unit-testable. The previous SUM/DISTINCT-lot
  // formula coincidentally worked for single-roll bags but broke
  // for any bag with a mid-bag roll change (yielded SUM/3 etc).
  type SegmentByBagRow = {
    workflow_bag_id: string | null;
    segment_count: number;
    pvc_total: number;
    foil_total: number;
  };
  const segByBag = (await db.execute<SegmentByBagRow>(sql`
    SELECT
      ev.workflow_bag_id::text AS workflow_bag_id,
      COUNT(*)::int                                                                              AS segment_count,
      SUM(CASE WHEN (ev.payload->>'roll_role') = 'PVC'
               THEN NULLIF((ev.payload->>'counter_segment_count'),'')::int ELSE 0 END)::int      AS pvc_total,
      SUM(CASE WHEN (ev.payload->>'roll_role') = 'FOIL'
               THEN NULLIF((ev.payload->>'counter_segment_count'),'')::int ELSE 0 END)::int      AS foil_total
    FROM material_inventory_events ev
    WHERE ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      AND ev.workflow_bag_id IS NOT NULL
    GROUP BY ev.workflow_bag_id
    ORDER BY MIN(ev.occurred_at)
  `)) as unknown as SegmentByBagRow[];
  section("Bag totals from segments", () => {
    if (segByBag.length === 0) {
      console.log("  (no bag segments yet)");
    } else {
      for (const b of segByBag) {
        const display = reconcileBagTotal(b);
        console.log(formatBagTotalLine(display));
      }
    }
  });

  // ── Read models ──
  type CountRow = { table_name: string; n: number };
  const readModels = (await db.execute<CountRow>(sql`
    SELECT 'read_material_lot_state' AS table_name, COUNT(*)::int AS n FROM read_material_lot_state
    UNION ALL SELECT 'read_roll_usage', COUNT(*)::int FROM read_roll_usage
    UNION ALL SELECT 'read_material_consumption_daily', COUNT(*)::int FROM read_material_consumption_daily
    UNION ALL SELECT 'read_material_usage_learning', COUNT(*)::int FROM read_material_usage_learning
    UNION ALL SELECT 'read_queue_state', COUNT(*)::int FROM read_queue_state
    UNION ALL SELECT 'read_sku_daily', COUNT(*)::int FROM read_sku_daily
    UNION ALL SELECT 'read_material_reconciliation', COUNT(*)::int FROM read_material_reconciliation
  `)) as unknown as CountRow[];
  section("Read models", () => {
    for (const r of readModels) {
      console.log(`  ${r.table_name.padEnd(36)} ${String(r.n).padStart(5)}`);
    }
  });

  // ── Allocation sessions ──
  type SessionRow = {
    status: string;
    n: number;
  };
  const sessions = (await db.execute<SessionRow>(sql`
    SELECT allocation_status AS status, COUNT(*)::int AS n
    FROM raw_bag_allocation_sessions
    GROUP BY allocation_status
    ORDER BY allocation_status
  `)) as unknown as SessionRow[];
  section("Allocation sessions (by status)", () => {
    if (sessions.length === 0) {
      console.log("  (no sessions)");
    } else {
      for (const s of sessions) {
        console.log(`  ${s.status.padEnd(20)} ${String(s.n).padStart(5)}`);
      }
    }
  });

  // ── Allocation events ──
  type AllocEventRow = { event_type: string; n: number };
  const allocEvents = (await db.execute<AllocEventRow>(sql`
    SELECT event_type, COUNT(*)::int AS n
    FROM raw_bag_allocation_events
    GROUP BY event_type
    ORDER BY event_type
  `)) as unknown as AllocEventRow[];
  section("Allocation events (by type)", () => {
    if (allocEvents.length === 0) {
      console.log("  (no events)");
    } else {
      for (const e of allocEvents) {
        console.log(`  ${e.event_type.padEnd(34)} ${String(e.n).padStart(5)}`);
      }
    }
  });

  // ── Inventory bags by status ──
  type BagStatusRow = { status: string; n: number; qa: number };
  const bagStatus = (await db.execute<BagStatusRow>(sql`
    SELECT
      ib.status::text AS status,
      COUNT(*)::int   AS n,
      COUNT(*) FILTER (WHERE po.po_number LIKE 'QA_TEST_%')::int AS qa
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives r ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    GROUP BY ib.status
    ORDER BY ib.status
  `)) as unknown as BagStatusRow[];
  section("Inventory bags (status / QA)", () => {
    for (const b of bagStatus) {
      console.log(`  ${b.status.padEnd(20)} total=${String(b.n).padStart(5)}   qa=${String(b.qa).padStart(3)}`);
    }
  });

  // ── Variety pack ──
  type VarietyRow = {
    product_sku: string;
    component_count: number;
    open_sessions: number;
    closed_sessions: number;
    consumption_events: number;
  };
  const variety = (await db.execute<VarietyRow>(sql`
    SELECT
      p.sku AS product_sku,
      COUNT(DISTINCT pcr.id)::int AS component_count,
      COUNT(DISTINCT s.id) FILTER (WHERE s.allocation_status = 'OPEN')::int AS open_sessions,
      COUNT(DISTINCT s.id) FILTER (WHERE s.allocation_status IN ('CLOSED','DEPLETED'))::int AS closed_sessions,
      COUNT(DISTINCT e.id) FILTER (WHERE e.event_type = 'RAW_BAG_PARTIAL_CONSUMED')::int AS consumption_events
    FROM products p
    JOIN product_component_requirements pcr ON pcr.product_id = p.id AND pcr.is_active = true
    LEFT JOIN raw_bag_allocation_sessions s ON s.product_id = p.id
    LEFT JOIN raw_bag_allocation_events e ON e.product_id = p.id
    GROUP BY p.id, p.sku
    ORDER BY p.sku
  `)) as unknown as VarietyRow[];
  section("Variety pack products", () => {
    if (variety.length === 0) {
      console.log("  (no products with component requirements)");
    } else {
      for (const v of variety) {
        console.log(
          `  ${v.product_sku.padEnd(28)} components=${v.component_count}  ` +
            `open=${v.open_sessions}  closed=${v.closed_sessions}  consume=${v.consumption_events}`,
        );
      }
    }
  });

  // ── PO reconciliation summary (for QA POs) ──
  type PoSummaryRow = {
    po_number: string;
    bags_received: number;
    vendor_total: number | null;
    received_weight_total: number | null;
    finished_lots: number;
    open_sessions: number;
    closed_sessions: number;
  };
  const poSummary = (await db.execute<PoSummaryRow>(sql`
    SELECT
      po.po_number,
      COUNT(DISTINCT ib.id)::int                  AS bags_received,
      SUM(ib.pill_count)::int                      AS vendor_total,
      SUM(ib.weight_grams)::int                    AS received_weight_total,
      COUNT(DISTINCT fl.id)::int                   AS finished_lots,
      COUNT(DISTINCT s.id) FILTER (WHERE s.allocation_status = 'OPEN')::int    AS open_sessions,
      COUNT(DISTINCT s.id) FILTER (WHERE s.allocation_status IN ('CLOSED','DEPLETED','RETURNED_TO_STOCK'))::int AS closed_sessions
    FROM purchase_orders po
    LEFT JOIN receives r ON r.po_id = po.id
    LEFT JOIN small_boxes sb ON sb.receive_id = r.id
    LEFT JOIN inventory_bags ib ON ib.small_box_id = sb.id
    LEFT JOIN finished_lot_inputs fli ON fli.batch_id = ib.batch_id
    LEFT JOIN finished_lots fl ON fl.id = fli.finished_lot_id
    LEFT JOIN raw_bag_allocation_sessions s ON s.po_id = po.id
    WHERE po.po_number LIKE 'QA_TEST_%'
    GROUP BY po.po_number
    ORDER BY po.po_number
  `)) as unknown as PoSummaryRow[];
  section("PO reconciliation summary (QA POs)", () => {
    if (poSummary.length === 0) {
      console.log("  (no QA POs)");
    } else {
      for (const p of poSummary) {
        console.log(
          `  ${p.po_number.padEnd(28)} bags=${p.bags_received}  ` +
            `vendor=${p.vendor_total ?? "—"}  weight=${p.received_weight_total ?? "—"}g  ` +
            `lots=${p.finished_lots}  open=${p.open_sessions}  closed=${p.closed_sessions}`,
        );
      }
    }
  });

  // ── Stations / token state ──
  type StationRow = { uuid_count: number; legacy_count: number };
  const stationsRow = (await db.execute<StationRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE scan_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::int AS uuid_count,
      COUNT(*) FILTER (WHERE scan_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::int AS legacy_count
    FROM stations WHERE is_active = true
  `)) as unknown as StationRow[];
  section("Station tokens", () => {
    const s = stationsRow[0]!;
    console.log(`  UUID format     ${String(s.uuid_count).padStart(3)}`);
    console.log(`  Legacy format   ${String(s.legacy_count).padStart(3)}   (must be 0 for floor mutations)`);
  });

  // ── Pass / fail hints ──
  type Hint = { label: string; pass: boolean | null; note: string };
  const hints: Hint[] = [];
  // Token gate
  hints.push({
    label: "Floor mutation token gate",
    pass: stationsRow[0]!.legacy_count === 0,
    note:
      stationsRow[0]!.legacy_count === 0
        ? "All stations on UUID tokens"
        : `${stationsRow[0]!.legacy_count} station(s) still on legacy tokens — rotate before mutation tests`,
  });
  // QA prereqs
  const qaPos = poSummary.length;
  hints.push({
    label: "QA PO present",
    pass: qaPos >= 1,
    note: qaPos >= 1 ? `${qaPos} QA PO(s) seeded` : "No QA PO — run staging:seed",
  });
  // ROLL_MOUNTED count vs active rolls
  const rollMountedCount = matEvents.find((e) => e.event_type === "ROLL_MOUNTED")?.n ?? 0;
  const rollUnmountedCount = matEvents.find((e) => e.event_type === "ROLL_UNMOUNTED")?.n ?? 0;
  const expectedActive = Math.max(0, rollMountedCount - rollUnmountedCount);
  hints.push({
    label: "Active roll count matches mount/unmount delta",
    pass: activeRolls.length === expectedActive,
    note: `active=${activeRolls.length}  mounted-unmounted=${expectedActive}`,
  });
  // Segment ledger primary signal (VALIDATION-2C).
  const segmentEvents = matEvents.find((e) => e.event_type === "ROLL_COUNTER_SEGMENT_RECORDED")?.n ?? 0;
  hints.push({
    label: "Roll yield = sum of ROLL_COUNTER_SEGMENT_RECORDED (primary signal)",
    pass: rollMountedCount === 0 ? segmentEvents === 0 : null,
    note:
      rollMountedCount === 0 && segmentEvents > 0
        ? `WARN: ${segmentEvents} segment events with no ROLL_MOUNTED — INVESTIGATE`
        : `segments=${segmentEvents}  active_rolls=${activeRolls.length}`,
  });
  // No MATERIAL_CONSUMED_ACTUAL (segment ledger never auto-emits this).
  const consumedActual = matEvents.find((e) => e.event_type === "MATERIAL_CONSUMED_ACTUAL")?.n ?? 0;
  hints.push({
    label: "MATERIAL_CONSUMED_ACTUAL not emitted automatically",
    pass: consumedActual === 0,
    note: consumedActual === 0 ? "0 ACTUAL events" : `WARN: ${consumedActual} ACTUAL events present`,
  });
  // MATERIAL_CONSUMED_ESTIMATED is now legacy — info only.
  const consumedEstimated = matEvents.find((e) => e.event_type === "MATERIAL_CONSUMED_ESTIMATED")?.n ?? 0;
  hints.push({
    label: "MATERIAL_CONSUMED_ESTIMATED (legacy / pre-2C — not the primary signal)",
    pass: null,
    note: consumedEstimated === 0
      ? "0 (expected post-2C; segments are the primary signal)"
      : `${consumedEstimated} legacy events present (informational only)`,
  });
  // Each active roll yield matches sum of its segments.
  const yieldMismatchRows = (await db.execute<{ roll_number: string | null; expected: number; actual: number | null }>(sql`
    SELECT
      pl.roll_number,
      COALESCE(SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int), 0)::int AS expected,
      MAX(rru.blisters_produced) AS actual
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN material_inventory_events ev
      ON ev.packaging_lot_id = pl.id
     AND ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
    LEFT JOIN read_roll_usage rru ON rru.packaging_lot_id = pl.id
    WHERE pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    GROUP BY pl.id, pl.roll_number
    HAVING COALESCE(SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int), 0)::int <> COALESCE(MAX(rru.blisters_produced), 0)::int
  `)) as unknown as Array<{ roll_number: string | null; expected: number; actual: number | null }>;
  hints.push({
    label: "read_roll_usage.blisters_produced equals SUM(segments) per roll",
    pass: yieldMismatchRows.length === 0,
    note:
      yieldMismatchRows.length === 0
        ? "All rolls reconcile (consider running rebuild:read-models if a mismatch is suspected)"
        : `WARN: ${yieldMismatchRows.length} roll(s) mismatch — re-run rebuild:read-models`,
  });
  // Depleted rolls with net_weight + yield should derive grams/blister.
  type DepletedRow = { has_gpb: number; missing_gpb: number };
  const depletedDeriveRows = (await db.execute<DepletedRow>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE pl.net_weight_grams IS NOT NULL
          AND COALESCE(seg.total, 0) > 0
      )::int AS has_gpb,
      COUNT(*) FILTER (
        WHERE pl.net_weight_grams IS NULL
           OR COALESCE(seg.total, 0) = 0
      )::int AS missing_gpb
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN (
      SELECT packaging_lot_id, SUM(NULLIF((payload->>'counter_segment_count'),'')::int) AS total
      FROM material_inventory_events
      WHERE event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
      GROUP BY packaging_lot_id
    ) seg ON seg.packaging_lot_id = pl.id
    WHERE pl.status = 'DEPLETED'
      AND pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
  `)) as unknown as DepletedRow[];
  const dr = depletedDeriveRows[0] ?? { has_gpb: 0, missing_gpb: 0 };
  hints.push({
    label: "Depleted rolls derive grams/blister from net_weight + segments",
    pass: dr.missing_gpb === 0 ? null : false,
    note:
      dr.has_gpb + dr.missing_gpb === 0
        ? "(no depleted rolls yet)"
        : `derivable=${dr.has_gpb}  missing_inputs=${dr.missing_gpb}`,
  });
  // No bag double-OPEN
  type BagOpenRow = { inventory_bag_id: string; n: number };
  const doubleOpens = (await db.execute<BagOpenRow>(sql`
    SELECT inventory_bag_id::text, COUNT(*)::int AS n
    FROM raw_bag_allocation_sessions
    WHERE allocation_status = 'OPEN'
    GROUP BY inventory_bag_id
    HAVING COUNT(*) > 1
  `)) as unknown as BagOpenRow[];
  hints.push({
    label: "One OPEN session per bag (DB-enforced partial unique)",
    pass: doubleOpens.length === 0,
    note: doubleOpens.length === 0
      ? "No bag has > 1 OPEN session"
      : `WARN: ${doubleOpens.length} bag(s) have > 1 OPEN session — UNIQUE INDEX VIOLATED`,
  });

  section("Pass / fail hints", () => {
    for (const h of hints) {
      const tag = h.pass === null ? "INFO" : h.pass ? "PASS" : "WARN";
      console.log(`  ${tag}  ${h.label.padEnd(60)} ${h.note}`);
    }
  });

  console.log("");
  await client.end();
}

function section(title: string, body: () => void): void {
  console.log("");
  console.log(`── ${title} ──`);
  body();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
