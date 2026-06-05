import { sql } from "drizzle-orm";

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/** Rebuild read_daily_throughput from source-of-truth event + bag metrics rows.
 *  This is a read-model repair, not source data mutation. */
export async function rebuildDailyThroughput(db: SqlExecutor): Promise<void> {
  await db.execute(sql`DELETE FROM read_daily_throughput`);

  await db.execute(sql`
    INSERT INTO read_daily_throughput (
      day,
      product_id,
      machine_id,
      bags_blistered,
      bags_sealed,
      bags_packaged,
      bags_finalized,
      units_produced,
      displays_produced,
      cases_produced,
      updated_at
    )
    WITH stage_rollup AS (
      SELECT
        (we.occurred_at AT TIME ZONE 'America/New_York')::date AS day,
        wb.product_id,
        s.machine_id,
        COUNT(*) FILTER (
          WHERE we.event_type::text IN (
            'BLISTER_COMPLETE',
            'HANDPACK_BLISTER_COMPLETE',
            'BOTTLE_HANDPACK_COMPLETE'
          )
        )::int AS bags_blistered,
        COUNT(*) FILTER (
          WHERE we.event_type::text IN (
            'SEALING_COMPLETE',
            'BOTTLE_CAP_SEAL_COMPLETE'
          )
          AND NOT (
            we.event_type::text = 'SEALING_COMPLETE'
            AND COALESCE(we.payload->>'partial_close', 'false') = 'true'
          )
        )::int AS bags_sealed,
        COUNT(*) FILTER (
          WHERE we.event_type::text IN (
            'PACKAGING_SNAPSHOT',
            'PACKAGING_COMPLETE',
            'BOTTLE_STICKER_COMPLETE'
          )
          AND NOT (
            we.event_type::text = 'PACKAGING_COMPLETE'
            AND COALESCE(we.payload->>'partial_packaging', 'false') = 'true'
          )
        )::int AS bags_packaged
      FROM workflow_events we
      INNER JOIN workflow_bags wb ON wb.id = we.workflow_bag_id
      LEFT JOIN stations s ON s.id = we.station_id
      WHERE wb.product_id IS NOT NULL
        AND we.event_type::text IN (
          'BLISTER_COMPLETE',
          'HANDPACK_BLISTER_COMPLETE',
          'BOTTLE_HANDPACK_COMPLETE',
          'SEALING_COMPLETE',
          'BOTTLE_CAP_SEAL_COMPLETE',
          'PACKAGING_SNAPSHOT',
          'PACKAGING_COMPLETE',
          'BOTTLE_STICKER_COMPLETE'
        )
      GROUP BY 1, 2, 3
    ),
    finalized_rollup AS (
      SELECT
        (rbm.finalized_at AT TIME ZONE 'America/New_York')::date AS day,
        rbm.product_id,
        finalized_station.machine_id,
        COUNT(*)::int AS bags_finalized,
        COALESCE(SUM(rbm.units_yielded), 0)::int AS units_produced,
        COALESCE(SUM(rbm.displays_made), 0)::int AS displays_produced,
        COALESCE(SUM(rbm.master_cases), 0)::int AS cases_produced
      FROM read_bag_metrics rbm
      LEFT JOIN LATERAL (
        SELECT s.machine_id
        FROM workflow_events we
        LEFT JOIN stations s ON s.id = we.station_id
        WHERE we.workflow_bag_id = rbm.workflow_bag_id
          AND we.event_type::text = 'BAG_FINALIZED'
        ORDER BY we.occurred_at DESC, we.id DESC
        LIMIT 1
      ) finalized_station ON true
      WHERE rbm.product_id IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    keys AS (
      SELECT day, product_id, machine_id FROM stage_rollup
      UNION
      SELECT day, product_id, machine_id FROM finalized_rollup
    )
    SELECT
      k.day,
      k.product_id,
      k.machine_id,
      COALESCE(s.bags_blistered, 0),
      COALESCE(s.bags_sealed, 0),
      COALESCE(s.bags_packaged, 0),
      COALESCE(f.bags_finalized, 0),
      COALESCE(f.units_produced, 0),
      COALESCE(f.displays_produced, 0),
      COALESCE(f.cases_produced, 0),
      now()
    FROM keys k
    LEFT JOIN stage_rollup s
      ON s.day = k.day
      AND s.product_id = k.product_id
      AND s.machine_id IS NOT DISTINCT FROM k.machine_id
    LEFT JOIN finalized_rollup f
      ON f.day = k.day
      AND f.product_id = k.product_id
      AND f.machine_id IS NOT DISTINCT FROM k.machine_id
  `);
}
