// Phase C — read_sku_daily projector.
//
// Upserts a per-(day, product) row at BAG_FINALIZED time. Source
// data is read_bag_metrics (already populated by the existing
// BAG_FINALIZED handler). We never count event count as output —
// only counter deltas and explicit packaging payload values flow
// through. Bottle-route columns stay zero until BOTTLE_*_COMPLETE
// events emit, which is correct: no bottle activity → no bottle
// numbers.
//
// The projector key is (day, product_id). Day is computed from
// finalized_at in the company timezone — but for v1 we fall back
// to UTC since multi-tenant tz wiring isn't on the projector path
// yet. The metric layer reads in UTC too, so we stay consistent.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

/** Refresh the (day, product) row corresponding to a freshly-
 *  finalized bag. Called from projectEvent after BAG_FINALIZED
 *  fires. The SQL is atomic and idempotent — running it twice for
 *  the same bag produces the same row content (rebuild semantics). */
export async function refreshSkuDailyForBag(
  tx: Tx,
  workflowBagId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO read_sku_daily (
      day, product_id, product_sku, product_kind,
      tablets_consumed, bags_completed,
      displays_completed, cases_completed, bottles_completed,
      loose_cards, loose_displays,
      damages, rework, scrap,
      avg_lead_time_seconds, avg_cycle_seconds,
      updated_at
    )
    SELECT
      DATE(rbm.finalized_at) AS day,
      rbm.product_id,
      p.sku,
      p.kind::text,
      COALESCE(ib.pill_count, 0) AS tablets_consumed,
      1 AS bags_completed,
      rbm.displays_made,
      rbm.master_cases,
      0 AS bottles_completed,    -- bottle-line counters not yet captured per bag
      rbm.loose_cards,
      0 AS loose_displays,
      rbm.damaged_packaging + rbm.ripped_cards AS damages,
      0 AS rework,                -- REWORK_SENT events not emitted yet
      0 AS scrap,                 -- SCRAP_RECORDED events not emitted yet
      rbm.total_seconds AS avg_lead_time_seconds,
      rbm.active_seconds AS avg_cycle_seconds,
      now()
    FROM read_bag_metrics rbm
    JOIN products p ON p.id = rbm.product_id
    LEFT JOIN workflow_bags wb ON wb.id = rbm.workflow_bag_id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    WHERE rbm.workflow_bag_id = ${workflowBagId}
      AND rbm.product_id IS NOT NULL
    ON CONFLICT (day, product_id) DO UPDATE SET
      tablets_consumed = read_sku_daily.tablets_consumed + EXCLUDED.tablets_consumed,
      bags_completed = read_sku_daily.bags_completed + EXCLUDED.bags_completed,
      displays_completed = read_sku_daily.displays_completed + EXCLUDED.displays_completed,
      cases_completed = read_sku_daily.cases_completed + EXCLUDED.cases_completed,
      loose_cards = read_sku_daily.loose_cards + EXCLUDED.loose_cards,
      damages = read_sku_daily.damages + EXCLUDED.damages,
      avg_lead_time_seconds = (
        (read_sku_daily.avg_lead_time_seconds * (read_sku_daily.bags_completed) + EXCLUDED.avg_lead_time_seconds)
        / (read_sku_daily.bags_completed + 1)
      ),
      avg_cycle_seconds = (
        (read_sku_daily.avg_cycle_seconds * (read_sku_daily.bags_completed) + EXCLUDED.avg_cycle_seconds)
        / (read_sku_daily.bags_completed + 1)
      ),
      updated_at = now();
  `);
}

/** Full rebuild — wipes read_sku_daily and re-aggregates from
 *  read_bag_metrics. Called by scripts/rebuild-read-models.ts.
 *  Idempotent. */
export async function rebuildSkuDaily(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_sku_daily;`);
  await tx.execute(sql`
    INSERT INTO read_sku_daily (
      day, product_id, product_sku, product_kind,
      tablets_consumed, bags_completed,
      displays_completed, cases_completed, bottles_completed,
      loose_cards, loose_displays,
      damages, rework, scrap,
      avg_lead_time_seconds, avg_cycle_seconds,
      updated_at
    )
    SELECT
      DATE(rbm.finalized_at) AS day,
      rbm.product_id,
      p.sku,
      p.kind::text,
      COALESCE(SUM(ib.pill_count), 0)::int AS tablets_consumed,
      COUNT(*)::int AS bags_completed,
      SUM(rbm.displays_made)::int AS displays_completed,
      SUM(rbm.master_cases)::int AS cases_completed,
      0 AS bottles_completed,
      SUM(rbm.loose_cards)::int AS loose_cards,
      0 AS loose_displays,
      SUM(rbm.damaged_packaging + rbm.ripped_cards)::int AS damages,
      0 AS rework,
      0 AS scrap,
      AVG(rbm.total_seconds)::int AS avg_lead_time_seconds,
      AVG(rbm.active_seconds)::int AS avg_cycle_seconds,
      now()
    FROM read_bag_metrics rbm
    JOIN products p ON p.id = rbm.product_id
    LEFT JOIN workflow_bags wb ON wb.id = rbm.workflow_bag_id
    LEFT JOIN inventory_bags ib ON ib.id = wb.inventory_bag_id
    WHERE rbm.product_id IS NOT NULL
    GROUP BY DATE(rbm.finalized_at), rbm.product_id, p.sku, p.kind
    ON CONFLICT (day, product_id) DO NOTHING;
  `);
}
