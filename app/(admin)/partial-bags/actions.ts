"use server";

// PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1 — admin resolve action.
// P1-PARTIAL-CORRECTIONS — admin correction actions (correct remaining,
// mark depleted, hold, return to stock, void). All append correction
// sessions/events + audit; the original ledger is never edited.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin, requireLead } from "@/lib/auth-guards";
import { PARTIAL_BAG_RESOLUTION_METHODS } from "@/lib/production/partial-bag-resolution-constants";
import { resolvePartialBagInventoryLedger } from "@/lib/production/partial-bag-review-closeout";
import {
  correctPartialBagRemaining,
  markPartialBagDepletedAdmin,
  setPartialBagHold,
  voidPartialBagRecord,
  type PartialBagCorrectionResult,
} from "@/lib/production/partial-bag-admin-corrections";
import {
  applySafeActiveAllocationBackfill,
  loadActiveWorkflowBagBackfillReport,
  summarizeBackfillReport,
} from "@/lib/production/backfill-missing-active-allocation";
import { resolveAllocationFromProductionOutput } from "@/lib/production/system-derived-allocation-resolution";
import { rebaseOpenSessionStartingBalance } from "@/lib/production/open-session-rebase";

const resolveSchema = z.object({
  inventoryBagId: z.string().uuid(),
  remainingTabletCount: z.coerce.number().int().min(0),
  resolutionMethod: z.enum(PARTIAL_BAG_RESOLUTION_METHODS),
  note: z.string().min(1).max(500),
  consumedQty: z.coerce.number().int().min(0).optional().nullable(),
});

export type ResolvePartialBagInventoryResult =
  | { ok: true }
  | { ok: false; error: string };

