// ZOHO-FINISHED-GOODS-OUTBOX-1 — Persist Zoho assembly ops after lot issuance.
//
// Calls the existing planner + enqueue service only. No Zoho HTTP, no worker.

import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { enqueueZohoAssemblyOpsForFinishedLot } from "./assembly-enqueue";

export type ZohoEnqueueAfterLotCreateInput = {
  finishedLotId: string;
  actor: Pick<CurrentUser, "id" | "role">;
};

export type ZohoEnqueueAfterLotCreateResult =
  | { ok: true; enqueued: number; existing: number; skipped: number }
  | { ok: false; reason: string };

/**
 * Plan + persist zoho_assembly_ops for a finished lot. Idempotent via
 * enqueueZohoAssemblyOpsForFinishedLot. Never calls Zoho Integration Service.
 */
export async function runZohoAssemblyEnqueueAfterLotCreate(
  input: ZohoEnqueueAfterLotCreateInput,
): Promise<ZohoEnqueueAfterLotCreateResult> {
  const { finishedLotId, actor } = input;
  try {
    const result = await enqueueZohoAssemblyOpsForFinishedLot(finishedLotId);
    if (!result) {
      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: "zoho.assembly.enqueue_skipped",
        targetType: "FinishedLot",
        targetId: finishedLotId,
        after: { reason: "no assembly plan for lot" },
      });
      return { ok: false, reason: "no assembly plan for lot" };
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "zoho.assembly.enqueued",
      targetType: "FinishedLot",
      targetId: finishedLotId,
      after: {
        enqueued: result.enqueued,
        existing: result.existing,
        skipped: result.skipped,
        overallStatus: result.plan.overallStatus,
      },
    });

    return {
      ok: true,
      enqueued: result.enqueued,
      existing: result.existing,
      skipped: result.skipped,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "enqueue failed";
    try {
      await writeAudit({
        actorId: actor.id,
        actorRole: actor.role,
        action: "zoho.assembly.enqueue_failed",
        targetType: "FinishedLot",
        targetId: finishedLotId,
        after: { reason },
      });
    } catch (auditErr) {
      console.error("[zoho.assembly.enqueue] audit write failed:", auditErr);
    }
    return { ok: false, reason };
  }
}
