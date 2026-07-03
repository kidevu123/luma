"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireLead, requireAdmin } from "@/lib/auth-guards";
import {
  createFinishedLot,
  repairAutoIssueFinishedLotForWorkflowBag,
  setFinishedLotStatus,
  type FinishedLotStatus,
} from "@/lib/db/queries/finished-lots";
import { compact } from "@/lib/db/compact";
import { issueFinishedLotWithAllocationCloseout } from "@/lib/production/issue-lot-with-allocation-closeout";
import { listProductionOutputBacklogWithEligibility } from "@/lib/db/queries/production-output-backlog";
import { writeAudit } from "@/lib/db/audit";

const lotSchema = z.object({
  productId: z.string().uuid(),
  workflowBagId: z.string().uuid().optional().nullable(),
  finishedLotNumber: z.string().min(1).max(60),
  producedOn: z.string().date(),
  expiryDate: z.string().date(),
  unitsProduced: z.coerce.number().int().min(0).max(10_000_000),
  displaysProduced: z.coerce.number().int().min(0).optional().nullable(),
  casesProduced: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  inputs: z
    .array(
      z.object({
        batchId: z.string().uuid(),
        qtyConsumed: z.coerce.number().int().min(0),
      }),
    )
    .optional(),
});

export async function createFinishedLotAction(payload: unknown) {
  const actor = await requireLead();
  const parsed = lotSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    const { lot } = await createFinishedLot(compact(parsed.data), actor);
    revalidatePath("/finished-lots");
    revalidatePath("/floor-board");
    revalidatePath("/packaging-output");
    revalidatePath("/zoho-operations");
    return { ok: true as const, id: lot.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function createFinishedLotAndRedirect(payload: unknown) {
  const r = await createFinishedLotAction(payload);
  if (r && "error" in r && r.error) return { error: r.error };
  if (r && "ok" in r && r.id) redirect(`/finished-lots/${r.id}`);
}

const coordinatedLotSchema = lotSchema.extend({
  workflowBagId: z.string().uuid(),
  consumedQty: z.coerce.number().int().positive(),
  endingBalanceQty: z.coerce.number().int(),
  repairMissingAllocation: z.boolean().optional(),
  repairNotes: z.string().max(2000).optional().nullable(),
  repairStartingBalanceQty: z.coerce.number().int().positive().optional().nullable(),
});

/** LEAD: create finished lot + close allocation in one transaction. */
export async function issueFinishedLotWithAllocationAndRedirect(payload: unknown) {
  const actor = await requireLead();
  const parsed = coordinatedLotSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  let finishedLotId: string;
  try {
    const result = await issueFinishedLotWithAllocationCloseout(
      {
        productId: d.productId,
        workflowBagId: d.workflowBagId,
        finishedLotNumber: d.finishedLotNumber,
        producedOn: d.producedOn,
        expiryDate: d.expiryDate,
        unitsProduced: d.unitsProduced,
        displaysProduced: d.displaysProduced ?? null,
        casesProduced: d.casesProduced ?? null,
        notes: d.notes ?? null,
        consumedQty: d.consumedQty,
        endingBalanceQty: d.endingBalanceQty,
        repairMissingAllocation: d.repairMissingAllocation ?? false,
        repairNotes: d.repairNotes ?? null,
        repairStartingBalanceQty: d.repairStartingBalanceQty ?? null,
      },
      actor,
    );
    if (!result.ok) return { error: result.error };
    finishedLotId = result.finishedLotId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Issue lot failed." };
  }
  revalidatePath("/finished-lots");
  revalidatePath("/floor-board");
  revalidatePath("/packaging-output");
  revalidatePath("/zoho-production-operations");
  redirect(`/finished-lots/${finishedLotId}`);
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["PENDING_QC", "RELEASED", "ON_HOLD", "SHIPPED", "RECALLED"]),
  reason: z.string().max(500).optional(),
});