export async function resolvePartialBagInventoryAction(
  formData: FormData,
): Promise<ResolvePartialBagInventoryResult> {
  const actor = await requireLead();
  const parsed = resolveSchema.safeParse({
    inventoryBagId: formData.get("inventoryBagId"),
    remainingTabletCount: formData.get("remainingTabletCount"),
    resolutionMethod: formData.get("resolutionMethod"),
    note: formData.get("note"),
    consumedQty: formData.get("consumedQty") || undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const result = await resolvePartialBagInventoryLedger({
    inventoryBagId: parsed.data.inventoryBagId,
    remainingTabletCount: parsed.data.remainingTabletCount,
    resolutionMethod: parsed.data.resolutionMethod,
    note: parsed.data.note,
    consumedQty: parsed.data.consumedQty ?? null,
    actor,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/partial-bags");
  revalidatePath(`/partial-bags/${parsed.data.inventoryBagId}/resolve`);
  revalidatePath("/production/start");
  return { ok: true };
}

// ── SPLIT-BAG-1 — system-derived closeout from production output ─────

const systemDerivedSchema = z.object({
  inventoryBagId: z.string().uuid(),
  // Optional supporting evidence — recorded, never overrides the derived value.
  operatorRemainingEstimate: z.coerce.number().int().min(0).optional().nullable(),
  weighBackGrams: z.coerce.number().int().min(0).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

/** One-click "Use calculated remaining" — resolves the OPEN allocation session
 *  from previous production output so the bag becomes ready to reuse, without a
 *  manual count/weigh-back. Fails closed with an explicit reason otherwise. */
export async function useCalculatedRemainingAction(
  formData: FormData,
): Promise<{ ok: true; remaining: number; depleted: boolean } | { ok: false; error: string }> {
  const actor = await requireLead();
  const parsed = systemDerivedSchema.safeParse({
    inventoryBagId: formData.get("inventoryBagId"),
    operatorRemainingEstimate:
      formData.get("operatorRemainingEstimate") || undefined,
    weighBackGrams: formData.get("weighBackGrams") || undefined,
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const result = await resolveAllocationFromProductionOutput({
    inventoryBagId: parsed.data.inventoryBagId,
    actor: { id: actor.id, role: actor.role },
    operatorRemainingEstimate: parsed.data.operatorRemainingEstimate ?? null,
    weighBackGrams: parsed.data.weighBackGrams ?? null,
    note: parsed.data.note ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/partial-bags");
  revalidatePath("/production/start");
  revalidatePath(`/partial-bags/${parsed.data.inventoryBagId}/resolve`);
  return { ok: true, remaining: result.derivedRemainingTablets, depleted: result.depleted };
}

// ── P1-PARTIAL-CORRECTIONS ──────────────────────────────────────────

const correctionBaseSchema = z.object({
  inventoryBagId: z.string().uuid(),
  reason: z.string().min(5).max(500),
});

function revalidatePartialBagSurfaces(): void {
  revalidatePath("/partial-bags");
  revalidatePath("/production/start");
  revalidatePath("/packaging-output");
}

// REBASE-OPEN-SESSION-1 — correct an OPEN session's wrong starting balance
// (pre-v1.16.0 bug) to the prior returned balance, IN PLACE. Leaves the session
// OPEN + QR assigned + run able to accept production later. Admin-gated, audited.
export async function rebaseOpenSessionStartingBalanceAction(
  formData: FormData,
): Promise<{ ok: true; newStartingBalance: number } | { ok: false; error: string }> {
  const actor = await requireAdmin();
  const parsed = z
    .object({
      inventoryBagId: z.string().uuid(),
      note: z.string().max(1000).optional().nullable(),
    })
    .safeParse({
      inventoryBagId: formData.get("inventoryBagId"),
      note: formData.get("note") || undefined,
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const result = await rebaseOpenSessionStartingBalance({
    inventoryBagId: parsed.data.inventoryBagId,
    note: parsed.data.note ?? null,
    actor: { id: actor.id, role: actor.role },
  });
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePartialBagSurfaces();
  revalidatePath(`/partial-bags/${parsed.data.inventoryBagId}/resolve`);
  return { ok: true, newStartingBalance: result.newStartingBalance };
}

export async function correctPartialBagRemainingAction(
  formData: FormData,
): Promise<PartialBagCorrectionResult> {
  const actor = await requireAdmin();
  const parsed = correctionBaseSchema
    .extend({
      newRemaining: z.coerce.number().int().min(0),
      method: z.enum(PARTIAL_BAG_RESOLUTION_METHODS),
    })
    .safeParse({
      inventoryBagId: formData.get("inventoryBagId"),
      reason: formData.get("reason"),
      newRemaining: formData.get("newRemaining"),
      method: formData.get("method"),
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const result = await correctPartialBagRemaining({
    ...parsed.data,
    actor: { id: actor.id, role: actor.role },
  });
  if (result.ok) revalidatePartialBagSurfaces();
  return result;
}

export async function markPartialBagDepletedAction(
  formData: FormData,
): Promise<PartialBagCorrectionResult> {
  const actor = await requireAdmin();
  const parsed = correctionBaseSchema.safeParse({
    inventoryBagId: formData.get("inventoryBagId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const result = await markPartialBagDepletedAdmin({
    ...parsed.data,
    actor: { id: actor.id, role: actor.role },
  });
  if (result.ok) revalidatePartialBagSurfaces();
  return result;
}

export async function setPartialBagHoldAction(
  formData: FormData,
): Promise<PartialBagCorrectionResult> {
  const actor = await requireAdmin();
  const parsed = correctionBaseSchema
    .extend({ hold: z.enum(["true", "false"]) })
    .safeParse({
      inventoryBagId: formData.get("inventoryBagId"),
      reason: formData.get("reason"),
      hold: formData.get("hold"),
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const result = await setPartialBagHold({
    inventoryBagId: parsed.data.inventoryBagId,
    reason: parsed.data.reason,
    hold: parsed.data.hold === "true",
    actor: { id: actor.id, role: actor.role },
  });
  if (result.ok) revalidatePartialBagSurfaces();
  return result;
}

export async function voidPartialBagRecordAction(
  formData: FormData,
): Promise<PartialBagCorrectionResult> {
  const actor = await requireAdmin();
  const parsed = correctionBaseSchema.safeParse({
    inventoryBagId: formData.get("inventoryBagId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const result = await voidPartialBagRecord({
    ...parsed.data,
    actor: { id: actor.id, role: actor.role },
  });
  if (result.ok) revalidatePartialBagSurfaces();
  return result;
}

export type BackfillSafeMissingAllocationsResult =
  | {
      ok: true;
      repaired: number;
      skipped: number;
      sessionIds: string[];
      errors: Array<{ workflowBagId: string; error: string }>;
    }
  | { ok: false; error: string };

export async function backfillSafeMissingAllocationsAction(): Promise<BackfillSafeMissingAllocationsResult> {
  const actor = await requireLead();
  const report = await loadActiveWorkflowBagBackfillReport();
  const summary = summarizeBackfillReport(report);
  if (summary.safeCount === 0) {
    return {
      ok: true,
      repaired: 0,
      skipped: summary.total,
      sessionIds: [],
      errors: [],
    };
  }

  const result = await applySafeActiveAllocationBackfill({
    actor: { id: actor.id, role: actor.role },
  });

  revalidatePath("/partial-bags");
  revalidatePath("/admin/partial-bags");

  return {
    ok: true,
    repaired: result.repaired.length,
    skipped: summary.total - summary.safeCount + result.skipped.length,
    sessionIds: result.repaired.map((r) => r.sessionId),
    errors: result.errors,
  };
}
