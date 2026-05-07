// Phase C — read_material_reconciliation projector.
//
// Per-bag pill-count audit, populated at BAG_FINALIZED time:
//
//   variance = received - consumed - scrap - remaining
//
// Today the floor records:
//   • received_qty  → inventory_bags.pill_count (HIGH confidence)
//   • finished_qty  → read_bag_metrics.units_yielded (HIGH if recorded)
//   • damaged       → read_bag_metrics.damaged_packaging + ripped_cards
//   • consumed_qty  → INFERRED as received - finished - damaged
//                     (no direct counter for "consumed but not yet
//                     finished"; bags are audited at BAG_FINALIZED so
//                     leftover ≈ remaining)
//   • scrap_qty     → 0 until SCRAP_RECORDED events emit (Phase C5+)
//   • remaining_qty → unknown until a final inventory event fires;
//                     for finalised bags we mark this missing
//
// Confidence rules:
//   HIGH    — received + finished + damages all present, scrap zero,
//             variance ≤ 1% of received (counter-typo tolerance)
//   MEDIUM  — received + finished present, damages present, variance
//             between 1% and 5%
//   LOW     — any input inferred (consumed/remaining/scrap)
//   MISSING — received_qty is null
//
// We also record `is_estimated = true` whenever any input was
// inferred — the UI relies on this to label rows.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Pure helper exported for tests. Returns the reconciliation
 *  shape the projector would write, given the raw inputs. The
 *  `consumed` field is reserved for a future MATERIAL_CONSUMED
 *  event emission (not wired yet); when null the helper treats
 *  consumed as inferred. */
export function reconcileBag(input: {
  received: number | null;
  finished: number | null;
  damaged: number | null;
  scrap: number | null;
  remaining: number | null;
  consumed?: number | null;
}): {
  receivedQty: number | null;
  consumedQty: number | null;
  finishedQty: number | null;
  scrapQty: number | null;
  remainingQty: number | null;
  varianceQty: number | null;
  variancePct: number | null;
  isEstimated: boolean;
  missingInputs: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
} {
  const missingInputs: string[] = [];
  if (input.received == null) missingInputs.push("received");
  if (input.finished == null) missingInputs.push("finished");
  if (input.damaged == null) missingInputs.push("damaged");
  if (input.scrap == null) missingInputs.push("scrap");
  if (input.remaining == null) missingInputs.push("remaining");

  if (input.received == null) {
    return {
      receivedQty: null,
      consumedQty: input.consumed ?? null,
      finishedQty: input.finished ?? null,
      scrapQty: input.scrap ?? null,
      remainingQty: input.remaining ?? null,
      varianceQty: null,
      variancePct: null,
      isEstimated: true,
      missingInputs,
      confidence: "MISSING",
    };
  }
  const received = input.received;
  const finished = input.finished ?? 0;
  const damaged = input.damaged ?? 0;
  const scrap = input.scrap ?? 0;
  const remaining = input.remaining ?? 0;

  // variance = received - (everything that came out of the bag)
  // Things that came out: finished good units + damaged + scrap +
  // any remaining that's still inside.
  // In a closed-loop bag, this is exactly 0. Non-zero variance
  // signals a recording gap (missed counter, missed scrap event)
  // or a counter typo. The metric layer surfaces it as the
  // pill-count-reconciliation variance KPI.
  const variance = received - finished - damaged - scrap - remaining;
  const variancePct =
    received > 0 ? +((variance / received) * 100).toFixed(3) : null;

  // consumed is reserved for future MATERIAL_CONSUMED events. When
  // the caller supplies it we record it; otherwise we leave it null
  // and rely on the variance signal alone.
  const consumed =
    input.consumed != null ? input.consumed : null;
  const inferred =
    consumed == null || input.remaining == null || input.scrap == null;
  const isEstimated = inferred;

  let confidence: "HIGH" | "MEDIUM" | "LOW";
  const absPct = Math.abs(variancePct ?? 0);
  if (!isEstimated && absPct <= 1) confidence = "HIGH";
  else if (!isEstimated && absPct <= 5) confidence = "MEDIUM";
  else confidence = "LOW";

  return {
    receivedQty: received,
    consumedQty: consumed,
    finishedQty: finished,
    scrapQty: scrap,
    remainingQty: remaining,
    varianceQty: variance,
    variancePct,
    isEstimated,
    missingInputs,
    confidence,
  };
}


