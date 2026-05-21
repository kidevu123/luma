// QC-5 — project QC events into read models.
//
// Called from projectEvent (lib/projector/index.ts) AFTER the
// workflow_events insert lands, when the event type is one of the
// five QC types. Idempotent at the row level — repeated calls with
// the same client_event_id are caught by the upstream conflict gate
// (workflow_events_client_event_unique) and projectEvent bails
// before ever entering this projector. The SQL below assumes the
// event already exists in workflow_events.
//
// Touches:
//   - read_operator_daily   (5 QC counters, by employee_id + day)
//   - read_sku_daily        (damages / rework / scrap, by product + day)
//   - read_station_quality_daily (damaged/scrap/rework units, by
//                            machine+product+day)
//   - read_bag_state        (rework_pending / rework_received /
//                            has_correction flags)
//   - read_material_lot_state (qty_on_hand decrement, only when
//                            SCRAP_RECORDED names material_lot_id or
//                            packaging_lot_id; raw-product scrap is
//                            QC-5.1 / QC-6 — not faked here)
//
// What this projector deliberately does NOT do:
//   - Move raw-product inventory. SCRAP_RECORDED with
//     affects_raw_product=true is recorded into read models but does
//     NOT decrement inventory_bags. The reconciliation v2 page
//     surfaces "raw scrap" honestly as the count of events, not as a
//     ledger move — material-side ledger comes in a future phase.
//   - Trigger the PT-6 reconciliation v2 refresh. The v2 builder
//     reads scrap from workflow_events at refresh time (post-QC-5);
//     the reconciliation row gets a fresh scrap value the next time
//     refreshPackagingLotReconciliationV2 runs (PT-6 nightly job,
//     manual rebuild, or BAG_FINALIZED). This avoids re-running the
//     8-bucket math on every floor event.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type QcEventType =
  | "PACKAGING_DAMAGE_RETURN"
  | "REWORK_SENT"
  | "REWORK_RECEIVED"
  | "SCRAP_RECORDED"
  | "SUBMISSION_CORRECTED";

const QC_EVENT_TYPES: ReadonlySet<string> = new Set([
  "PACKAGING_DAMAGE_RETURN",
  "REWORK_SENT",
  "REWORK_RECEIVED",
  "SCRAP_RECORDED",
  "SUBMISSION_CORRECTED",
]);

export function isQcEventType(eventType: string): eventType is QcEventType {
  return QC_EVENT_TYPES.has(eventType);
}

/** Inputs needed from the event row. Caller (projectEvent) already
 *  has all of these in memory before the insert returned. */
export type QcEventProjectionInput = {
  workflowBagId: string;
  eventType: QcEventType;
  occurredAt: Date;
  /** Stable employee identity. Falsy → projector skips operator
   *  counters (no anonymous attribution). */
  employeeId: string | null;
  stationId: string | null;
  /** Full event payload — projector reads quantity / unit /
   *  reason_code / material_lot_id / packaging_lot_id /
   *  linked_event_id / received_quantity / partial /
   *  affects_raw_product / affects_packaging_material. */
  payload: Record<string, unknown>;
};

export async function projectQcEvent(
  tx: Tx,
  ev: QcEventProjectionInput,
): Promise<void> {
  const day = ev.occurredAt.toISOString().slice(0, 10);
  const payload = ev.payload ?? {};

  await updateOperatorCounters(tx, ev, day);
  await updateSkuDaily(tx, ev, day);
  await updateStationQualityDaily(tx, ev, day);

  switch (ev.eventType) {
    case "REWORK_SENT": {
      await tx.execute(sql`
        UPDATE read_bag_state
        SET rework_pending = true, updated_at = now()
        WHERE workflow_bag_id = ${ev.workflowBagId}
      `);
      break;
    }
    case "REWORK_RECEIVED": {
      await refreshReworkPendingFlag(tx, ev.workflowBagId);
      await tx.execute(sql`
        UPDATE read_bag_state
        SET rework_received = true, updated_at = now()
        WHERE workflow_bag_id = ${ev.workflowBagId}
      `);
      break;
    }
    case "SUBMISSION_CORRECTED": {
      await tx.execute(sql`
        UPDATE read_bag_state
        SET has_correction = true, updated_at = now()
        WHERE workflow_bag_id = ${ev.workflowBagId}
      `);
      break;
    }
    case "SCRAP_RECORDED": {
      await decrementMaterialLotState(tx, payload);
      break;
    }
    default:
      break;
  }
}

