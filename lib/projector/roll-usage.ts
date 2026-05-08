// Phase H.x1 + VALIDATION-2C — read_roll_usage rebuilder.
//
// Source of truth changed in VALIDATION-2C: roll yield is now the
// SUM of ROLL_COUNTER_SEGMENT_RECORDED events allocated to the
// specific roll lot. We no longer compute yield from a
// machine-window join over BLISTER_COMPLETE — that approach was
// wrong because (a) the operator resets the counter mid-bag, and
// (b) the same machine can change rolls mid-bag while the bag
// continues. Segments are explicit, so we just sum them.
//
// Per-roll fields:
//   • mounted_at / unmounted_at  — from ROLL_MOUNTED / ROLL_UNMOUNTED
//   • starting_weight             — lot.net_weight_grams (or mount payload)
//   • ending_weight               — most-recent ROLL_WEIGHED quantity_grams
//   • blisters_produced           — SUM(ROLL_COUNTER_SEGMENT_RECORDED
//                                      .payload.counter_segment_count) for the lot
//   • expected_used_grams         — blisters × standard.grams_per_blister
//                                   (when a standard exists)
//   • actual_used_grams           — net_weight − ending_weight (weigh-back)
//                                   OR net_weight when status = DEPLETED
//                                   (fully consumed = full net used)
//   • variance / variance_pct     — actual − expected
//   • projected_remaining_grams   — net − expected_used (clamp 0)
//   • projected_blisters_remaining — projected_remaining ÷ standard
//   • confidence
//        HIGH    weigh-back exists OR (DEPLETED + net_weight + segments)
//        MEDIUM  IN_USE + segments + standard
//        LOW     mounted only (no segments yet)
//        MISSING nothing

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function rebuildRollUsage(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_roll_usage;`);
  await tx.execute(sql`
    WITH roll_lots AS (
      SELECT pl.*, pm.kind::text AS kind
      FROM packaging_lots pl
      JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
      WHERE pm.kind::text IN ('PVC_ROLL', 'FOIL_ROLL', 'BLISTER_FOIL')
    ),
    mount_unmount AS (
      SELECT
        agg.packaging_lot_id,
        agg.mounted_at,
        agg.unmounted_at,
        agg.last_weigh_grams,
        latest_machine.machine_id
      FROM (
        SELECT
          ev.packaging_lot_id,
          MAX(CASE WHEN ev.event_type = 'ROLL_MOUNTED' THEN ev.occurred_at END) AS mounted_at,
          MAX(CASE WHEN ev.event_type IN ('ROLL_UNMOUNTED','ROLL_DEPLETED') THEN ev.occurred_at END) AS unmounted_at,
          MAX(CASE WHEN ev.event_type = 'ROLL_WEIGHED' THEN COALESCE(ev.quantity_grams, 0) END) AS last_weigh_grams
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id IS NOT NULL
          AND ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED','ROLL_DEPLETED')
        GROUP BY ev.packaging_lot_id
      ) agg
      LEFT JOIN LATERAL (
        SELECT ev.machine_id
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id = agg.packaging_lot_id
          AND ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED','ROLL_DEPLETED')
          AND ev.machine_id IS NOT NULL
        ORDER BY ev.occurred_at DESC, ev.id DESC
        LIMIT 1
      ) latest_machine ON TRUE
    ),
    -- Segment ledger — sum counter_segment_count grouped by lot.
    segments AS (
      SELECT
        ev.packaging_lot_id,
        SUM(NULLIF((ev.payload->>'counter_segment_count'),'')::int)::bigint AS total_blisters
      FROM material_inventory_events ev
      WHERE ev.event_type = 'ROLL_COUNTER_SEGMENT_RECORDED'
        AND ev.packaging_lot_id IS NOT NULL
      GROUP BY ev.packaging_lot_id
    ),
    standards AS (
      SELECT DISTINCT ON (s.material_role)
        s.material_role,
        s.expected_grams_per_blister,
        s.expected_blisters_per_kg,
        s.setup_waste_grams,
        s.changeover_waste_grams
      FROM blister_material_standards s
      WHERE s.is_active = true
      ORDER BY s.material_role, s.effective_from DESC
    )
    INSERT INTO read_roll_usage (
      packaging_lot_id, roll_number, material_kind, material_role,
      machine_id, mounted_at, unmounted_at,
      starting_weight_grams, ending_weight_grams,
      expected_used_grams, actual_used_grams,
      variance_grams, variance_pct,
      blisters_produced,
      projected_remaining_grams, projected_blisters_remaining,
      confidence, updated_at
    )
    SELECT
      rl.id,
      rl.roll_number,
      rl.kind,
      CASE rl.kind WHEN 'PVC_ROLL' THEN 'PVC' WHEN 'FOIL_ROLL' THEN 'FOIL' WHEN 'BLISTER_FOIL' THEN 'FOIL' END,
      mu.machine_id,
      mu.mounted_at,
      mu.unmounted_at,
      rl.net_weight_grams AS starting_weight_grams,
      mu.last_weigh_grams AS ending_weight_grams,
      -- expected = blisters × standard grams_per_blister (no waste add-on for now)
      CASE
        WHEN seg.total_blisters IS NOT NULL
             AND s.expected_grams_per_blister IS NOT NULL
             AND s.expected_grams_per_blister > 0
          THEN ROUND(seg.total_blisters * s.expected_grams_per_blister)::int
        WHEN seg.total_blisters IS NOT NULL
             AND s.expected_blisters_per_kg IS NOT NULL
             AND s.expected_blisters_per_kg > 0
          THEN ROUND(seg.total_blisters * (1000.0 / s.expected_blisters_per_kg))::int
        ELSE NULL
      END AS expected_used_grams,
      -- actual = (net - ending) when weighed; or full net when DEPLETED
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL
          THEN GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams)::int
        WHEN rl.status = 'DEPLETED' AND rl.net_weight_grams IS NOT NULL
          THEN rl.net_weight_grams
        ELSE NULL
      END AS actual_used_grams,
      -- variance = actual - expected
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL
             AND seg.total_blisters IS NOT NULL
             AND s.expected_grams_per_blister IS NOT NULL
             AND s.expected_grams_per_blister > 0
          THEN (GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams)
                - ROUND(seg.total_blisters * s.expected_grams_per_blister))::int
        WHEN rl.status = 'DEPLETED' AND rl.net_weight_grams IS NOT NULL
             AND seg.total_blisters IS NOT NULL
             AND s.expected_grams_per_blister IS NOT NULL
             AND s.expected_grams_per_blister > 0
          THEN (rl.net_weight_grams
                - ROUND(seg.total_blisters * s.expected_grams_per_blister))::int
        ELSE NULL
      END AS variance_grams,
      CASE
        WHEN seg.total_blisters IS NOT NULL
             AND s.expected_grams_per_blister IS NOT NULL
             AND s.expected_grams_per_blister > 0
             AND ROUND(seg.total_blisters * s.expected_grams_per_blister) > 0
             AND ((mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL)
                  OR (rl.status = 'DEPLETED' AND rl.net_weight_grams IS NOT NULL))
          THEN ROUND(
            (
              (CASE WHEN mu.last_weigh_grams IS NOT NULL
                    THEN GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams)
                    ELSE rl.net_weight_grams END
              - ROUND(seg.total_blisters * s.expected_grams_per_blister))::numeric
              / ROUND(seg.total_blisters * s.expected_grams_per_blister)::numeric * 100
            ), 3)
        ELSE NULL
      END AS variance_pct,
      seg.total_blisters AS blisters_produced,
      -- projected_remaining = net - expected_used (clamp 0)
      CASE
        WHEN rl.net_weight_grams IS NOT NULL
          THEN GREATEST(0,
                 rl.net_weight_grams
                 - COALESCE(
                     CASE
                       WHEN seg.total_blisters IS NOT NULL
                            AND s.expected_grams_per_blister IS NOT NULL
                            AND s.expected_grams_per_blister > 0
                         THEN ROUND(seg.total_blisters * s.expected_grams_per_blister)::int
                       ELSE 0
                     END, 0)
               )::int
        ELSE NULL
      END AS projected_remaining_grams,
      CASE
        WHEN rl.net_weight_grams IS NOT NULL
             AND s.expected_grams_per_blister IS NOT NULL
             AND s.expected_grams_per_blister > 0
          THEN FLOOR(
                 GREATEST(0,
                   rl.net_weight_grams
                   - COALESCE(
                       CASE
                         WHEN seg.total_blisters IS NOT NULL
                           THEN ROUND(seg.total_blisters * s.expected_grams_per_blister)::int
                         ELSE 0
                       END, 0))
                 / s.expected_grams_per_blister
               )::int
        ELSE NULL
      END AS projected_blisters_remaining,
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL THEN 'HIGH'
        WHEN rl.status = 'DEPLETED' AND rl.net_weight_grams IS NOT NULL AND seg.total_blisters IS NOT NULL THEN 'HIGH'
        WHEN seg.total_blisters IS NOT NULL AND mu.mounted_at IS NOT NULL THEN 'MEDIUM'
        WHEN rl.net_weight_grams IS NOT NULL AND mu.mounted_at IS NOT NULL THEN 'LOW'
        ELSE 'MISSING'
      END AS confidence,
      now()
    FROM roll_lots rl
    LEFT JOIN mount_unmount mu ON mu.packaging_lot_id = rl.id
    LEFT JOIN segments seg ON seg.packaging_lot_id = rl.id
    LEFT JOIN standards s
      ON s.material_role = (
        CASE rl.kind WHEN 'PVC_ROLL' THEN 'PVC'
                     WHEN 'FOIL_ROLL' THEN 'FOIL'
                     WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      );
  `);
}
