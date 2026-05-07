// Phase H.x1 — read_roll_usage rebuilder.
//
// Per packaging_lot row (only for ROLL kinds):
//   • mounted_at / unmounted_at  — from ROLL_MOUNTED / ROLL_UNMOUNTED
//   • starting_weight             — lot net_weight or first ROLL_MOUNTED.payload.weight
//   • ending_weight               — last ROLL_WEIGHED.quantity_grams
//   • expected_used_grams         — SUM(MATERIAL_CONSUMED_ESTIMATED grams)
//   • actual_used_grams           — starting − ending (when ending exists)
//   • variance / variance_pct     — actual − expected
//   • blisters_produced           — SUM(BLISTER_COMPLETE counter delta)
//                                   for the bag(s) the roll was mounted to
//   • projected_remaining_grams   — starting − expected_used (clamped 0)
//   • projected_blisters_remaining — projected_remaining ÷ standard rate
//   • confidence                  — HIGH if weighed back, MEDIUM with
//                                   standard + mounted, LOW with
//                                   neither, MISSING with no data
//
// Pure SQL idempotent rebuild.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function rebuildRollUsage(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_roll_usage;`);
  await tx.execute(sql`
    WITH roll_lots AS (
      -- Only roll-kind lots qualify. BLISTER_FOIL legacy kind is
      -- treated as a foil roll for backwards compatibility.
      SELECT pl.*, pm.kind::text AS kind
      FROM packaging_lots pl
      JOIN packaging_materials pm ON pm.id = pl.packaging_material_id
      WHERE pm.kind::text IN ('PVC_ROLL', 'FOIL_ROLL', 'BLISTER_FOIL')
    ),
    mount_unmount AS (
      -- DISTINCT ON to grab the most-recent machine_id for the lot
      -- without trying to aggregate UUIDs (no MAX(uuid) in postgres).
      SELECT
        agg.packaging_lot_id,
        agg.mounted_at,
        agg.unmounted_at,
        agg.last_weigh_grams,
        latest_machine.machine_id
      FROM (
        SELECT
          ev.packaging_lot_id,
          MIN(CASE WHEN ev.event_type = 'ROLL_MOUNTED' THEN ev.occurred_at END) AS mounted_at,
          MAX(CASE WHEN ev.event_type = 'ROLL_UNMOUNTED' THEN ev.occurred_at END) AS unmounted_at,
          MAX(CASE WHEN ev.event_type = 'ROLL_WEIGHED' THEN COALESCE(ev.quantity_grams, 0) END) AS last_weigh_grams
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id IS NOT NULL
          AND ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED')
        GROUP BY ev.packaging_lot_id
      ) agg
      LEFT JOIN LATERAL (
        SELECT ev.machine_id
        FROM material_inventory_events ev
        WHERE ev.packaging_lot_id = agg.packaging_lot_id
          AND ev.event_type IN ('ROLL_MOUNTED','ROLL_UNMOUNTED','ROLL_WEIGHED')
          AND ev.machine_id IS NOT NULL
        ORDER BY ev.occurred_at DESC, ev.id DESC
        LIMIT 1
      ) latest_machine ON TRUE
    ),
    consumed AS (
      SELECT
        ev.packaging_lot_id,
        SUM(COALESCE(ev.quantity_grams, 0))::int AS expected_used_grams
      FROM material_inventory_events ev
      WHERE ev.event_type = 'MATERIAL_CONSUMED_ESTIMATED'
        AND ev.packaging_lot_id IS NOT NULL
      GROUP BY ev.packaging_lot_id
    ),
    blister_counts AS (
      -- Sum BLISTER_COMPLETE machine_count payload values for events
      -- on machines tied to this roll's mount window.
      SELECT
        mu.packaging_lot_id,
        COALESCE(SUM(NULLIF((we.payload->>'machine_count'),'')::int), 0)::int AS blisters
      FROM mount_unmount mu
      LEFT JOIN workflow_events we
        ON we.event_type::text = 'BLISTER_COMPLETE'
       AND we.station_id IN (SELECT id FROM stations WHERE machine_id = mu.machine_id)
       AND mu.machine_id IS NOT NULL
       AND mu.mounted_at IS NOT NULL
       AND we.occurred_at >= mu.mounted_at
       AND (mu.unmounted_at IS NULL OR we.occurred_at <= mu.unmounted_at)
      GROUP BY mu.packaging_lot_id
    ),
    standards AS (
      -- Best-fit blister-material standard for this roll kind.
      -- Phase H.x1 doesn't try to disambiguate per-product; we pick
      -- the most-recent active standard for the role implied by the
      -- material kind. The metric API (deriveRollUsage) re-resolves
      -- per-product when a roll is bound to a specific product.
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
      COALESCE(c.expected_used_grams, 0) AS expected_used_grams,
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL
          THEN GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams)::int
        ELSE NULL
      END AS actual_used_grams,
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL AND c.expected_used_grams IS NOT NULL
          THEN (GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams) - c.expected_used_grams)::int
        ELSE NULL
      END AS variance_grams,
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL
             AND COALESCE(c.expected_used_grams, 0) > 0
          THEN ROUND(
            (((GREATEST(0, rl.net_weight_grams - mu.last_weigh_grams) - c.expected_used_grams)::numeric)
              / c.expected_used_grams::numeric * 100),
            3)
        ELSE NULL
      END AS variance_pct,
      bc.blisters AS blisters_produced,
      CASE
        WHEN rl.net_weight_grams IS NOT NULL
          THEN GREATEST(0, rl.net_weight_grams - COALESCE(c.expected_used_grams, 0))::int
        ELSE NULL
      END AS projected_remaining_grams,
      CASE
        WHEN rl.net_weight_grams IS NOT NULL AND s.expected_grams_per_blister IS NOT NULL AND s.expected_grams_per_blister > 0
          THEN FLOOR(GREATEST(0, rl.net_weight_grams - COALESCE(c.expected_used_grams, 0))
                     / s.expected_grams_per_blister)::int
        WHEN rl.net_weight_grams IS NOT NULL AND s.expected_blisters_per_kg IS NOT NULL AND s.expected_blisters_per_kg > 0
          THEN FLOOR(GREATEST(0, rl.net_weight_grams - COALESCE(c.expected_used_grams, 0)) / 1000.0
                     * s.expected_blisters_per_kg)::int
        ELSE NULL
      END AS projected_blisters_remaining,
      CASE
        WHEN mu.last_weigh_grams IS NOT NULL AND rl.net_weight_grams IS NOT NULL THEN 'HIGH'
        WHEN c.expected_used_grams IS NOT NULL AND mu.mounted_at IS NOT NULL THEN 'MEDIUM'
        WHEN rl.net_weight_grams IS NOT NULL THEN 'LOW'
        ELSE 'MISSING'
      END AS confidence,
      now()
    FROM roll_lots rl
    LEFT JOIN mount_unmount mu ON mu.packaging_lot_id = rl.id
    LEFT JOIN consumed c ON c.packaging_lot_id = rl.id
    LEFT JOIN blister_counts bc ON bc.packaging_lot_id = rl.id
    LEFT JOIN standards s
      ON s.material_role = (
        CASE rl.kind WHEN 'PVC_ROLL' THEN 'PVC'
                     WHEN 'FOIL_ROLL' THEN 'FOIL'
                     WHEN 'BLISTER_FOIL' THEN 'FOIL'
        END
      );
  `);
}
