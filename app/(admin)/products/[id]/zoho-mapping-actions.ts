"use server";

// ZOHO-ASSY-1 — Dedicated action for saving Zoho composite-item ID
// mappings on a product.  Kept separate from saveProductAction to
// isolate concerns and reduce merge-conflict surface.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import { updateProduct } from "@/lib/db/queries/products";

const schema = z.object({
  id:                z.string().uuid(),
  zohoItemIdUnit:    z.string().max(100).optional().nullable(),
  zohoItemIdDisplay: z.string().max(100).optional().nullable(),
  zohoItemIdCase:    z.string().max(100).optional().nullable(),
  // WAREHOUSE-RESOLUTION-v1.3.0 — optional per-product warehouse
  // override. Trimmed; empty becomes null so falling-through to the
  // app-level default is the easy default for products that don't
  // want their own routing.
  zohoDefaultWarehouseId: z.string().max(80).optional().nullable(),
});

export async function updateProductZohoAssemblyMappingAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true }> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id:                formData.get("id"),
    zohoItemIdUnit:    formData.get("zohoItemIdUnit")    || null,
    zohoItemIdDisplay: formData.get("zohoItemIdDisplay") || null,
    zohoItemIdCase:    formData.get("zohoItemIdCase")    || null,
    zohoDefaultWarehouseId:
      (formData.get("zohoDefaultWarehouseId") as string | null)?.trim() || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, zohoItemIdUnit, ...rest } = parsed.data;

  // Back-sync zohoItemId (commercial trace, 60-char limit) from unit ID.
  // If unit ID is absent or too long for the legacy column, explicitly clear
  // zohoItemId so the two columns never diverge.
  const zohoItemId =
    zohoItemIdUnit === null || zohoItemIdUnit === undefined || zohoItemIdUnit.length > 60
      ? null
      : zohoItemIdUnit;

  const patch = {
    ...rest,
    zohoItemIdUnit,
    zohoItemId,
  };

  try {
    await updateProduct(id, patch, actor);
    revalidatePath(`/products/${id}`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}
