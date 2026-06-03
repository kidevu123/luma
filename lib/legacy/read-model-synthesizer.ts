// Rebuild Luma's read_* tables from scratch by aggregating
// workflow_events. Used after a legacy-import run because the
// importer inserts workflow_events directly without going through
// projectEvent() — so the read models stay empty until this runs.
//
// The synthesizer is destructive in scope: it truncates the four
// rolling read tables (read_bag_state, read_bag_metrics,
// read_daily_throughput, read_operator_daily) and rebuilds them from
// the canonical event log. read_station_live is intentionally not
// rebuilt — it's a live view only meaningful while the floor is
// active.
//
// All work is done in pure SQL via db.execute(sql`...`) for speed —
// 591+ events imported, plus future live data, would be slow to
// iterate row-by-row. Each phase runs in well under a second.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type SynthesisResult = {
  bagStateRows: number;
  bagMetricsRows: number;
  dailyThroughputRows: number;
  operatorDailyRows: number;
  durationMs: number;
};

export async function synthesizeReadModelsFromEvents(): Promise<SynthesisResult> {
  const start = Date.now();

  // ── 1. read_bag_state ────────────────────────────────────────────
  // One row per workflow_bag. Stage derived from the latest stage
  // event; product/batch/receipt denormalized from joins.
  await db.execute(sql`DELETE FROM read_bag_state`);
  const bagStateRes = await db.execute(sql`
    WITH last_pause AS (
      -- Most recent BAG_PAUSED per bag.
      SELECT DISTINCT ON (workflow_bag_id)
        workflow_bag_id,
        occurred_at AS paused_at
      FROM workflow_events
      WHERE event_type::text = 'BAG_PAUSED'
      ORDER BY workflow_bag_id, occurred_at DESC, id DESC
    ),
    last_resume AS (
      -- Most recent BAG_RESUMED per bag.
      SELECT DISTINCT ON (workflow_bag_id)
        workflow_bag_id,
        occurred_at AS resumed_at
      FROM workflow_events
      WHERE event_type::text = 'BAG_RESUMED'
      ORDER BY workflow_bag_id, occurred_at DESC, id DESC
    ),
    paused_total AS (
      -- Total closed pause seconds per bag.
      SELECT p.workflow_bag_id, COALESCE(SUM(EXTRACT(EPOCH FROM (r.occurred_at - p.occurred_at)))::int, 0) AS sec
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
    )
    INSERT INTO read_bag_state (
      workflow_bag_id, stage, product_id, product_name,
      inventory_bag_batch_id, receipt_number,
      is_finalized, is_paused, paused_at, paused_seconds_accum,
      last_event_at, updated_at
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
            WHEN 'CARD_ASSIGNED'              THEN 'STARTED'
            WHEN 'BLISTER_COMPLETE'           THEN 'BLISTERED'
            WHEN 'SEALING_COMPLETE'           THEN 'SEALED'
            WHEN 'PACKAGING_SNAPSHOT'         THEN 'PACKAGED'
            WHEN 'PACKAGING_COMPLETE'         THEN 'PACKAGED'
            WHEN 'BOTTLE_HANDPACK_COMPLETE'   THEN 'BLISTERED'
            WHEN 'BOTTLE_CAP_SEAL_COMPLETE'   THEN 'SEALED'
            WHEN 'BOTTLE_STICKER_COMPLETE'    THEN 'PACKAGED'
            WHEN 'BAG_FINALIZED'              THEN 'FINALIZED'
          END
        FROM workflow_events we
        WHERE we.workflow_bag_id = wb.id
          AND we.event_type::text IN (
            'CARD_ASSIGNED','BLISTER_COMPLETE','SEALING_COMPLETE',
            'PACKAGING_SNAPSHOT','PACKAGING_COMPLETE',
            'BOTTLE_HANDPACK_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
            'BOTTLE_STICKER_COMPLETE','BAG_FINALIZED'
          )
          -- voided_bag_finalized: ignore erroneous terminal events repaired in prod
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
            AND (we.payload->>'partial_close')::boolean IS TRUE
          )
          AND NOT (
            we.event_type::text = 'PACKAGING_COMPLETE'
            AND (we.payload->>'partial_packaging')::boolean IS TRUE
          )
        ORDER BY we.occurred_at DESC, we.id DESC
        LIMIT 1
      ), 'STARTED') AS stage,
      wb.product_id,
      p.name AS product_name,
      ib.batch_id AS inventory_bag_batch_id,
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
      -- is_paused: true when last BAG_PAUSED is more recent than last
      -- BAG_RESUMED AND the bag isn't finalized.
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
      now() AS updated_at
    FROM workflow_bags wb
    LEFT JOIN products p ON p.id = wb.product_id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    LEFT JOIN last_pause lp ON lp.workflow_bag_id = wb.id
    LEFT JOIN last_resume lr ON lr.workflow_bag_id = wb.id
    LEFT JOIN paused_total pt ON pt.workflow_bag_id = wb.id
  `);

  // ── 2. read_bag_metrics ─────────────────────────────────────────
  // One row per finalized workflow_bag. Total / active / paused
  // seconds; per-stage seconds derived from event-pair time deltas.
  //
  // Phase F additions (machine attribution + units yielded):
  //   • machine_ids[] — distinct machine_ids touched by the bag,
  //     looked up from workflow_events.station_id → stations.machine_id.
  //     Drives read_station_quality_daily.
  //   • units_yielded — derived from packaging payload fields:
  //     1. packaged_tablets_total (HIGH) — direct counted output
  //     2. cases × displays_per_case × units_per_display × tablets_per_unit (MEDIUM)
  //     3. displays × units_per_display × tablets_per_unit (LOW)
  //     4. bottles × tablets_per_unit for BOTTLE products (MEDIUM)
  //     0 when none of the above apply — never invented.
  //   • master_cases / displays_made / loose_cards / damaged_packaging /
  //     ripped_cards — pulled directly from packaging payloads.
  //   • yield_pct — units_yielded / inventory_bag.pill_count, when both
  //     are present; null otherwise.
  await db.execute(sql`DELETE FROM read_bag_metrics`);
  const bagMetricsRes = await db.execute(sql`
    WITH paused AS (
      SELECT
        p.workflow_bag_id,
        EXTRACT(EPOCH FROM (r.occurred_at - p.occurred_at))::int AS sec
      FROM workflow_events p
      JOIN LATERAL (
        SELECT MIN(r2.occurred_at) AS occurred_at
        FROM workflow_events r2
        WHERE r2.workflow_bag_id = p.workflow_bag_id
          AND r2.event_type::text = 'BAG_RESUMED'
          AND r2.occurred_at > p.occurred_at
      ) r ON r.occurred_at IS NOT NULL
      WHERE p.event_type::text = 'BAG_PAUSED'
    ),
    paused_total AS (
      SELECT workflow_bag_id, COALESCE(SUM(sec), 0)::int AS paused_seconds
      FROM paused
      GROUP BY workflow_bag_id
    ),
    stage_durations AS (
      -- For each stage event, time from the previous in-flow event
      -- to this one. Crude but matches projectMetricsForFinalizedBag's
      -- gap-calc style.
      SELECT
        we.workflow_bag_id,
        we.event_type::text AS event_type,
        EXTRACT(EPOCH FROM (we.occurred_at - LAG(we.occurred_at) OVER (
          PARTITION BY we.workflow_bag_id ORDER BY we.occurred_at, we.id
        )))::int AS gap_sec
      FROM workflow_events we
      WHERE we.event_type::text IN (
        'CARD_ASSIGNED','BLISTER_COMPLETE','SEALING_COMPLETE',
        'PACKAGING_SNAPSHOT','PACKAGING_COMPLETE',
        'BOTTLE_HANDPACK_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
        'BOTTLE_STICKER_COMPLETE'
      )
    ),
    stage_totals AS (
      SELECT
        workflow_bag_id,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type = 'BLISTER_COMPLETE'), 0)::int AS blister_seconds,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type = 'SEALING_COMPLETE'), 0)::int AS sealing_seconds,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE')), 0)::int AS packaging_seconds,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type = 'BOTTLE_HANDPACK_COMPLETE'), 0)::int AS bottle_handpack_seconds,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type = 'BOTTLE_CAP_SEAL_COMPLETE'), 0)::int AS bottle_cap_seal_seconds,
        COALESCE(SUM(gap_sec) FILTER (WHERE event_type = 'BOTTLE_STICKER_COMPLETE'), 0)::int AS bottle_sticker_seconds
      FROM stage_durations
      GROUP BY workflow_bag_id
    ),
    -- Phase F: machine attribution. Distinct machine_ids touched by
    -- the bag, via station→machine join. NULL station_id or station
    -- without machine_id contributes nothing — no fake attribution.
    bag_machines AS (
      SELECT
        we.workflow_bag_id,
        ARRAY_AGG(DISTINCT s.machine_id) FILTER (WHERE s.machine_id IS NOT NULL) AS machine_ids
      FROM workflow_events we
      JOIN stations s ON s.id = we.station_id
      WHERE s.machine_id IS NOT NULL
      GROUP BY we.workflow_bag_id
    ),
    -- Phase F: packaging payload aggregation — sum across all
    -- PACKAGING_SNAPSHOT and PACKAGING_COMPLETE events for the bag.
    -- Empty when neither event type fired.
    bag_yield_raw AS (
      SELECT
        we.workflow_bag_id,
        COALESCE(SUM(NULLIF((we.payload->>'packaged_tablets_total'), '')::int), 0) AS direct_tablets,
        COALESCE(SUM(NULLIF((we.payload->>'master_cases'), '')::int), 0) AS cases,
        COALESCE(SUM(NULLIF((we.payload->>'displays_made'), '')::int), 0) AS displays,
        COALESCE(SUM(NULLIF((we.payload->>'loose_cards'), '')::int), 0) AS loose_cards,
        COALESCE(SUM(NULLIF((we.payload->>'damaged_packaging'), '')::int), 0) AS damaged_packaging,
        COALESCE(SUM(NULLIF((we.payload->>'ripped_cards'), '')::int), 0) AS ripped_cards,
        COALESCE(SUM(NULLIF((we.payload->>'bottles_made'), '')::int), 0) AS bottles
      FROM workflow_events we
      WHERE we.event_type::text IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE')
      GROUP BY we.workflow_bag_id
    ),
    -- Resolve units_yielded with confidence. Confidence ladder:
    --   HIGH    direct packaged_tablets_total reported
    --   MEDIUM  computed via product packaging spec (tablets_per_unit
    --           + units_per_display + displays_per_case)
    --   LOW     partial spec (only displays × units_per_display)
    --   MISSING no packaging output and no spec
    bag_yield AS (
      SELECT
        byr.workflow_bag_id,
        CASE
          WHEN byr.direct_tablets > 0 THEN byr.direct_tablets
          WHEN p.tablets_per_unit IS NOT NULL
               AND p.units_per_display IS NOT NULL
               AND p.displays_per_case IS NOT NULL
               AND (byr.cases > 0 OR byr.displays > 0 OR byr.loose_cards > 0)
            THEN (byr.cases * p.displays_per_case * p.units_per_display
                  + byr.displays * p.units_per_display
                  + byr.loose_cards) * p.tablets_per_unit
          WHEN p.tablets_per_unit IS NOT NULL
               AND p.units_per_display IS NOT NULL
               AND (byr.displays > 0 OR byr.loose_cards > 0)
            THEN (byr.displays * p.units_per_display + byr.loose_cards) * p.tablets_per_unit
          WHEN p.tablets_per_unit IS NOT NULL
               AND p.kind::text = 'BOTTLE'
               AND byr.bottles > 0
            THEN byr.bottles * p.tablets_per_unit
          ELSE 0
        END AS units_yielded,
        byr.cases,
        byr.displays,
        byr.loose_cards,
        byr.damaged_packaging,
        byr.ripped_cards
      FROM bag_yield_raw byr
      LEFT JOIN workflow_bags wb ON wb.id = byr.workflow_bag_id
      LEFT JOIN products p ON p.id = wb.product_id
    )
    INSERT INTO read_bag_metrics (
      workflow_bag_id, product_id,
      started_at, finalized_at,
      total_seconds, paused_seconds, active_seconds,
      blister_seconds, sealing_seconds, packaging_seconds,
      bottle_handpack_seconds, bottle_cap_seal_seconds, bottle_sticker_seconds,
      machine_ids,
      units_yielded,
      master_cases, displays_made, loose_cards,
      damaged_packaging, ripped_cards,
      input_pill_count,
      yield_pct
    )
    SELECT
      wb.id,
      wb.product_id,
      wb.started_at,
      wb.finalized_at,
      GREATEST(EXTRACT(EPOCH FROM (wb.finalized_at - wb.started_at))::int, 0) AS total_seconds,
      COALESCE(pt.paused_seconds, 0) AS paused_seconds,
      GREATEST(
        EXTRACT(EPOCH FROM (wb.finalized_at - wb.started_at))::int
          - COALESCE(pt.paused_seconds, 0),
        0
      ) AS active_seconds,
      NULLIF(st.blister_seconds, 0),
      NULLIF(st.sealing_seconds, 0),
      NULLIF(st.packaging_seconds, 0),
      NULLIF(st.bottle_handpack_seconds, 0),
      NULLIF(st.bottle_cap_seal_seconds, 0),
      NULLIF(st.bottle_sticker_seconds, 0),
      COALESCE(bm.machine_ids, ARRAY[]::uuid[]) AS machine_ids,
      COALESCE(by.units_yielded, 0) AS units_yielded,
      COALESCE(by.cases, 0) AS master_cases,
      COALESCE(by.displays, 0) AS displays_made,
      COALESCE(by.loose_cards, 0) AS loose_cards,
      COALESCE(by.damaged_packaging, 0) AS damaged_packaging,
      COALESCE(by.ripped_cards, 0) AS ripped_cards,
      ib.pill_count AS input_pill_count,
      CASE
        WHEN ib.pill_count IS NOT NULL AND ib.pill_count > 0 AND COALESCE(by.units_yielded, 0) > 0
          THEN ROUND((COALESCE(by.units_yielded, 0)::numeric / ib.pill_count) * 100, 3)
        ELSE NULL
      END AS yield_pct
    FROM workflow_bags wb
    LEFT JOIN paused_total pt ON pt.workflow_bag_id = wb.id
    LEFT JOIN stage_totals st ON st.workflow_bag_id = wb.id
    LEFT JOIN bag_machines bm ON bm.workflow_bag_id = wb.id
    LEFT JOIN bag_yield by ON by.workflow_bag_id = wb.id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    WHERE wb.finalized_at IS NOT NULL
  `);

  // ── 3. read_daily_throughput ─────────────────────────────────────
  // Per (day, product, machine): how many of each stage event fired.
  // Day bucketed in America/New_York (Luma's company.timezone).
  await db.execute(sql`DELETE FROM read_daily_throughput`);
  const throughputRes = await db.execute(sql`
    INSERT INTO read_daily_throughput (
      day, product_id, machine_id,
      bags_blistered, bags_sealed, bags_packaged, bags_finalized,
      updated_at
    )
    SELECT
      (we.occurred_at AT TIME ZONE 'America/New_York')::date AS day,
      wb.product_id,
      s.machine_id,
      COUNT(*) FILTER (WHERE we.event_type::text IN ('BLISTER_COMPLETE','BOTTLE_HANDPACK_COMPLETE'))::int AS bags_blistered,
      COUNT(*) FILTER (WHERE we.event_type::text IN ('SEALING_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE'))::int AS bags_sealed,
      COUNT(*) FILTER (WHERE we.event_type::text IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE','BOTTLE_STICKER_COMPLETE'))::int AS bags_packaged,
      COUNT(*) FILTER (WHERE we.event_type::text = 'BAG_FINALIZED')::int AS bags_finalized,
      now() AS updated_at
    FROM workflow_events we
    LEFT JOIN stations s ON s.id = we.station_id
    LEFT JOIN workflow_bags wb ON wb.id = we.workflow_bag_id
    WHERE we.event_type::text IN (
      'BLISTER_COMPLETE','BOTTLE_HANDPACK_COMPLETE',
      'SEALING_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
      'PACKAGING_SNAPSHOT','PACKAGING_COMPLETE','BOTTLE_STICKER_COMPLETE',
      'BAG_FINALIZED'
    )
    GROUP BY 1, 2, 3
  `);

  // ── 4. read_operator_daily ───────────────────────────────────────
  // BAG_FINALIZED events with an operator_code in payload roll up
  // to per-operator-per-day stats. operator_code is text, free-form.
  await db.execute(sql`DELETE FROM read_operator_daily`);
  const operatorRes = await db.execute(sql`
    INSERT INTO read_operator_daily (
      day, operator_code,
      bags_finalized, active_seconds_total, damage_count_total,
      updated_at
    )
    SELECT
      (we.occurred_at AT TIME ZONE 'America/New_York')::date AS day,
      COALESCE(NULLIF(we.payload->>'operator_code', ''), 'unknown') AS operator_code,
      COUNT(*) FILTER (WHERE we.event_type::text = 'BAG_FINALIZED')::int AS bags_finalized,
      COALESCE(
        SUM(COALESCE((rbm.active_seconds), 0))
          FILTER (WHERE we.event_type::text = 'BAG_FINALIZED'),
        0
      )::int AS active_seconds_total,
      0 AS damage_count_total,
      now() AS updated_at
    FROM workflow_events we
    LEFT JOIN read_bag_metrics rbm ON rbm.workflow_bag_id = we.workflow_bag_id
    WHERE we.event_type::text = 'BAG_FINALIZED'
      AND COALESCE(NULLIF(we.payload->>'operator_code', ''), 'unknown') IS NOT NULL
    GROUP BY 1, 2
  `);

  // postgres-js returns RowList where INSERT … (no RETURNING) gives
  // back the count via the ResultQueryMeta `count` property.
  const counted = (r: unknown): number => {
    const v = (r as { count?: number })?.count;
    return typeof v === "number" ? v : 0;
  };

  return {
    bagStateRows: counted(bagStateRes),
    bagMetricsRows: counted(bagMetricsRes),
    dailyThroughputRows: counted(throughputRes),
    operatorDailyRows: counted(operatorRes),
    durationMs: Date.now() - start,
  };
}