// ─── Operator counters ─────────────────────────────────────────────────
//
// Per (day, employee_id) row in read_operator_daily. Group by the
// ACCOUNTABLE employee, not the supervisor who entered the event.
// Skip when no employee resolved — no anonymous QC attribution.

async function updateOperatorCounters(
  tx: Tx,
  ev: QcEventProjectionInput,
  day: string,
): Promise<void> {
  if (!ev.employeeId) return;
  const counterCol = operatorCounterColumn(ev.eventType, ev.payload);
  if (!counterCol) return;
  const delta = counterCol.delta;
  await tx.execute(sql`
    INSERT INTO read_operator_daily (
      day, employee_id,
      bags_finalized, active_seconds_total, damage_count_total,
      damage_events_total, rework_sent_total, rework_received_total,
      scrap_units_total, corrections_total, updated_at
    )
    VALUES (
      ${day}, ${ev.employeeId},
      0, 0, 0,
      ${ev.eventType === "PACKAGING_DAMAGE_RETURN" ? delta : 0},
      ${ev.eventType === "REWORK_SENT" ? delta : 0},
      ${ev.eventType === "REWORK_RECEIVED" ? delta : 0},
      ${ev.eventType === "SCRAP_RECORDED" ? delta : 0},
      ${ev.eventType === "SUBMISSION_CORRECTED" ? delta : 0},
      now()
    )
    ON CONFLICT (day, employee_id) WHERE employee_id IS NOT NULL DO UPDATE SET
      ${sql.raw(counterCol.name)} = read_operator_daily.${sql.raw(counterCol.name)} + EXCLUDED.${sql.raw(counterCol.name)},
      updated_at = now()
  `);
}

/** Map (event type, payload) → which counter column to bump and by
 *  how much. SCRAP is summed by scrap_quantity (units of loss);
 *  others count event occurrences. */
function operatorCounterColumn(
  eventType: QcEventType,
  payload: Record<string, unknown>,
): { name: string; delta: number } | null {
  switch (eventType) {
    case "PACKAGING_DAMAGE_RETURN":
      return { name: "damage_events_total", delta: 1 };
    case "REWORK_SENT":
      return { name: "rework_sent_total", delta: 1 };
    case "REWORK_RECEIVED":
      return { name: "rework_received_total", delta: 1 };
    case "SCRAP_RECORDED": {
      const q = Number(payload["scrap_quantity"] ?? payload["quantity"] ?? 0);
      return { name: "scrap_units_total", delta: Number.isFinite(q) ? q : 0 };
    }
    case "SUBMISSION_CORRECTED":
      return { name: "corrections_total", delta: 1 };
    default:
      return null;
  }
}

// ─── SKU daily ──────────────────────────────────────────────────────────
//
// Looks up the bag's product and bumps the matching damages / rework
// / scrap counter on the (day, product) row. If the product is unset
// on the bag, skip — no fabrication.

