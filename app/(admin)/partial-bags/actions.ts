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
