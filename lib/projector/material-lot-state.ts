// Phase H.x1 — read_material_lot_state rebuilder.
//
// Per packaging_lot row:
//   • initial_quantity   — qty_received (count) or net_weight_grams (rolls)
//   • current_qty/weight — initial − ESTIMATED − ACTUAL + ADJUSTED
//   • consumed_estimated — SUM of MATERIAL_CONSUMED_ESTIMATED events
//   • consumed_actual    — SUM of MATERIAL_CONSUMED_ACTUAL events
//   • adjusted_quantity  — SUM of MATERIAL_ADJUSTED events
//   • status             — passed through from packaging_lots.status
//   • confidence         — HIGH if any actual exists, MEDIUM with
//                          estimated only, LOW with no events,
//                          MISSING when initial qty unknown
//
// Honest discipline: a lot with no MATERIAL_RECEIVED event still
// counts received qty from packaging_lots.qty_received (the receiving
// flow writes to the lot row directly today; the event is optional).
// We never fabricate consumption.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function rebuildMaterialLotState(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_material_lot_state;`);
  await tx.execute(sql`
    WITH event_sums AS (
      SELECT
        ev.packaging_lot_id,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                 THEN COALESCE(ev.quantity_units, 0) ELSE 0 END)::int AS units_estimated,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                 THEN COALESCE(ev.quantity_units, 0) ELSE 0 END)::int AS units_actual,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                 THEN COALESCE(ev.quantity_grams, 0) ELSE 0 END)::int AS grams_estimated,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                 THEN COALESCE(ev.quantity_grams, 0) ELSE 0 END)::int AS grams_actual,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_ADJUSTED'
                 THEN COALESCE(ev.quantity_units, 0) ELSE 0 END)::int AS units_adjusted,
        SUM(CASE WHEN ev.event_type = 'MATERIAL_ADJUSTED'
                 THEN COALESCE(ev.quantity_grams, 0) ELSE 0 END)::int AS grams_adjusted,
        MAX(ev.occurred_at) AS last_event_at,
        BOOL_OR(ev.event_type IN ('MATERIAL_CONSUMED_ACTUAL','ROLL_WEIGHED')) AS has_actual
      FROM material_inventory_events ev
      WHERE ev.packaging_lot_id IS NOT NULL
      GROUP BY ev.packaging_lot_id
    )
    INSERT INTO read_material_lot_state (
      packaging_lot_id, packaging_material_id, material_kind,
      lot_number, roll_number, status,
      initial_quantity, current_quantity_estimate,
      initial_weight_grams, current_weight_grams_estimate,
      unit_of_measure,
      consumed_estimated, consumed_actual, adjusted_quantity,
      last_event_at, confidence, updated_at
    )
    SELECT
      pl.id,
      pl.packaging_material_id,
      pm.kind::text,
      -- Lot number: prefer batches.batch_number, fall back to id.
      b.batch_number AS lot_number,
      pl.roll_number,
      pl.status,
      pl.qty_received AS initial_quantity,
      -- Roll lots: current qty meaningless for a single roll (qty=1).
      -- Count lots: qty_on_hand minus event-based consumption.
      -- PACKAGING-PENDING-CONSUMPTION-HONESTY-1: do not clamp negative —
      -- production may consume before receipt is entered.
      CASE
        WHEN pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL') THEN NULL
        ELSE pl.qty_on_hand
               - COALESCE(es.units_estimated, 0)
               - COALESCE(es.units_actual, 0)
               + COALESCE(es.units_adjusted, 0)
      END AS current_qty,
      pl.net_weight_grams,
      -- Roll lots: current weight = net_weight - consumed grams.
      CASE
        WHEN pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL') AND pl.net_weight_grams IS NOT NULL
          THEN GREATEST(0, COALESCE(pl.current_weight_grams_estimate, pl.net_weight_grams)
                          - COALESCE(es.grams_estimated, 0)
                          - COALESCE(es.grams_actual, 0)
                          + COALESCE(es.grams_adjusted, 0))
        ELSE pl.current_weight_grams_estimate
      END AS current_weight,
      COALESCE(pl.weight_unit,
        CASE WHEN pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL') THEN 'g' ELSE pm.uom END
      ) AS uom,
      COALESCE(es.units_estimated, 0) + COALESCE(es.grams_estimated, 0),
      CASE WHEN COALESCE(es.units_actual, 0) > 0 OR COALESCE(es.grams_actual, 0) > 0
           THEN COALESCE(es.units_actual, 0) + COALESCE(es.grams_actual, 0)
           ELSE NULL END AS consumed_actual,
      COALESCE(es.units_adjusted, 0) + COALESCE(es.grams_adjusted, 0),
      es.last_event_at,
      CASE
        -- Honest ladder
        WHEN pl.qty_received IS NULL AND pl.net_weight_grams IS NULL THEN 'MISSING'
        WHEN COALESCE(es.has_actual, false) THEN 'HIGH'
        WHEN COALESCE(es.units_estimated, 0) > 0 OR COALESCE(es.grams_estimated, 0) > 0 THEN 'MEDIUM'
        ELSE 'LOW'
      END AS confidence,
      now()
    FROM packaging_lots pl
    JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
    LEFT JOIN batches b ON b.id = pl.batch_id
    LEFT JOIN event_sums es ON es.packaging_lot_id = pl.id;
  `);
}