async function updateSkuDaily(
  tx: Tx,
  ev: QcEventProjectionInput,
  day: string,
): Promise<void> {
  const skuCol = skuDailyCounter(ev.eventType, ev.payload);
  if (!skuCol) return;
  const productRows = (await tx.execute(sql`
    SELECT product_id::text AS pid, p.sku AS sku, p.kind::text AS kind
    FROM workflow_bags wb
    LEFT JOIN products p ON p.id = wb.product_id
    WHERE wb.id = ${ev.workflowBagId}
  `)) as unknown as Array<{ pid: string | null; sku: string | null; kind: string | null }>;
  const pid = productRows[0]?.pid ?? null;
  if (!pid) return;
  const sku = productRows[0]!.sku ?? "";
  const kind = productRows[0]!.kind ?? "";
  const delta = skuCol.delta;
  await tx.execute(sql`
    INSERT INTO read_sku_daily (
      day, product_id, product_sku, product_kind,
      tablets_consumed, bags_completed,
      displays_completed, cases_completed, bottles_completed,
      loose_cards, loose_displays,
      damages, rework, scrap,
      updated_at
    )
    VALUES (
      ${day}, ${pid}, ${sku}, ${kind},
      0, 0,
      0, 0, 0,
      0, 0,
      ${ev.eventType === "PACKAGING_DAMAGE_RETURN" ? delta : 0},
      ${ev.eventType === "REWORK_SENT" ? delta : 0},
      ${ev.eventType === "SCRAP_RECORDED" ? delta : 0},
      now()
    )
    ON CONFLICT (day, product_id) DO UPDATE SET
      ${sql.raw(skuCol.name)} = read_sku_daily.${sql.raw(skuCol.name)} + EXCLUDED.${sql.raw(skuCol.name)},
      updated_at = now()
  `);
}

function skuDailyCounter(
  eventType: QcEventType,
  payload: Record<string, unknown>,
): { name: string; delta: number } | null {
  switch (eventType) {
    case "PACKAGING_DAMAGE_RETURN": {
      const q = Number(payload["quantity"] ?? 0);
      return { name: "damages", delta: Number.isFinite(q) && q > 0 ? q : 1 };
    }
    case "REWORK_SENT": {
      const q = Number(payload["quantity"] ?? 0);
      return { name: "rework", delta: Number.isFinite(q) && q > 0 ? q : 1 };
    }
    case "SCRAP_RECORDED": {
      const q = Number(payload["scrap_quantity"] ?? payload["quantity"] ?? 0);
      return { name: "scrap", delta: Number.isFinite(q) && q > 0 ? q : 1 };
    }
    // REWORK_RECEIVED and SUBMISSION_CORRECTED don't move SKU
    // damages/rework/scrap — they're tracked at the operator level
    // and via genealogy.
    default:
      return null;
  }
}

// ─── Station quality daily ──────────────────────────────────────────────
//
// Bumps damaged/rework/scrap counters on the (day, machine, product,
// output_unit) row when the event carries a station_id (which gives
// us machine via stations.machine_id). The unit comes from the event
// payload — defaults to "cards" when missing.

async function updateStationQualityDaily(
  tx: Tx,
  ev: QcEventProjectionInput,
  day: string,
): Promise<void> {
  if (!ev.stationId) return;
  const deltas = stationQualityDeltas(ev.eventType, ev.payload);
  if (deltas == null) return;
  // Resolve machine + product via station + bag.
  const ctx = (await tx.execute(sql`
    SELECT
      s.machine_id::text AS machine_id,
      wb.product_id::text AS product_id
    FROM stations s
    CROSS JOIN workflow_bags wb
    WHERE s.id = ${ev.stationId}
      AND wb.id = ${ev.workflowBagId}
  `)) as unknown as Array<{ machine_id: string | null; product_id: string | null }>;
  const machineId = ctx[0]?.machine_id ?? null;
  const productId = ctx[0]?.product_id ?? null;
  if (!machineId || !productId) return;
  const unit = typeof ev.payload["unit"] === "string" ? (ev.payload["unit"] as string) : "cards";
  await tx.execute(sql`
    INSERT INTO read_station_quality_daily (
      day, station_id, machine_id, product_id, output_unit,
      total_units, good_units, reject_units, scrap_units,
      rework_units, damaged_units, active_minutes,
      data_confidence, updated_at
    )
    VALUES (
      ${day}, ${ev.stationId}, ${machineId}, ${productId}, ${unit},
      0, 0, ${deltas.reject}, ${deltas.scrap},
      ${deltas.rework}, ${deltas.damaged}, 0,
      'HIGH', now()
    )
    ON CONFLICT (day, machine_id, product_id, output_unit) DO UPDATE SET
      reject_units  = read_station_quality_daily.reject_units  + EXCLUDED.reject_units,
      scrap_units   = read_station_quality_daily.scrap_units   + EXCLUDED.scrap_units,
      rework_units  = read_station_quality_daily.rework_units  + EXCLUDED.rework_units,
      damaged_units = read_station_quality_daily.damaged_units + EXCLUDED.damaged_units,
      updated_at    = now()
  `);
}

