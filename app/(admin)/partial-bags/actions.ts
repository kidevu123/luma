"use server";

// PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1 — admin resolve action.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireLead } from "@/lib/auth-guards";
import { PARTIAL_BAG_RESOLUTION_METHODS } from "@/lib/production/partial-bag-resolution-constants";
import { resolvePartialBagInventoryLedger } from "@/lib/production/partial-bag-review-closeout";

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
