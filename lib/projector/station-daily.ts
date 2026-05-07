// Phase C — read_station_quality_daily projector.
//
// Per-(day, machine, product, output_unit) quality + unit rollup.
// Drives the inputs Phase B's OEE math needs once standards land.
//
// Today's source of truth is read_bag_metrics (per-bag rollups
// computed at BAG_FINALIZED time). machine_ids[] is captured;
// station_id per output unit is not. This projector therefore
// attributes outputs at machine granularity and leaves station_id
// NULL — the column is reserved for when a future projector
// extension can attribute per-station.
//
// What we DO compute today:
//   total_units    = bags_finalized for the (day, machine, product)
//   good_units     = total - damaged - reject - scrap (today: total - damaged)
//   damaged_units  = SUM(damaged_packaging + ripped_cards)
//   reject_units   = 0 (no REWORK_RECEIVED→reject events emitted yet)
//   scrap_units    = 0 (no SCRAP_RECORDED events yet)
//   rework_units   = 0 (no REWORK_SENT events yet)
//   active_minutes = SUM(active_seconds) / 60
//
// planned_minutes is left NULL — populated only when a production
// calendar matches the day. The metric layer reads NULL as
// "Insufficient data for OEE Availability".
//
// data_confidence:
//   HIGH  — all available inputs present (today: most rows)
//   LOW   — projector had to treat any input as 0 due to gap

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Refresh the row corresponding to a freshly-finalized bag. The
 *  projector calls this at BAG_FINALIZED time. The unique index
 *  on (day, machine_id, product_id, output_unit) guarantees one
 *  row per machine per product per unit per day; concurrent finals
 *  use ON CONFLICT to accumulate. */
export async function refreshStationDailyForBag(
  tx: Tx,
  workflowBagId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO read_station_quality_daily (
      day, station_id, machine_id, product_id, output_unit,
      total_units, good_units, reject_units, scrap_units,
      rework_units, damaged_units, active_minutes,
      data_confidence, updated_at
    )
    SELECT
      DATE(rbm.finalized_at) AS day,
      NULL::uuid AS station_id,            -- per-station attribution deferred
      m.id AS machine_id,
      rbm.product_id,
      'BAG' AS output_unit,
      1 AS total_units,
      GREATEST(0, 1 - LEAST(1, rbm.damaged_packaging + rbm.ripped_cards)) AS good_units,
      0 AS reject_units,
      0 AS scrap_units,
      0 AS rework_units,
      (rbm.damaged_packaging + rbm.ripped_cards) AS damaged_units,
      GREATEST(0, FLOOR(rbm.active_seconds / 60.0))::int AS active_minutes,
      'HIGH' AS data_confidence,
      now()
    FROM read_bag_metrics rbm
    -- Each machine_id in the array gets credited for the bag. This
    -- mirrors how the existing projector aggregates throughput
    -- across multiple machines that touched the bag.
    LEFT JOIN LATERAL UNNEST(rbm.machine_ids) AS mid ON TRUE
    LEFT JOIN machines m ON m.id = mid
    WHERE rbm.workflow_bag_id = ${workflowBagId}
      AND rbm.product_id IS NOT NULL
      AND m.id IS NOT NULL
    ON CONFLICT (day, machine_id, product_id, output_unit) DO UPDATE SET
      total_units = read_station_quality_daily.total_units + EXCLUDED.total_units,
      good_units = read_station_quality_daily.good_units + EXCLUDED.good_units,
      damaged_units = read_station_quality_daily.damaged_units + EXCLUDED.damaged_units,
      active_minutes = read_station_quality_daily.active_minutes + EXCLUDED.active_minutes,
      updated_at = now();
  `);
}

/** Full rebuild — wipes and re-aggregates from read_bag_metrics. */
export async function rebuildStationQualityDaily(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_station_quality_daily;`);
  await tx.execute(sql`
    INSERT INTO read_station_quality_daily (
      day, station_id, machine_id, product_id, output_unit,
      total_units, good_units, reject_units, scrap_units,
      rework_units, damaged_units, active_minutes,
      data_confidence, updated_at
    )
    SELECT
      DATE(rbm.finalized_at) AS day,
      NULL::uuid,
      mid AS machine_id,
      rbm.product_id,
      'BAG' AS output_unit,
      COUNT(*)::int AS total_units,
      GREATEST(
        0,
        COUNT(*)::int
        - SUM(LEAST(1, rbm.damaged_packaging + rbm.ripped_cards))::int
      ) AS good_units,
      0,
      0,
      0,
      SUM(rbm.damaged_packaging + rbm.ripped_cards)::int AS damaged_units,
      SUM(GREATEST(0, FLOOR(rbm.active_seconds / 60.0)))::int AS active_minutes,
      'HIGH',
      now()
    FROM read_bag_metrics rbm
    LEFT JOIN LATERAL UNNEST(rbm.machine_ids) AS mid ON TRUE
    WHERE rbm.product_id IS NOT NULL AND mid IS NOT NULL
    GROUP BY DATE(rbm.finalized_at), mid, rbm.product_id
    ON CONFLICT (day, machine_id, product_id, output_unit) DO NOTHING;
  `);
}