export async function repairAutoIssueFinishedLotAction(workflowBagId: string) {
  const actor = await requireLead();
  try {
    const result = await repairAutoIssueFinishedLotForWorkflowBag(workflowBagId, actor);
    if (!result.ok) return { error: result.message, reason: result.reason };
    revalidatePath("/packaging-output");
    revalidatePath("/finished-lots");
    return {
      ok: true as const,
      finishedLotId: result.finishedLotId,
      finishedLotNumber: result.finishedLotNumber,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Repair auto-issue failed." };
  }
}

// AUTO-ISSUE-BATCH-1 — issue finished lots for ALL currently-safe backlog rows
// in one explicit click. Reuses the per-row auto-issue service (which re-checks
// eligibility inside its own transaction — idempotent + race-safe), so only
// AUTO_ISSUE_READY rows are ever created. Does NOT commit to Zoho (that stays a
// separate admin-controlled step). Bounded per invocation.
const AUTO_ISSUE_BATCH_CAP = 100;

export type AutoIssueBatchResult =
  | {
      ok: true;
      issued: number;
      skipped: number;
      capped: boolean;
      issuedLots: Array<{ workflowBagId: string; finishedLotNumber: string | null }>;
      skippedRows: Array<{ workflowBagId: string; reason: string; message: string }>;
    }
  | { ok: false; error: string };

export async function autoIssueAllSafeLotsAction(): Promise<AutoIssueBatchResult> {
  const actor = await requireLead();
  try {
    const rows = await listProductionOutputBacklogWithEligibility(AUTO_ISSUE_BATCH_CAP);
    const ready = rows.filter((r) => r.evaluation.autoIssuable);

    const issuedLots: Array<{ workflowBagId: string; finishedLotNumber: string | null }> = [];
    const skippedRows: Array<{ workflowBagId: string; reason: string; message: string }> = [];

    for (const row of ready) {
      // Per-row: re-checks eligibility in-tx, creates the lot idempotently.
      const result = await repairAutoIssueFinishedLotForWorkflowBag(row.workflowBagId, actor);
      if (result.ok) {
        issuedLots.push({
          workflowBagId: row.workflowBagId,
          finishedLotNumber: result.finishedLotNumber,
        });
      } else {
        // A row that was ready at scan time but no longer safe (raced/changed)
        // is SKIPPED with its reason — never force-created.
        skippedRows.push({
          workflowBagId: row.workflowBagId,
          reason: result.reason,
          message: result.message,
        });
      }
    }

    // Batch-level audit — the explicit AUTO_FINISHED_LOT_ISSUE provenance, with
    // a note that Zoho output was NOT committed by this action.
    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "finished_lot.auto_issue_batch",
      targetType: "ProductionOutputBacklog",
      targetId: "batch",
      after: {
        source: "AUTO_FINISHED_LOT_ISSUE",
        candidates_scanned: rows.length,
        ready_at_scan: ready.length,
        issued: issuedLots.length,
        skipped: skippedRows.length,
        issued_lot_numbers: issuedLots.map((l) => l.finishedLotNumber),
        zoho_output_committed: false,
        note: "Auto-issued finished lots only; Zoho output remains a separate admin-controlled step.",
      },
    });

    if (issuedLots.length > 0) {
      revalidatePath("/packaging-output");
      revalidatePath("/finished-lots");
    }

    return {
      ok: true,
      issued: issuedLots.length,
      skipped: skippedRows.length,
      capped: rows.length >= AUTO_ISSUE_BATCH_CAP,
      issuedLots,
      skippedRows,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Auto-issue batch failed." };
  }
}

export async function setFinishedLotStatusAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await setFinishedLotStatus(
      parsed.data.id,
      parsed.data.status as FinishedLotStatus,
      actor,
      parsed.data.reason,
    );
    revalidatePath(`/finished-lots/${parsed.data.id}`);
    revalidatePath("/finished-lots");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Status change failed." };
  }
}