function stationQualityDeltas(
  eventType: QcEventType,
  payload: Record<string, unknown>,
): { reject: number; scrap: number; rework: number; damaged: number } | null {
  const qBase = Number(payload["quantity"] ?? 0);
  const q = Number.isFinite(qBase) && qBase > 0 ? qBase : 1;
  switch (eventType) {
    case "PACKAGING_DAMAGE_RETURN":
      return { reject: q, scrap: 0, rework: 0, damaged: q };
    case "SCRAP_RECORDED": {
      const sq = Number(payload["scrap_quantity"] ?? payload["quantity"] ?? 0);
      const v = Number.isFinite(sq) && sq > 0 ? sq : 1;
      return { reject: 0, scrap: v, rework: 0, damaged: 0 };
    }
    case "REWORK_SENT":
    case "REWORK_RECEIVED": {
      const rq = Number(payload["received_quantity"] ?? payload["quantity"] ?? 0);
      const v = Number.isFinite(rq) && rq > 0 ? rq : 1;
      return { reject: 0, scrap: 0, rework: v, damaged: 0 };
    }
    default:
      return null;
  }
}

// ─── Rework pending flag refresh ────────────────────────────────────────
//
// Computes whether the bag still has any open REWORK_SENT (sent
// quantity > sum of linked REWORK_RECEIVED.received_quantity). If
// nothing open, clear rework_pending.

async function refreshReworkPendingFlag(
  tx: Tx,
  workflowBagId: string,
): Promise<void> {
  const stillOpen = (await tx.execute(sql`
    WITH sent AS (
      SELECT id::text AS sent_id,
             COALESCE((payload->>'quantity')::int, 0) AS sent_qty
      FROM workflow_events
      WHERE workflow_bag_id = ${workflowBagId}
        AND event_type = 'REWORK_SENT'
    ),
    received AS (
      SELECT payload->>'linked_event_id' AS sent_id,
             SUM(COALESCE((payload->>'received_quantity')::int, 0)) AS rec_qty
      FROM workflow_events
      WHERE workflow_bag_id = ${workflowBagId}
        AND event_type = 'REWORK_RECEIVED'
        AND payload ? 'linked_event_id'
      GROUP BY payload->>'linked_event_id'
    )
    SELECT 1
    FROM sent s
    LEFT JOIN received r ON r.sent_id = s.sent_id
    WHERE COALESCE(r.rec_qty, 0) < s.sent_qty
    LIMIT 1
  `)) as unknown as Array<unknown>;
  const open = stillOpen.length > 0;
  await tx.execute(sql`
    UPDATE read_bag_state
    SET rework_pending = ${open}, updated_at = now()
    WHERE workflow_bag_id = ${workflowBagId}
  `);
}

// ─── Material lot state decrement ───────────────────────────────────────
//
// Only fires when SCRAP_RECORDED names a material_lot_id or
// packaging_lot_id. Decrements qty_on_hand by the smaller of the
// scrap quantity and the current on-hand value (floor at 0). Skip
// when no scope is named — raw-product scrap stays in workflow_events
// as a signal but is NOT materialised as a lot-state delta here.

async function decrementMaterialLotState(
  tx: Tx,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!payload["affects_packaging_material"]) return;
  const lotId =
    (typeof payload["material_lot_id"] === "string"
      ? (payload["material_lot_id"] as string)
      : null) ??
    (typeof payload["packaging_lot_id"] === "string"
      ? (payload["packaging_lot_id"] as string)
      : null);
  if (!lotId) return;
  const q = Number(payload["scrap_quantity"] ?? payload["quantity"] ?? 0);
  if (!Number.isFinite(q) || q <= 0) return;
  await tx.execute(sql`
    UPDATE read_material_lot_state
    SET qty_on_hand = GREATEST(qty_on_hand - ${q}, 0),
        confidence = CASE
          WHEN confidence = 'HIGH' THEN 'MEDIUM'
          ELSE confidence
        END,
        updated_at = now()
    WHERE packaging_lot_id = ${lotId}
  `);
}