/** Refresh the row for a single bag at BAG_FINALIZED time. */
export async function refreshMaterialReconciliationForBag(
  tx: Tx,
  workflowBagId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO read_material_reconciliation (
      workflow_bag_id, received_qty, consumed_qty, finished_qty,
      scrap_qty, remaining_qty, variance_qty, variance_pct,
      is_estimated, missing_inputs, updated_at
    )
    SELECT
      wb.id,
      ib.pill_count AS received,
      -- consumed inferred: received - remaining (we don't yet track
      -- remaining post-finalize; assume 0 until inventory wraps)
      CASE WHEN ib.pill_count IS NOT NULL
           THEN ib.pill_count - 0
           ELSE NULL
      END AS consumed,
      rbm.units_yielded AS finished,
      0 AS scrap,
      0 AS remaining,
      CASE WHEN ib.pill_count IS NOT NULL
           THEN ib.pill_count - rbm.units_yielded - 0 - 0
           ELSE NULL
      END AS variance,
      CASE WHEN ib.pill_count IS NOT NULL AND ib.pill_count > 0
           THEN ROUND(((ib.pill_count - rbm.units_yielded - 0 - 0)::numeric / ib.pill_count) * 100, 3)
           ELSE NULL
      END AS variance_pct,
      TRUE AS is_estimated,  -- consumed/scrap/remaining all inferred today
      'consumed,scrap,remaining' AS missing_inputs,
      now()
    FROM workflow_bags wb
    JOIN read_bag_metrics rbm ON rbm.workflow_bag_id = wb.id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    WHERE wb.id = ${workflowBagId}
    ON CONFLICT (workflow_bag_id) DO UPDATE SET
      received_qty = EXCLUDED.received_qty,
      consumed_qty = EXCLUDED.consumed_qty,
      finished_qty = EXCLUDED.finished_qty,
      scrap_qty = EXCLUDED.scrap_qty,
      remaining_qty = EXCLUDED.remaining_qty,
      variance_qty = EXCLUDED.variance_qty,
      variance_pct = EXCLUDED.variance_pct,
      is_estimated = EXCLUDED.is_estimated,
      missing_inputs = EXCLUDED.missing_inputs,
      updated_at = now();
  `);
}

/** Full rebuild — recomputes every finalised bag. */
export async function rebuildMaterialReconciliation(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_material_reconciliation;`);
  await tx.execute(sql`
    INSERT INTO read_material_reconciliation (
      workflow_bag_id, received_qty, consumed_qty, finished_qty,
      scrap_qty, remaining_qty, variance_qty, variance_pct,
      is_estimated, missing_inputs, updated_at
    )
    SELECT
      wb.id,
      ib.pill_count AS received,
      CASE WHEN ib.pill_count IS NOT NULL THEN ib.pill_count - 0 ELSE NULL END AS consumed,
      rbm.units_yielded AS finished,
      0 AS scrap,
      0 AS remaining,
      CASE WHEN ib.pill_count IS NOT NULL
           THEN ib.pill_count - rbm.units_yielded - 0 - 0
           ELSE NULL
      END AS variance,
      CASE WHEN ib.pill_count IS NOT NULL AND ib.pill_count > 0
           THEN ROUND(((ib.pill_count - rbm.units_yielded - 0 - 0)::numeric / ib.pill_count) * 100, 3)
           ELSE NULL
      END AS variance_pct,
      TRUE,
      'consumed,scrap,remaining',
      now()
    FROM workflow_bags wb
    JOIN read_bag_metrics rbm ON rbm.workflow_bag_id = wb.id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    ON CONFLICT (workflow_bag_id) DO NOTHING;
  `);
}
