// PACKAGING-RECONCILIATION-SLICE-A — pure attribution planning helper.
// No DB imports, no side effects. Takes pending estimated events and a
// received lot, returns an attribution plan (FIFO, material-scoped,
// quantity-capped, partial splits supported).

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
