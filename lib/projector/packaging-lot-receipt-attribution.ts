// PACKAGING-RECONCILIATION-SLICE-A — pure attribution planning helper.
// No DB imports, no side effects. Takes pending estimated events and a
// received lot, returns an attribution plan (FIFO, material-scoped,
// quantity-capped, partial splits supported).

// PACKAGING-RECONCILIATION-SLICE-B — DB loader + write helper added below.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { materialInventoryEvents } from "@/lib/db/schema";

/** Accept both a transaction and the top-level db object. */
type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type PendingEstimatedEvent = {
  id: string;
  packagingMaterialId: string;
  qtyConsumed: number; // integer, positive
  occurredAt: Date;
};

export type ReceivedLot = {
  id: string;
  packagingMaterialId: string;
  qtyAvailableToAttribute: number; // integer, positive
};

export type AttributionPlanRow = {
  sourceEstimatedEventId: string;
  packagingLotId: string;
  packagingMaterialId: string;
  qtyToAttribute: number; // integer > 0
  fullyAttributed: boolean; // true if entire qtyConsumed is covered
  remainingPendingQty: number; // qtyConsumed - qtyToAttribute (>=0)
};

export type AttributionPlan = {
  rows: AttributionPlanRow[];
  remainingLotQty: number; // how much of the lot was NOT used
  skipped: Array<{ eventId: string; reason: string }>; // events not attributed
};

/**
 * Plan how pending estimated consumption events should be attributed to a
 * newly received packaging lot.
 *
 * Rules (in order):
 * 1. Material filter: events for a different material are skipped with
 *    reason "material_mismatch".
 * 2. Guard — zero/negative lot qty: returns empty plan immediately
 *    (nothing attributed, nothing skipped).
 * 3. Guard — invalid event qty: events with qtyConsumed <= 0 are skipped
 *    with reason "invalid_qty".
 * 4. FIFO sort: eligible events sorted by occurredAt ASC, tie-break id ASC.
 * 5. Greedy attribution: walk FIFO-sorted events. When lot is exhausted,
 *    remaining events go to skipped with reason "lot_exhausted".
 *
 * // TODO(PACKAGING-RECONCILIATION-SLICE-B): source-system guard
 * The PM needs to decide whether PackTrack lots should only be attributed to
 * PackTrack-sourced events. Do not implement this now.
 */
export function planPendingConsumptionAttribution(
  pendingEvents: PendingEstimatedEvent[],
  receivedLot: ReceivedLot,
): AttributionPlan {
  // Guard: zero/negative lot qty — return empty plan immediately.
  // Note: no events are added to skipped per spec rule 2.
  if (receivedLot.qtyAvailableToAttribute <= 0) {
    return { rows: [], remainingLotQty: 0, skipped: [] };
  }

  const rows: AttributionPlanRow[] = [];
  const skipped: Array<{ eventId: string; reason: string }> = [];

  // Step 1: separate material-mismatched events first.
  const materialMatched: PendingEstimatedEvent[] = [];
  for (const event of pendingEvents) {
    if (event.packagingMaterialId !== receivedLot.packagingMaterialId) {
      skipped.push({ eventId: event.id, reason: "material_mismatch" });
    } else {
      materialMatched.push(event);
    }
  }

  // Step 2: separate invalid qty events.
  const eligible: PendingEstimatedEvent[] = [];
  for (const event of materialMatched) {
    if (event.qtyConsumed <= 0) {
      skipped.push({ eventId: event.id, reason: "invalid_qty" });
    } else {
      eligible.push(event);
    }
  }

  // Step 3: FIFO sort — occurredAt ASC, tie-break id ASC (lexicographic).
  eligible.sort((a, b) => {
    const timeDiff = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Step 4: greedy attribution loop.
  let remainingLotQty = receivedLot.qtyAvailableToAttribute;

  for (const event of eligible) {
    if (remainingLotQty === 0) {
      skipped.push({ eventId: event.id, reason: "lot_exhausted" });
      continue;
    }

    const qtyToAttribute = Math.min(event.qtyConsumed, remainingLotQty);
    remainingLotQty -= qtyToAttribute;

    rows.push({
      sourceEstimatedEventId: event.id,
      packagingLotId: receivedLot.id,
      packagingMaterialId: event.packagingMaterialId,
      qtyToAttribute,
      fullyAttributed: qtyToAttribute === event.qtyConsumed,
      remainingPendingQty: event.qtyConsumed - qtyToAttribute,
    });
  }

  return { rows, remainingLotQty, skipped };
}

// ─── PACKAGING-RECONCILIATION-SLICE-B — DB loader + write helper ─────────────

/**
 * Load pending MATERIAL_CONSUMED_ESTIMATED events for a packaging material,
 * subtracting prior MATERIAL_ESTIMATED_VOIDED quantities so each row
 * reflects remaining unattributed qty. Returns FIFO-sorted rows with
 * remaining_pending_qty > 0 only.
 *
 * NOTE: id is returned as string (bigint → string) for planner compatibility.
 * SQL ORDER BY (occurred_at ASC, id ASC) is authoritative — do not re-sort
 * by string id in JS (lexicographic sort is wrong for multi-digit bigints).
 */
export async function loadPendingEstimatedEventsForAttribution(
  tx: Tx,
  packagingMaterialId: string,
): Promise<PendingEstimatedEvent[]> {
  const rows = await tx.execute(sql`
    WITH voided_sums AS (
      SELECT
        (v.payload->>'source_estimated_event_id')::bigint AS source_id,
        COALESCE(SUM(v.quantity_units), 0)::int           AS voided_qty
      FROM material_inventory_events v
      WHERE v.event_type = 'MATERIAL_ESTIMATED_VOIDED'
        AND v.payload->>'source_estimated_event_id' IS NOT NULL
        AND v.packaging_material_id = ${packagingMaterialId}::uuid
      GROUP BY source_id
    )
    SELECT
      ev.id::text                                                         AS id,
      ev.packaging_material_id::text                                      AS packaging_material_id,
      (COALESCE(ev.quantity_units, 0)
         - COALESCE(vs.voided_qty, 0))::int                              AS qty_consumed,
      ev.occurred_at                                                      AS occurred_at
    FROM material_inventory_events ev
    LEFT JOIN voided_sums vs ON vs.source_id = ev.id
    WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
      AND ev.packaging_lot_id IS NULL
      AND ev.packaging_material_id = ${packagingMaterialId}::uuid
      AND (COALESCE(ev.quantity_units, 0) - COALESCE(vs.voided_qty, 0)) > 0
    ORDER BY ev.occurred_at ASC, ev.id ASC
  `);

  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    packagingMaterialId: String(r.packaging_material_id),
    qtyConsumed: Number(r.qty_consumed),
    occurredAt:
      r.occurred_at instanceof Date
        ? r.occurred_at
        : new Date(String(r.occurred_at)),
  }));
}

