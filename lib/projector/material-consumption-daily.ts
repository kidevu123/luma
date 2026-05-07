// Phase H.x1 — read_material_consumption_daily rebuilder.
//
// Per (day, material, lot, product, machine) aggregates of:
//   • estimated_consumed_units / grams (MATERIAL_CONSUMED_ESTIMATED)
//   • actual_consumed_units / grams    (MATERIAL_CONSUMED_ACTUAL)
//   • variance + variance_pct          (when both present)
//   • confidence                       (HIGH on actual, MEDIUM on estimated only)
//
// Idempotent. Honest: rows where the lot is null are written but
// confidence drops a level (we never deduct from "unknown lot" as a
// fact — it's flagged as inferred).

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function rebuildMaterialConsumptionDaily(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_material_consumption_daily;`);
  await tx.execute(sql`
    INSERT INTO read_material_consumption_daily (
      day, packaging_material_id, packaging_lot_id, product_id,
      machine_id, station_id,
      estimated_consumed_units, actual_consumed_units,
      estimated_consumed_grams, actual_consumed_grams,
      unit_of_measure, variance_qty, variance_pct, confidence,
      updated_at
    )
    SELECT
      (ev.occurred_at AT TIME ZONE 'America/New_York')::date AS day,
      ev.packaging_material_id,
      ev.packaging_lot_id,
      ev.product_id,
      ev.machine_id,
      ev.station_id,
      SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
               THEN COALESCE(ev.quantity_units, 0) ELSE 0 END)::int AS estimated_units,
      NULLIF(SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
               THEN COALESCE(ev.quantity_units, 0) ELSE 0 END)::int, 0) AS actual_units,
      SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
               THEN COALESCE(ev.quantity_grams, 0) ELSE 0 END)::int AS estimated_grams,
      NULLIF(SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
               THEN COALESCE(ev.quantity_grams, 0) ELSE 0 END)::int, 0) AS actual_grams,
      COALESCE(MAX(ev.unit_of_measure), pm.uom) AS uom,
      -- Variance: actual − estimated. Null when either side is 0.
      CASE
        WHEN SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END) > 0
         AND SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END) > 0
        THEN
          SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                   THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                   ELSE 0 END)::int
          -
          SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                   THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                   ELSE 0 END)::int
        ELSE NULL
      END AS variance_qty,
      CASE
        WHEN SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END) > 0
        AND SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END) > 0
        THEN
          ROUND((
            (SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ACTUAL'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END)::numeric
             -
             SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                      THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                      ELSE 0 END)::numeric
            )
            / NULLIF(SUM(CASE WHEN ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
                              THEN COALESCE(ev.quantity_units, 0) + COALESCE(ev.quantity_grams, 0)
                              ELSE 0 END)::numeric, 0)
            * 100), 3)
        ELSE NULL
      END AS variance_pct,
      CASE
        WHEN BOOL_OR(ev.event_type = 'MATERIAL_CONSUMED_ACTUAL')
             AND ev.packaging_lot_id IS NOT NULL THEN 'HIGH'
        WHEN BOOL_OR(ev.event_type = 'MATERIAL_CONSUMED_ACTUAL')
             AND ev.packaging_lot_id IS NULL THEN 'MEDIUM'
        WHEN ev.packaging_lot_id IS NOT NULL THEN 'MEDIUM'
        ELSE 'LOW'
      END AS confidence,
      now()
    FROM material_inventory_events ev
    JOIN packaging_materials pm ON pm.id = ev.packaging_material_id
    WHERE ev.event_type IN ('MATERIAL_CONSUMED_ESTIMATED', 'MATERIAL_CONSUMED_ACTUAL')
    GROUP BY 1, 2, 3, 4, 5, 6, pm.uom
    ON CONFLICT (day, packaging_material_id, packaging_lot_id, product_id, machine_id) DO NOTHING;
  `);
}
