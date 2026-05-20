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
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...patch } = parsed.data;
  try {
    await updateProduct(id, patch, actor);
    revalidatePath(`/products/${id}`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}
