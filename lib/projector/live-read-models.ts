import { sql } from "drizzle-orm";

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type LiveReadModelCoverageResult = {
  stationRowsInserted: number;
  bagStateRowsInserted: number;
};

function insertedCount(rows: unknown): number {
  const [row] = rows as Array<{ inserted?: number }>;
  return Number(row?.inserted ?? 0);
}

/** Ensure live read models have coverage rows for source records.
 *  This repairs missing read-model rows only; it does not clear live
 *  station pins, overwrite bag-state flags, or mutate source tables. */
export async function ensureLiveReadModelCoverage(
  db: SqlExecutor,
): Promise<LiveReadModelCoverageResult> {
  const stationRows = await db.execute(sql`
    WITH inserted AS (
      INSERT INTO read_station_live (
        station_id,
        current_workflow_bag_id,
        current_product_id,
        current_employee_name,
        last_event_type,
        last_event_at,
        busy_for_seconds,
        updated_at
      )
      SELECT
        s.id,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        now()
      FROM stations s
      WHERE s.is_active = true
      ON CONFLICT (station_id) DO NOTHING
      RETURNING station_id
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);

  const bagStateRows = await db.execute(sql`
    WITH last_pause AS (
      SELECT DISTINCT ON (workflow_bag_id)
        workflow_bag_id,
        occurred_at AS paused_at
      FROM workflow_events
      WHERE event_type::text = 'BAG_PAUSED'
      ORDER BY workflow_bag_id, occurred_at DESC, id DESC
    ),
    last_resume AS (
      SELECT DISTINCT ON (workflow_bag_id)
        workflow_bag_id,
        occurred_at AS resumed_at
      FROM workflow_events
      WHERE event_type::text = 'BAG_RESUMED'
      ORDER BY workflow_bag_id, occurred_at DESC, id DESC
    ),
    paused_total AS (
      SELECT
        p.workflow_bag_id,
        COALESCE(SUM(EXTRACT(EPOCH FROM (r.occurred_at - p.occurred_at)))::int, 0) AS sec
      FROM workflow_events p
      JOIN LATERAL (
        SELECT MIN(r2.occurred_at) AS occurred_at
        FROM workflow_events r2
        WHERE r2.workflow_bag_id = p.workflow_bag_id
          AND r2.event_type::text = 'BAG_RESUMED'
          AND r2.occurred_at > p.occurred_at
      ) r ON r.occurred_at IS NOT NULL
      WHERE p.event_type::text = 'BAG_PAUSED'
      GROUP BY p.workflow_bag_id
    ),
    inserted AS (
      INSERT INTO read_bag_state (
        workflow_bag_id,
        stage,
        product_id,
        product_name,
        inventory_bag_batch_id,
        receipt_number,
        is_finalized,
        is_paused,
        paused_at,
        paused_seconds_accum,
        last_event_at,
        updated_at
      )
      SELECT
        wb.id,
        COALESCE((
          SELECT vr.payload->'corrected_value'->>'resume_stage'
          FROM workflow_events vr
          WHERE vr.workflow_bag_id = wb.id
            AND vr.event_type::text = 'SUBMISSION_CORRECTED'
            AND vr.payload->>'correction_kind' = 'VOID_ERRONEOUS_BAG_FINALIZATION'
          ORDER BY vr.occurred_at DESC, vr.id DESC
          LIMIT 1
        ), (
          SELECT
            CASE we.event_type::text
              WHEN 'CARD_ASSIGNED' THEN 'STARTED'
              WHEN 'BLISTER_COMPLETE' THEN 'BLISTERED'
              WHEN 'HANDPACK_BLISTER_COMPLETE' THEN 'BLISTERED'
              WHEN 'SEALING_COMPLETE' THEN 'SEALED'
              WHEN 'PACKAGING_SNAPSHOT' THEN 'PACKAGED'
              WHEN 'PACKAGING_COMPLETE' THEN 'PACKAGED'
              WHEN 'BOTTLE_HANDPACK_COMPLETE' THEN 'BLISTERED'
              -- BOTTLE-ORDER-FLEX-1: cap-seal + sticker both land at SEALED
              -- (interchangeable order); PACKAGED comes only from packaging.
              WHEN 'BOTTLE_CAP_SEAL_COMPLETE' THEN 'SEALED'
              WHEN 'BOTTLE_STICKER_COMPLETE' THEN 'SEALED'
              WHEN 'BAG_FINALIZED' THEN 'FINALIZED'
            END
          FROM workflow_events we
          WHERE we.workflow_bag_id = wb.id
            AND we.event_type::text IN (
              'CARD_ASSIGNED',
              'BLISTER_COMPLETE',
              'HANDPACK_BLISTER_COMPLETE',
              'SEALING_COMPLETE',
              'PACKAGING_SNAPSHOT',
              'PACKAGING_COMPLETE',
              'BOTTLE_HANDPACK_COMPLETE',
              'BOTTLE_CAP_SEAL_COMPLETE',
              'BOTTLE_STICKER_COMPLETE',
              'BAG_FINALIZED'
            )
            AND NOT (
              we.event_type::text = 'BAG_FINALIZED'
              AND EXISTS (
                SELECT 1
                FROM workflow_events vc
                WHERE vc.workflow_bag_id = wb.id
                  AND vc.event_type::text = 'SUBMISSION_CORRECTED'
                  AND vc.payload->>'correction_kind' = 'VOID_ERRONEOUS_BAG_FINALIZATION'
                  AND vc.payload->>'corrected_event_id' = we.id::text
              )
            )
            AND NOT (
              we.event_type::text = 'SEALING_COMPLETE'
              AND COALESCE(we.payload->>'partial_close', 'false') = 'true'
            )
            AND NOT (
              we.event_type::text = 'PACKAGING_COMPLETE'
              AND COALESCE(we.payload->>'partial_packaging', 'false') = 'true'
            )
          ORDER BY we.occurred_at DESC, we.id DESC
          LIMIT 1
        ), 'STARTED') AS stage,
        wb.product_id,
        p.name,
        ib.batch_id,
        wb.receipt_number,
        (
          wb.finalized_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM workflow_events vc
            WHERE vc.workflow_bag_id = wb.id
              AND vc.event_type::text = 'SUBMISSION_CORRECTED'
              AND vc.payload->>'correction_kind' = 'VOID_ERRONEOUS_BAG_FINALIZATION'
          )
        ) AS is_finalized,
        (
          wb.finalized_at IS NULL
          AND lp.paused_at IS NOT NULL
          AND (lr.resumed_at IS NULL OR lp.paused_at > lr.resumed_at)
        ) AS is_paused,
        CASE
          WHEN wb.finalized_at IS NULL
            AND lp.paused_at IS NOT NULL
            AND (lr.resumed_at IS NULL OR lp.paused_at > lr.resumed_at)
          THEN lp.paused_at
          ELSE NULL
        END AS paused_at,
        COALESCE(pt.sec, 0) AS paused_seconds_accum,
        COALESCE(
          (SELECT MAX(occurred_at) FROM workflow_events WHERE workflow_bag_id = wb.id),
          wb.started_at
        ) AS last_event_at,
        now()
      FROM workflow_bags wb
      LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
      LEFT JOIN products p ON p.id = wb.product_id
      LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
      LEFT JOIN last_pause lp ON lp.workflow_bag_id = wb.id
      LEFT JOIN last_resume lr ON lr.workflow_bag_id = wb.id
      LEFT JOIN paused_total pt ON pt.workflow_bag_id = wb.id
      WHERE rbs.workflow_bag_id IS NULL
      ON CONFLICT (workflow_bag_id) DO NOTHING
      RETURNING workflow_bag_id
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);

  return {
    stationRowsInserted: insertedCount(stationRows),
    bagStateRowsInserted: insertedCount(bagStateRows),
  };
}
