// Phase H.x3 — read_material_usage_learning rebuilder.
//
// Aggregates per (product, route, material, role, machine) bucket
// the empirical grams-per-blister samples drawn from rolls that
// have been weighed back. Source rules:
//
//   • A "sample" is a single roll lot with:
//       - a ROLL_MOUNTED event (start of mount window)
//       - a most-recent ROLL_WEIGHED OR ROLL_UNMOUNTED with quantity_grams
//         (end-of-mount weight)
//       - net_weight_grams (or mount payload starting_weight_grams)
//       - SUM(BLISTER_COMPLETE.machine_count) > 0 during the
//         mount window on the mounted machine
//   • grams_per_blister = (starting - ending) / blisters
//   • The product is taken from the workflow_bag the mount referenced;
//     when no bag, the row aggregates as product_id NULL (cross-product
//     fallback).
//   • The machine is the mount event's machine_id. A second cross-machine
//     row (machine_id NULL) is also inserted so the helper can fall back
//     when no per-machine row matches.
//
// Statistics:
//   • sample_count          = number of rolls included in the bucket
//   • total_blisters_*      = SUM across rolls in the bucket
//   • avg / median / p90    = AVG / PERCENTILE_CONT over per-roll grams
//
// Confidence: HIGH ≥ 5 samples, MEDIUM 2–4, LOW = 1, MISSING = 0.
// (MISSING rows aren't written — they would be useless. Helpers
// surface "Learned standard missing" when no row matches.)

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function rebuildMaterialUsageLearning(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_material_usage_learning;`);
  await tx.execute(sql`
    WITH roll_samples AS (
      SELECT
        rl.id                                 AS lot_id,
        rl.packaging_material_id              AS packaging_material_id,
        pm.kind::text                         AS kind,
        bag.product_id                        AS product_id,
        mount.machine_id                      AS machine_id,
        COALESCE(
          NULLIF((mount.payload->>'starting_weight_grams'),'')::int,
          rl.net_weight_grams
        )                                     AS starting_grams,
        weighed.last_weight_grams             AS ending_grams,
        blister_count.total_blisters          AS total_blisters,
        mount.occurred_at                     AS sample_at
      FROM packaging_lots rl
      JOIN packaging_materials pm ON pm.id = rl.packaging_material_id
      JOIN LATERAL (
        SELECT ev.machine_id, ev.workflow_bag_id, ev.occurred_at, ev.payload
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id = rl.id
          AND ev.event_type = 'ROLL_MOUNTED'
        ORDER BY ev.occurred_at DESC, ev.id DESC
        LIMIT 1
      ) mount ON TRUE
      LEFT JOIN LATERAL (
        SELECT ev.quantity_grams AS last_weight_grams, ev.occurred_at
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id = rl.id
          AND ev.event_type IN ('ROLL_WEIGHED','ROLL_UNMOUNTED')
          AND ev.quantity_grams IS NOT NULL
          AND ev.occurred_at >= mount.occurred_at
        ORDER BY ev.occurred_at DESC, ev.id DESC
        LIMIT 1
      ) weighed ON TRUE
      LEFT JOIN LATERAL (
        SELECT b.product_id
        FROM workflow_bags b
        WHERE b.id = mount.workflow_bag_id
      ) bag ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(NULLIF((we.payload->>'machine_count'),'')::int)::bigint AS total_blisters
        FROM workflow_events we
        JOIN stations s ON s.id = we.station_id
        WHERE we.event_type::text = 'BLISTER_COMPLETE'
          AND s.machine_id = mount.machine_id
          AND we.occurred_at >= mount.occurred_at
          AND (weighed.occurred_at IS NULL OR we.occurred_at <= weighed.occurred_at)
      ) blister_count ON TRUE
      WHERE pm.kind::text IN ('PVC_ROLL','FOIL_ROLL','BLISTER_FOIL')
    ),
    qualified AS (
      SELECT
        product_id, packaging_material_id, machine_id,
        CASE kind
          WHEN 'PVC_ROLL'  THEN 'PVC'
          WHEN 'FOIL_ROLL' THEN 'FOIL'
          WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END AS material_role,
        starting_grams, ending_grams, total_blisters, sample_at,
        (starting_grams - ending_grams)::numeric                          AS used_grams,
        ((starting_grams - ending_grams)::numeric / NULLIF(total_blisters,0)) AS grams_per_blister
      FROM roll_samples
      WHERE starting_grams IS NOT NULL
        AND ending_grams IS NOT NULL
        AND total_blisters IS NOT NULL
        AND total_blisters > 0
        AND starting_grams > ending_grams
    ),
    -- Per (product, material, role, machine) row.
    by_product_machine AS (
      SELECT
        product_id, packaging_material_id, material_role, machine_id,
        COUNT(*)::int                                 AS sample_count,
        SUM(total_blisters)::bigint                   AS total_blisters_produced,
        SUM(used_grams)::int                          AS total_actual_weight_used_grams,
        AVG(grams_per_blister)::numeric(10,4)         AS avg_weight_per_blister,
        PERCENTILE_CONT(0.5)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS median_weight_per_blister,
        PERCENTILE_CONT(0.9)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS p90_weight_per_blister,
        MAX(sample_at)                                AS last_sample_at
      FROM qualified
      GROUP BY product_id, packaging_material_id, material_role, machine_id
    ),
    -- Cross-machine aggregation per product. machine_id = NULL.
    by_product AS (
      SELECT
        product_id, packaging_material_id, material_role,
        NULL::uuid                                    AS machine_id,
        COUNT(*)::int                                 AS sample_count,
        SUM(total_blisters)::bigint                   AS total_blisters_produced,
        SUM(used_grams)::int                          AS total_actual_weight_used_grams,
        AVG(grams_per_blister)::numeric(10,4)         AS avg_weight_per_blister,
        PERCENTILE_CONT(0.5)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS median_weight_per_blister,
        PERCENTILE_CONT(0.9)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS p90_weight_per_blister,
        MAX(sample_at)                                AS last_sample_at
      FROM qualified
      WHERE product_id IS NOT NULL
      GROUP BY product_id, packaging_material_id, material_role
    ),
    -- Cross-product, per-machine — for unknown product fallback.
    by_machine AS (
      SELECT
        NULL::uuid                                    AS product_id,
        packaging_material_id, material_role, machine_id,
        COUNT(*)::int                                 AS sample_count,
        SUM(total_blisters)::bigint                   AS total_blisters_produced,
        SUM(used_grams)::int                          AS total_actual_weight_used_grams,
        AVG(grams_per_blister)::numeric(10,4)         AS avg_weight_per_blister,
        PERCENTILE_CONT(0.5)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS median_weight_per_blister,
        PERCENTILE_CONT(0.9)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS p90_weight_per_blister,
        MAX(sample_at)                                AS last_sample_at
      FROM qualified
      WHERE machine_id IS NOT NULL
      GROUP BY packaging_material_id, material_role, machine_id
    ),
    -- Cross-everything fallback.
    by_material AS (
      SELECT
        NULL::uuid                                    AS product_id,
        packaging_material_id, material_role,
        NULL::uuid                                    AS machine_id,
        COUNT(*)::int                                 AS sample_count,
        SUM(total_blisters)::bigint                   AS total_blisters_produced,
        SUM(used_grams)::int                          AS total_actual_weight_used_grams,
        AVG(grams_per_blister)::numeric(10,4)         AS avg_weight_per_blister,
        PERCENTILE_CONT(0.5)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS median_weight_per_blister,
        PERCENTILE_CONT(0.9)
          WITHIN GROUP (ORDER BY grams_per_blister)
          ::numeric(10,4)                              AS p90_weight_per_blister,
        MAX(sample_at)                                AS last_sample_at
      FROM qualified
      GROUP BY packaging_material_id, material_role
    ),
    rows AS (
      SELECT * FROM by_product_machine
      UNION ALL SELECT * FROM by_product
      UNION ALL SELECT * FROM by_machine
      UNION ALL SELECT * FROM by_material
    )
    INSERT INTO read_material_usage_learning (
      product_id, packaging_material_id, material_role, machine_id,
      sample_count, total_blisters_produced, total_actual_weight_used_grams,
      avg_weight_per_blister, median_weight_per_blister, p90_weight_per_blister,
      last_sample_at, confidence, missing_inputs, source, updated_at
    )
    SELECT
      product_id, packaging_material_id, material_role, machine_id,
      sample_count, total_blisters_produced, total_actual_weight_used_grams,
      avg_weight_per_blister, median_weight_per_blister, p90_weight_per_blister,
      last_sample_at,
      CASE
        WHEN sample_count >= 5 THEN 'HIGH'
        WHEN sample_count >= 2 THEN 'MEDIUM'
        WHEN sample_count = 1   THEN 'LOW'
        ELSE 'MISSING'
      END AS confidence,
      '[]'::jsonb,
      'LEARNED',
      now()
    FROM rows
    WHERE sample_count > 0;
  `);
}
