// Phase C — read_queue_state projector.
//
// Recomputes the per-stage queue snapshot from read_bag_state and
// products. Cheap (one COUNT/MIN/AVG/PERCENTILE_CONT statement per
// stage); we just rerun the lot on every relevant event so the
// floor board never lags the source of truth.
//
// Honest-data discipline:
//  • Stages that the schema can't yet distinguish (e.g. SEALING_QUEUE
//    vs POST_BLISTER_STAGING — both map to read_bag_state.stage =
//    BLISTERED until a "claimed by sealing" event lands) get
//    populated with the upstream-staging count. The duplication is
//    documented; it's not invented data, it's the same bags shown
//    from two stage perspectives. UIs that don't want to double-
//    count simply pick one.
//  • Bottle-route stages remain empty when no bottle activity
//    exists. We do not fake bottle queues.
//
// Thresholds:
//   warning = 30 minutes (1800 sec)
//   critical = 60 minutes (3600 sec)
// Defaults are set here; future Standards Admin UI moves them to
// production_calendars or a dedicated config row.

import { sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { readQueueState } from "@/lib/db/schema";
import type { StageKey } from "@/lib/production/types";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export const QUEUE_THRESHOLDS = {
  WARNING_SECONDS: 30 * 60,
  CRITICAL_SECONDS: 60 * 60,
} as const;

/** Pure helper exported for tests. Returns the queue_status string
 *  for a given (wip, oldestSeconds) pair. */
export function classifyQueueStatus(
  wip: number,
  oldestSeconds: number | null,
  warning = QUEUE_THRESHOLDS.WARNING_SECONDS,
  critical = QUEUE_THRESHOLDS.CRITICAL_SECONDS,
): "EMPTY" | "FLOWING" | "AGING" | "STALLED" {
  if (wip === 0) return "EMPTY";
  if (oldestSeconds == null) return "FLOWING";
  if (oldestSeconds >= critical) return "STALLED";
  if (oldestSeconds >= warning) return "AGING";
  return "FLOWING";
}

/** Mapping from canonical stage keys to (read_bag_state.stage,
 *  optional product kind filter). Two CARD/BOTTLE forks of STARTED
 *  resolve via products.kind. */
interface StageDef {
  bagStages: ReadonlyArray<string>;
  productKind?: "CARD" | "BOTTLE" | "VARIETY";
  /** When true, this stage uses the same data as another stage —
   *  namely the upstream staging — until a finer event lands. The
   *  projector still writes the row so the UI has all 9 keys
   *  predictable; the field is informational. */
  duplicateOf?: StageKey;
}

const STAGE_DEFS: Record<StageKey, StageDef> = {
  BLISTER_QUEUE: { bagStages: ["STARTED"], productKind: "CARD" },
  POST_BLISTER_STAGING: { bagStages: ["BLISTERED"] },
  SEALING_QUEUE: {
    bagStages: ["BLISTERED"],
    duplicateOf: "POST_BLISTER_STAGING",
  },
  POST_SEAL_STAGING: { bagStages: ["SEALED"] },
  PACKAGING_QUEUE: { bagStages: ["SEALED"], duplicateOf: "POST_SEAL_STAGING" },
  BOTTLE_FILL_QUEUE: { bagStages: ["STARTED"], productKind: "BOTTLE" },
  BOTTLE_STICKER_QUEUE: { bagStages: ["BOTTLE_HANDPACK"] },
  BOTTLE_INDUCTION_QUEUE: { bagStages: ["BOTTLE_STICKER"] },
  FINISHED_GOODS_QUEUE: { bagStages: ["PACKAGED"] },
};

/** Recompute every row in read_queue_state. Called from the
 *  synchronous projector after any stage event. Single SQL roundtrip
 *  per stage; total cost is bounded by the number of bags in flight,
 *  which is small (hundreds at most). */
export async function refreshQueueState(tx: Tx): Promise<void> {
  for (const [key, def] of Object.entries(STAGE_DEFS) as Array<
    [StageKey, StageDef]
  >) {
    const stages = def.bagStages.map((s) => `'${s}'`).join(",");
    const productFilter = def.productKind
      ? sql`AND p.kind = ${def.productKind}`
      : sql``;
    // CTE: stage member rows + computed ages. We use percentile_cont
    // directly so the rollup includes p90.
    await tx.execute(sql`
      WITH members AS (
        SELECT EXTRACT(EPOCH FROM (now() - rbs.last_event_at))::int AS age_sec
        FROM read_bag_state rbs
        LEFT JOIN products p ON p.id = rbs.product_id
        WHERE rbs.is_finalized = false
          AND rbs.stage IN (${sql.raw(stages)})
          ${productFilter}
      ),
      agg AS (
        SELECT
          COUNT(*)::int AS wip,
          MAX(age_sec)::int AS oldest,
          AVG(age_sec)::int AS avg,
          PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY age_sec)::int AS p90,
          COUNT(*) FILTER (WHERE age_sec >= ${QUEUE_THRESHOLDS.WARNING_SECONDS})::int AS over_threshold
        FROM members
      )
      INSERT INTO read_queue_state (
        stage_key, wip, oldest_age_seconds, avg_age_seconds,
        p90_age_seconds, bags_over_threshold, queue_status, updated_at
      )
      SELECT
        ${key},
        agg.wip,
        agg.oldest,
        agg.avg,
        agg.p90,
        agg.over_threshold,
        CASE
          WHEN agg.wip = 0 THEN 'EMPTY'
          WHEN agg.oldest >= ${QUEUE_THRESHOLDS.CRITICAL_SECONDS} THEN 'STALLED'
          WHEN agg.oldest >= ${QUEUE_THRESHOLDS.WARNING_SECONDS} THEN 'AGING'
          ELSE 'FLOWING'
        END,
        now()
      FROM agg
      ON CONFLICT (stage_key) DO UPDATE SET
        wip = EXCLUDED.wip,
        oldest_age_seconds = EXCLUDED.oldest_age_seconds,
        avg_age_seconds = EXCLUDED.avg_age_seconds,
        p90_age_seconds = EXCLUDED.p90_age_seconds,
        bags_over_threshold = EXCLUDED.bags_over_threshold,
        queue_status = EXCLUDED.queue_status,
        updated_at = now();
    `);
  }
}

/** Full rebuild — same as refreshQueueState today, but kept as a
 *  separate export so the rebuild script can be explicit about what
 *  it's doing. */
export async function rebuildQueueState(tx: Tx): Promise<void> {
  await tx.execute(sql`DELETE FROM read_queue_state;`);
  await refreshQueueState(tx);
}

/** The set of event types that should trigger a refresh. The
 *  projector imports this; UI never does. */
export const QUEUE_REFRESH_EVENTS = new Set<string>([
  "CARD_ASSIGNED",
  "BAG_CLAIMED",
  "BLISTER_COMPLETE",
  "SEALING_COMPLETE",
  "PACKAGING_SNAPSHOT",
  "PACKAGING_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
  "BOTTLE_CAP_SEAL_COMPLETE",
  "BOTTLE_STICKER_COMPLETE",
  "BAG_FINALIZED",
  "BAG_PAUSED",
  "BAG_RESUMED",
  "CARD_FORCE_RELEASED",
]);
