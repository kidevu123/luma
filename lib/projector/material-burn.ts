// Rebuild read_material_burn from consumption signals (not only finished-lot release).

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Aggregate daily burn per packaging material for runway + PackTrack. */
export async function rebuildMaterialBurn(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_material_burn;`);
  await tx.execute(sql`
    WITH from_consumption AS (
      SELECT
        day,
        packaging_material_id,
        SUM(
          COALESCE(actual_consumed_grams, 0)
          + COALESCE(estimated_consumed_grams, 0)
        )::int AS qty
      FROM read_material_consumption_daily
      WHERE packaging_material_id IS NOT NULL
      GROUP BY day, packaging_material_id
      HAVING SUM(
        COALESCE(actual_consumed_grams, 0)
        + COALESCE(estimated_consumed_grams, 0)
      ) > 0
    ),
    from_events AS (
      SELECT
        (ev.occurred_at AT TIME ZONE 'America/New_York')::date AS day,
        ev.packaging_material_id,
        SUM(
          COALESCE(
            ev.quantity_grams,
            NULLIF((ev.payload->>'net_weight_grams'), '')::int,
            CASE
              WHEN ev.unit_of_measure IN ('g', 'grams')
                THEN ev.quantity_units
              ELSE NULL
            END,
            0
          )
        )::int AS qty
      FROM material_inventory_events ev
      WHERE ev.packaging_material_id IS NOT NULL
        AND ev.event_type IN (
          'MATERIAL_CONSUMED_ESTIMATED',
          'MATERIAL_CONSUMED_ACTUAL',
          'ROLL_DEPLETED'
        )
      GROUP BY 1, 2
      HAVING SUM(
        COALESCE(
          ev.quantity_grams,
          NULLIF((ev.payload->>'net_weight_grams'), '')::int,
          0
        )
      ) > 0
    ),
    merged AS (
      SELECT day, packaging_material_id, SUM(qty)::int AS qty_consumed
      FROM (
        SELECT * FROM from_consumption
        UNION ALL
        SELECT * FROM from_events
      ) u
      GROUP BY day, packaging_material_id
      HAVING SUM(qty) > 0
    )
    INSERT INTO read_material_burn (day, packaging_material_id, qty_consumed, updated_at)
    SELECT day, packaging_material_id, qty_consumed, now()
    FROM merged;
  `);
}
