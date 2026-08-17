// Phase C — read_queue_state projector.
//
// Recomputes the per-stage queue snapshot from read_bag_state and
// products. Cheap (one COUNT/MIN/AVG/PERCENTILE_CONT statement per
// stage); we just rerun the lot on every relevant event so the
// floor board never lags the source of truth.
//
// Honest-data discipline:
//  • SEALING_QUEUE vs POST_BLISTER_STAGING disambiguation (P6 Task 5):
//    read_bag_queue.queue_stage_key now carries the bag's true queue
//    position. A BLISTERED bag whose read_bag_queue row has
//    queue_stage_key = 'SEALING_QUEUE' has been claimed by a sealing
//    station (overlap scan) and is genuinely in the sealing queue.
//    A BLISTERED bag whose row has queue_stage_key = 'POST_BLISTER_STAGING'
//    (or has no queue row at all, which is the brief window between
//    BLISTER_COMPLETE and the projector commit) is still awaiting a
//    sealer. SEALING_QUEUE and POST_BLISTER_STAGING no longer count the
//    same bags from two perspectives; each counts its true population.
//  • POST_SEAL_STAGING and PACKAGING_QUEUE: the same disambiguation
//    pattern is available via queue_stage_key = 'POST_SEAL_STAGING' vs
//    'PACKAGING_QUEUE' for SEALED bags, but PACKAGING_QUEUE bags progress
//    rapidly (packaging is typically the last step) and the prior
//    duplication was less operationally confusing. Implemented here
//    for parity; same join pattern as the BLISTERED split.
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
 *  optional filters). Two CARD/BOTTLE forks of STARTED resolve via
 *  products.kind. Disambiguation stages use queueStageFilter to join
 *  read_bag_queue. */
interface StageDef {
  bagStages: ReadonlyArray<string>;
  productKind?: "CARD" | "BOTTLE" | "VARIETY";
  /** When set, the count is limited to bags whose read_bag_queue row
   *  has queue_stage_key matching this value. Used to disambiguate
   *  stages that share the same read_bag_state.stage (e.g. BLISTERED
   *  for both POST_BLISTER_STAGING and SEALING_QUEUE). The complement
   *  case (bags NOT in read_bag_queue or with a different stage key)
   *  is expressed by setting excludeQueueStageKey. */
  queueStageFilter?: string;
  /** When set, the count excludes bags whose read_bag_queue row has
   *  queue_stage_key matching this value. Paired with queueStageFilter
   *  on the sibling stage to produce a non-overlapping split. */
  excludeQueueStageKey?: string;
}

const STAGE_DEFS: Record<StageKey, StageDef> = {
  BLISTER_QUEUE: { bagStages: ["STARTED"], productKind: "CARD" },
  // POST_BLISTER_STAGING: BLISTERED bags that are NOT yet claimed by a
  // sealing station. read_bag_queue.queue_stage_key = 'SEALING_QUEUE'
  // marks bags already picked up by a sealer (overlap scan). Bags with
  // no queue row (very brief window between BLISTER_COMPLETE commit and
  // projector update) also count here — LEFT JOIN + IS NULL handles both.
  POST_BLISTER_STAGING: {
    bagStages: ["BLISTERED"],
    excludeQueueStageKey: "SEALING_QUEUE",
  },
  // SEALING_QUEUE: BLISTERED bags whose read_bag_queue row shows they
  // have been claimed by a sealing station (queue_stage_key = 'SEALING_QUEUE').
  // No longer a duplicate of POST_BLISTER_STAGING — the two sets are disjoint.
  SEALING_QUEUE: {
    bagStages: ["BLISTERED"],
    queueStageFilter: "SEALING_QUEUE",
  },
  // POST_SEAL_STAGING: SEALED bags not yet claimed by packaging.
  POST_SEAL_STAGING: {
    bagStages: ["SEALED"],
    excludeQueueStageKey: "PACKAGING_QUEUE",
  },
  // PACKAGING_QUEUE: SEALED bags already claimed by a packaging station.
  PACKAGING_QUEUE: {
    bagStages: ["SEALED"],
    queueStageFilter: "PACKAGING_QUEUE",
  },
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

    // Disambiguation join: stages that share a read_bag_state.stage value
    // (e.g. BLISTERED for both POST_BLISTER_STAGING and SEALING_QUEUE) use
    // read_bag_queue.queue_stage_key to split the population.
    //   queueStageFilter  → only bags IN read_bag_queue with that stage key
    //   excludeQueueStageKey → bags NOT in read_bag_queue at that stage key
    //     (i.e. bag is absent from queue OR has a different queue_stage_key)
    // Stages with neither filter keep the existing read_bag_state-only path.
    const queueJoin = (def.queueStageFilter ?? def.excludeQueueStageKey)
      ? sql`LEFT JOIN read_bag_queue rbq ON rbq.workflow_bag_id = rbs.workflow_bag_id`
      : sql``;
    const queueFilter = def.queueStageFilter
      ? sql`AND rbq.queue_stage_key = ${def.queueStageFilter}`
      : def.excludeQueueStageKey
        ? sql`AND (rbq.workflow_bag_id IS NULL OR rbq.queue_stage_key != ${def.excludeQueueStageKey})`
        : sql``;

    // CTE: stage member rows + computed ages. We use percentile_cont
    // directly so the rollup includes p90.
    await tx.execute(sql`
      WITH members AS (
        SELECT EXTRACT(EPOCH FROM (now() - rbs.last_event_at))::int AS age_sec
        FROM read_bag_state rbs
        LEFT JOIN products p ON p.id = rbs.product_id
        ${queueJoin}
        WHERE rbs.is_finalized = false
          AND rbs.stage IN (${sql.raw(stages)})
          ${productFilter}
          ${queueFilter}
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
