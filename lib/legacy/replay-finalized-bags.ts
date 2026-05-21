// Phase E.6 — replay of legacy BAG_FINALIZED events into the
// canonical projection state.
//
// Background: lib/legacy/submission-synthesizer.ts inserts events
// directly into workflow_events for performance (bulk inserts of
// 1000+ rows would be slow through projectEvent). Earlier
// versions of the synthesizer did NOT mint BAG_FINALIZED events,
// nor did they backfill workflow_bags.finalized_at for placeholder
// bags. Some BAG_FINALIZED events landed on prod via other paths
// (live floor activity or earlier importers) but
// workflow_bags.finalized_at remained NULL on those rows.
//
// This module is the canonical backfill path. It NEVER mints new
// workflow_events. It only:
//   1. For every workflow_bag with at least one BAG_FINALIZED
//      event in workflow_events and no finalized_at set, copy
//      MAX(occurred_at WHERE event_type='BAG_FINALIZED') to
//      workflow_bags.finalized_at.
//   2. Returns a per-bag report listing successes + failures with
//      missing-input details so the caller can surface them in the
//      UI / script output. NEVER fabricates output if inputs are
//      partial.
//
// After this runs, the existing synthesizeReadModelsFromEvents +
// the new Phase C rebuilders pick up the finalized bags and
// populate read_bag_metrics / read_sku_daily / read_material_
// reconciliation / read_station_quality_daily.

import { sql, eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowBags, workflowEvents } from "@/lib/db/schema";

export interface BagBackfillReport {
  workflowBagId: string;
  finalizedAt: Date | null;
  /** What we did, or why we didn't. */
  status: "BACKFILLED" | "ALREADY_FINALIZED" | "SKIPPED";
  /** Specific missing inputs when status is SKIPPED. */
  missingInputs: ReadonlyArray<string>;
  /** Human-readable rationale for the status. */
  reason: string;
}

export interface ReplayResult {
  candidatesScanned: number;
  backfilled: number;
  alreadyFinalized: number;
  skipped: number;
  reports: BagBackfillReport[];
}

interface ReplayOptions {
  /** When true, compute the report but don't write. */
  dryRun?: boolean;
  /** Restrict to a single bag for targeted debugging. */
  bagId?: string;
}

/** Pure helper exported for tests. Given a bag's row + the latest
 *  BAG_FINALIZED occurred_at, decide what to do. */
export function decideBackfill(input: {
  workflowBagId: string;
  currentFinalizedAt: Date | null;
  latestFinalizedEventAt: Date | null;
  hasBagFinalizedEvent: boolean;
}): Pick<BagBackfillReport, "status" | "missingInputs" | "reason"> {
  if (input.currentFinalizedAt) {
    return {
      status: "ALREADY_FINALIZED",
      missingInputs: [],
      reason: "workflow_bags.finalized_at already set; nothing to do.",
    };
  }
  if (!input.hasBagFinalizedEvent) {
    return {
      status: "SKIPPED",
      missingInputs: ["BAG_FINALIZED event"],
      reason: "Bag has no BAG_FINALIZED event in workflow_events.",
    };
  }
  if (!input.latestFinalizedEventAt) {
    // hasBagFinalizedEvent=true but no occurred_at? Should be
    // impossible given the schema (occurred_at is NOT NULL), but
    // guard anyway.
    return {
      status: "SKIPPED",
      missingInputs: ["occurred_at on BAG_FINALIZED event"],
      reason:
        "BAG_FINALIZED event exists but its occurred_at is missing.",
    };
  }
  return {
    status: "BACKFILLED",
    missingInputs: [],
    reason: `Set workflow_bags.finalized_at = ${input.latestFinalizedEventAt.toISOString()}.`,
  };
}

/** Walk every bag that has a BAG_FINALIZED event but a NULL
 *  finalized_at, decide what to do, and (unless dry-run) write the
 *  backfill. Idempotent: re-running with no candidates is a no-op. */
export async function replayFinalizedBags(
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const candidates = await db.execute<{
    workflow_bag_id: string;
    current_finalized_at: Date | null;
    latest_event_at: Date | null;
  }>(sql`
    SELECT
      wb.id AS workflow_bag_id,
      wb.finalized_at AS current_finalized_at,
      MAX(we.occurred_at) AS latest_event_at
    FROM workflow_bags wb
    JOIN workflow_events we
      ON we.workflow_bag_id = wb.id
     AND we.event_type::text = 'BAG_FINALIZED'
    ${options.bagId ? sql`WHERE wb.id = ${options.bagId}::uuid` : sql``}
    GROUP BY wb.id, wb.finalized_at;
  `);

  const reports: BagBackfillReport[] = [];
  let backfilled = 0;
  let alreadyFinalized = 0;
  let skipped = 0;

  for (const row of candidates) {
    const decision = decideBackfill({
      workflowBagId: row.workflow_bag_id,
      currentFinalizedAt: row.current_finalized_at
        ? new Date(row.current_finalized_at)
        : null,
      latestFinalizedEventAt: row.latest_event_at
        ? new Date(row.latest_event_at)
        : null,
      hasBagFinalizedEvent: !!row.latest_event_at,
    });
    const finalizedAt =
      decision.status === "BACKFILLED" && row.latest_event_at
        ? new Date(row.latest_event_at)
        : row.current_finalized_at
          ? new Date(row.current_finalized_at)
          : null;
    reports.push({
      workflowBagId: row.workflow_bag_id,
      finalizedAt,
      ...decision,
    });
    if (decision.status === "BACKFILLED") backfilled++;
    else if (decision.status === "ALREADY_FINALIZED") alreadyFinalized++;
    else skipped++;
  }

  if (!options.dryRun) {
    // Write all backfills in a single transaction so the operation
    // is atomic. The list is bounded by the bags that actually have
    // BAG_FINALIZED events, so no performance concern at this scale.
    const toWrite = reports.filter((r) => r.status === "BACKFILLED");
    if (toWrite.length > 0) {
      await db.transaction(async (tx) => {
        for (const r of toWrite) {
          if (!r.finalizedAt) continue;
          await tx
            .update(workflowBags)
            .set({ finalizedAt: r.finalizedAt })
            .where(
              and(
                eq(workflowBags.id, r.workflowBagId),
                isNull(workflowBags.finalizedAt),
              ),
            );
        }
      });
    }
  }

  return {
    candidatesScanned: candidates.length,
    backfilled,
    alreadyFinalized,
    skipped,
    reports,
  };
}
