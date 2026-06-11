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
  endingBalanceQty: z.coerce.number().int().min(0),
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
    revalidatePath("/finished-lots");
    revalidatePath("/floor-board");
    revalidatePath("/packaging-output");
    revalidatePath("/zoho-production-operations");
    redirect(`/finished-lots/${result.finishedLotId}`);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Issue lot failed." };
  }
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
