// Projector-side undo for erroneous BAG_FINALIZED after legacy partial packaging.

import { eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import { qrCards, readBagState, workflowBags } from "@/lib/db/schema";
import { isVoidErroneousBagFinalizationCorrection } from "@/lib/production/bag-finalization-void";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export async function applyVoidErroneousBagFinalizationRepair(
  tx: Tx,
  args: {
    workflowBagId: string;
    resumeStage: string;
    bagCardScanToken?: string | null;
    occurredAt: Date;
  },
): Promise<void> {
  await tx
    .update(workflowBags)
    .set({ finalizedAt: null })
    .where(eq(workflowBags.id, args.workflowBagId));

  await tx
    .update(readBagState)
    .set({
      stage: args.resumeStage,
      isFinalized: false,
      updatedAt: args.occurredAt,
    })
    .where(eq(readBagState.workflowBagId, args.workflowBagId));

  const scanToken = args.bagCardScanToken?.trim();
  if (scanToken) {
    await tx
      .update(qrCards)
      .set({
        status: "ASSIGNED",
        assignedWorkflowBagId: args.workflowBagId,
      })
      .where(eq(qrCards.scanToken, scanToken));
  } else {
    await tx
      .update(qrCards)
      .set({
        status: "ASSIGNED",
        assignedWorkflowBagId: args.workflowBagId,
      })
      .where(eq(qrCards.assignedWorkflowBagId, args.workflowBagId));
  }
}

export function readResumeStageFromVoidCorrection(
  payload: Record<string, unknown>,
): string {
  const corrected = payload.corrected_value;
  if (
    corrected &&
    typeof corrected === "object" &&
    typeof (corrected as Record<string, unknown>).resume_stage === "string"
  ) {
    return (corrected as Record<string, unknown>).resume_stage as string;
  }
  return "BLISTERED";
}

export function shouldApplyVoidErroneousBagFinalizationRepair(
  payload: Record<string, unknown>,
): boolean {
  return isVoidErroneousBagFinalizationCorrection(payload);
}

/** True when this BAG_FINALIZED event id is voided by a correction on the bag. */
export async function isWorkflowBagFinalizedEventVoided(
  tx: Tx,
  workflowBagId: string,
  bagFinalizedEventId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1
    FROM workflow_events
    WHERE workflow_bag_id = ${workflowBagId}::uuid
      AND event_type = 'SUBMISSION_CORRECTED'
      AND payload->>'correction_kind' = 'VOID_ERRONEOUS_BAG_FINALIZATION'
      AND payload->>'corrected_event_id' = ${bagFinalizedEventId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.length > 0;
}
