"use server";

// PO-CLOSEOUT-COMMAND-CENTER-1 — PO-scoped wrappers around the EXISTING per-row
// safe services. They add no business logic: they derive the eligible set for
// ONE PO from the read-only evaluator, then call the same per-row services the
// global batch actions use (each re-checks eligibility in its own transaction →
// idempotent + race-safe). They never touch anything outside the PO, never
// commit to Zoho, and write a PO-scoped batch audit.

import { requireLead } from "@/lib/auth-guards";
import { revalidatePath } from "next/cache";
import { writeAudit } from "@/lib/db/audit";
import { loadPoCloseout } from "@/lib/db/queries/po-closeout";
import {
  repairAutoIssueFinishedLotForWorkflowBag,
  setFinishedLotStatus,
} from "@/lib/db/queries/finished-lots";
import { evaluateFinishedLotReleaseEligibility } from "@/lib/production/finished-lot-release-eligibility";

const PO_BATCH_CAP = 100;

export type PoBatchResult =
  | { ok: true; affected: number; skipped: number; capped: boolean; skippedReasons: string[] }
  | { ok: false; error: string };

/** Auto-issue every finished lot that the closeout evaluator marks READY for
 *  this PO (action AUTO_ISSUE_FINISHED_LOT). Reuses repairAutoIssueFinishedLotForWorkflowBag. */
export async function autoIssueSafeLotsForPoAction(poId: string): Promise<PoBatchResult> {
  const actor = await requireLead();
  try {
    const summary = await loadPoCloseout(poId);
    if (!summary) return { ok: false, error: "PO not found." };
    const targets = summary.rows
      .filter((r) => r.status === "READY_FOR_ACTION" && r.action === "AUTO_ISSUE_FINISHED_LOT" && r.workflowBagId)
      .slice(0, PO_BATCH_CAP);

    const issued: string[] = [];
    const skipped: string[] = [];
    for (const r of targets) {
      const result = await repairAutoIssueFinishedLotForWorkflowBag(r.workflowBagId!, actor);
      if (result.ok) issued.push(result.finishedLotNumber ?? r.workflowBagId!);
      else skipped.push(result.message);
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "finished_lot.auto_issue_batch",
      targetType: "PoCloseout",
      targetId: poId,
      after: {
        source: "AUTO_FINISHED_LOT_ISSUE",
        scope: "PO",
        po_id: poId,
        po_number: summary.poNumber,
        ready_at_scan: targets.length,
        issued: issued.length,
        skipped: skipped.length,
        issued_lot_numbers: issued,
        skipped_reasons: skipped,
        zoho_output_committed: false,
        note: "PO-scoped auto-issue only; Zoho output remains a separate admin/cron-controlled step.",
      },
    });

    if (issued.length > 0) {
      revalidatePath(`/po-closeout/${poId}`);
      revalidatePath("/po-closeout");
      revalidatePath("/packaging-output");
      revalidatePath("/finished-lots");
    }
    return {
      ok: true,
      affected: issued.length,
      skipped: skipped.length,
      capped: summary.rows.filter((r) => r.action === "AUTO_ISSUE_FINISHED_LOT").length > PO_BATCH_CAP,
      skippedReasons: skipped,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "PO auto-issue failed." };
  }
}

/** Auto-release every PENDING_QC lot the evaluator marks READY for this PO
 *  (action AUTO_RELEASE_FINISHED_LOT). Reuses the manual setFinishedLotStatus
 *  release path with a per-lot eligibility re-check. Does NOT commit to Zoho. */
export async function autoReleaseSafeLotsForPoAction(poId: string): Promise<PoBatchResult> {
  const actor = await requireLead();
  try {
    const summary = await loadPoCloseout(poId);
    if (!summary) return { ok: false, error: "PO not found." };
    const targets = summary.rows
      .filter((r) => r.status === "READY_FOR_ACTION" && r.action === "AUTO_RELEASE_FINISHED_LOT" && r.finishedLotId)
      .slice(0, PO_BATCH_CAP);

    const released: string[] = [];
    const skipped: string[] = [];
    for (const r of targets) {
      // Re-check eligibility right before releasing (idempotent + race-safe).
      const recheck = await evaluateFinishedLotReleaseEligibility(r.finishedLotId!);
      if (recheck.status !== "AUTO_RELEASE_READY") {
        skipped.push(recheck.message);
        continue;
      }
      const row = await setFinishedLotStatus(
        r.finishedLotId!,
        "RELEASED",
        actor,
        "Auto-released via PO Closeout — passed QC auto-release eligibility. Zoho output NOT committed by this step.",
      );
      released.push(row.finishedLotNumber);
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "finished_lot.auto_release_batch",
      targetType: "PoCloseout",
      targetId: poId,
      after: {
        source: "AUTO_QC_RELEASE",
        scope: "PO",
        po_id: poId,
        po_number: summary.poNumber,
        ready_at_scan: targets.length,
        released: released.length,
        skipped: skipped.length,
        released_lot_numbers: released,
        skipped_reasons: skipped,
        zoho_output_committed: false,
        note: "PO-scoped internal QC release only; Zoho output remains a separate admin/cron-controlled step.",
      },
    });

    if (released.length > 0) {
      revalidatePath(`/po-closeout/${poId}`);
      revalidatePath("/po-closeout");
      revalidatePath("/finished-lots");
    }
    return {
      ok: true,
      affected: released.length,
      skipped: skipped.length,
      capped: summary.rows.filter((r) => r.action === "AUTO_RELEASE_FINISHED_LOT").length > PO_BATCH_CAP,
      skippedReasons: skipped,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "PO auto-release failed." };
  }
}
