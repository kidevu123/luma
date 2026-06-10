"use server";

// P0-LOT-BACKLOG — Production Output backlog auto-issue actions.
//
// The "Finalized — needs lot review" queue used to force a manual
// "Review / issue lot" on every row. These actions run the same
// auto-issue path that live packaging close-outs use, either per-row
// or in bulk, surfacing explicit blockers for rows that cannot issue.

import { revalidatePath } from "next/cache";
import { and, desc, isNull, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  inventoryBags,
  readBagState,
  workflowBags,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import {
  autoCreateAndReleaseFinishedLotForWorkflowBag,
  evaluateBacklogAutoIssueForWorkflowBag,
  runFinishedLotPostCommitEffects,
  type BacklogAutoIssueBlockerReason,
} from "@/lib/db/queries/finished-lots";

export type BacklogAutoIssueRowResult = {
  workflowBagId: string;
  receiptNumber: string | null;
  ok: boolean;
  finishedLotNumber?: string;
  reason?: BacklogAutoIssueBlockerReason;
  message?: string;
};

export type BacklogAutoIssueSummary = {
  issued: number;
  blocked: number;
  results: BacklogAutoIssueRowResult[];
};

type AutoIssueActor = Parameters<
  typeof autoCreateAndReleaseFinishedLotForWorkflowBag
>[1]["actor"];

async function issueOne(
  workflowBagId: string,
  actor: AutoIssueActor,
): Promise<BacklogAutoIssueRowResult> {
  const [receiptRow] = await db
    .select({
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .where(eq(workflowBags.id, workflowBagId));
  const receiptNumber = receiptRow?.receiptNumber ?? null;

  const evaluation = await evaluateBacklogAutoIssueForWorkflowBag(workflowBagId);
  if (!evaluation.ok) {
    return {
      workflowBagId,
      receiptNumber,
      ok: false,
      reason: evaluation.reason,
      message: evaluation.message,
    };
  }

  const result = await db.transaction(async (tx) =>
    autoCreateAndReleaseFinishedLotForWorkflowBag(tx, {
      workflowBagId,
      packagedAt: evaluation.packagedAt,
      counts: evaluation.counts,
      actor,
    }),
  );
  if (!result.ok) {
    return {
      workflowBagId,
      receiptNumber,
      ok: false,
      reason: result.reason,
      message: result.message,
    };
  }
  await runFinishedLotPostCommitEffects(result.effects);
  return {
    workflowBagId,
    receiptNumber,
    ok: true,
    finishedLotNumber: result.finishedLotNumber,
  };
}

/** Issue one backlog row (or report its blocker). */
export async function autoIssueLotForBagAction(
  workflowBagId: string,
): Promise<BacklogAutoIssueRowResult> {
  const actor = await requireAdmin();
  const result = await issueOne(workflowBagId, {
    id: actor.id,
    role: actor.role,
  });
  revalidatePath("/packaging-output");
  revalidatePath("/finished-lots");
  return result;
}

/** Bulk auto-issue: every finalized-without-lot bag (oldest first).
 *  Ready rows issue; blocked rows come back with explicit reasons. */
export async function autoIssueAllReadyAction(): Promise<BacklogAutoIssueSummary> {
  const actor = await requireAdmin();
  const backlog = await db
    .select({ id: workflowBags.id })
    .from(workflowBags)
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(
      and(
        sql`${workflowBags.finalizedAt} IS NOT NULL`,
        isNull(finishedLots.id),
        sql`COALESCE(${readBagState.excludedFromOutput}, false) = false`,
      ),
    )
    .orderBy(desc(workflowBags.finalizedAt));

  const results: BacklogAutoIssueRowResult[] = [];
  // Sequential on purpose: each issue is its own transaction and lot
  // numbers can collide across rows of the same receipt.
  for (const row of backlog) {
    results.push(await issueOne(row.id, { id: actor.id, role: actor.role }));
  }

  revalidatePath("/packaging-output");
  revalidatePath("/finished-lots");
  return {
    issued: results.filter((r) => r.ok).length,
    blocked: results.filter((r) => !r.ok).length,
    results,
  };
}