export type AttributionContext = {
  /** The newly received packaging lot id */
  lotId: string;
  /** packaging_material_id of the lot (uuid string) */
  packagingMaterialId: string;
  /** qty_on_hand of the new lot — used as available qty for attribution */
  qtyAvailable: number;
  /** The admin user performing the receipt */
  actorUserId: string | null;
};

/**
 * Load pending estimated events, compute an attribution plan, and write
 * MATERIAL_CONSUMED_ACTUAL + MATERIAL_ESTIMATED_VOIDED pairs for each
 * plan row. All writes happen inside the caller's transaction.
 *
 * Idempotent: the unique index on MATERIAL_ESTIMATED_VOIDED
 * (payload->>'source_estimated_event_id') prevents double-voiding on retry.
 * Uses onConflictDoNothing so retries succeed silently.
 *
 * Returns: number of plan rows written (0 = no pending events, receipt still succeeds).
 */
export async function applyReceiptAttribution(
  tx: Tx,
  ctx: AttributionContext,
): Promise<number> {
  if (ctx.qtyAvailable <= 0) return 0;

  const pendingEvents = await loadPendingEstimatedEventsForAttribution(
    tx,
    ctx.packagingMaterialId,
  );

  if (pendingEvents.length === 0) return 0;

  const plan = planPendingConsumptionAttribution(pendingEvents, {
    id: ctx.lotId,
    packagingMaterialId: ctx.packagingMaterialId,
    qtyAvailableToAttribute: ctx.qtyAvailable,
  });

  if (plan.rows.length === 0) return 0;

  const now = new Date();

  for (const row of plan.rows) {
    // MATERIAL_CONSUMED_ACTUAL — the attributed quantity linked to the new lot
    await tx
      .insert(materialInventoryEvents)
      .values({
        eventType: "MATERIAL_CONSUMED_ACTUAL",
        packagingMaterialId: row.packagingMaterialId,
        packagingLotId: row.packagingLotId,
        quantityUnits: row.qtyToAttribute,
        occurredAt: now,
        actorUserId: ctx.actorUserId,
        source: "admin.receive_packaging.attribution",
        payload: {
          source_estimated_event_id: row.sourceEstimatedEventId,
          attribution_lot_id: row.packagingLotId,
          attribution_source: "receipt_attribution",
          fully_attributed: row.fullyAttributed,
          qty_to_attribute: row.qtyToAttribute,
          remaining_pending_qty: row.remainingPendingQty,
        },
      })
      .onConflictDoNothing();

    // MATERIAL_ESTIMATED_VOIDED — marks this portion as attributed; idempotency key
    await tx
      .insert(materialInventoryEvents)
      .values({
        eventType: "MATERIAL_ESTIMATED_VOIDED",
        packagingMaterialId: row.packagingMaterialId,
        packagingLotId: row.packagingLotId,
        quantityUnits: row.qtyToAttribute,
        occurredAt: now,
        actorUserId: ctx.actorUserId,
        source: "admin.receive_packaging.attribution",
        payload: {
          source_estimated_event_id: row.sourceEstimatedEventId, // ← idempotency key
          attribution_lot_id: row.packagingLotId,
          attribution_source: "receipt_attribution",
          fully_attributed: row.fullyAttributed,
          voided_qty: row.qtyToAttribute,
          remaining_pending_qty: row.remainingPendingQty,
        },
      })
      .onConflictDoNothing(); // idempotency index on (payload->>'source_estimated_event_id') WHERE event_type='MATERIAL_ESTIMATED_VOIDED'
  }

  return plan.rows.length;
}
