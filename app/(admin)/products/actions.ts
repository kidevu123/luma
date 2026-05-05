"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import { createProduct, updateProduct } from "@/lib/db/queries/products";

const schema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  kind: z.enum(["CARD", "BOTTLE", "VARIETY"]),
  tabletsPerUnit: z.coerce.number().int().min(0).optional().nullable(),
  unitsPerDisplay: z.coerce.number().int().min(0).optional().nullable(),
  displaysPerCase: z.coerce.number().int().min(0).optional().nullable(),
  defaultShelfLifeDays: z.coerce.number().int().min(0).optional().nullable(),
  zohoItemId: z.string().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

export async function saveProductAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    sku: formData.get("sku"),
    name: formData.get("name"),
    kind: formData.get("kind"),
    tabletsPerUnit: formData.get("tabletsPerUnit") || null,
    unitsPerDisplay: formData.get("unitsPerDisplay") || null,
    displaysPerCase: formData.get("displaysPerCase") || null,
    defaultShelfLifeDays: formData.get("defaultShelfLifeDays") || null,
    zohoItemId: formData.get("zohoItemId") || null,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...input } = parsed.data;
  try {
    if (id) await updateProduct(id, input, actor);
    else await createProduct(input, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/products");
  return { ok: true };
}
