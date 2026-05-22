"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import { createProduct, updateProduct, deleteProduct } from "@/lib/db/queries/products";

function generateSku(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `LUMA-${slug}-${suffix}`;
}

const schema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().max(60).optional().nullable(),
  name: z.string().min(1).max(120),
  kind: z.enum(["CARD", "BOTTLE", "VARIETY"]),
  tabletsPerUnit: z.coerce.number().int().min(0).optional().nullable(),
  unitsPerDisplay: z.coerce.number().int().min(0).optional().nullable(),
  displaysPerCase: z.coerce.number().int().min(0).optional().nullable(),
  defaultShelfLifeDays: z.coerce.number().int().min(0).optional().nullable(),
  zohoItemId: z.string().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
  zohoItemIdUnit:    z.string().max(100).optional().nullable(),
  zohoItemIdDisplay: z.string().max(100).optional().nullable(),
  zohoItemIdCase:    z.string().max(100).optional().nullable(),
});

export async function saveProductAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true; id?: string }> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    sku: formData.get("sku") || null,
    name: formData.get("name"),
    kind: formData.get("kind"),
    tabletsPerUnit: formData.get("tabletsPerUnit") || null,
    unitsPerDisplay: formData.get("unitsPerDisplay") || null,
    displaysPerCase: formData.get("displaysPerCase") || null,
    defaultShelfLifeDays: formData.get("defaultShelfLifeDays") || null,
    zohoItemId: (formData.get("zohoItemId") as string | null) || null,
    isActive: formData.get("isActive") === "on",
    // Assembly IDs: undefined → compact() drops the key → Drizzle skips column entirely.
    // Empty string also maps to undefined (intentional — use the mapping form to clear).
    zohoItemIdUnit:    (formData.get("zohoItemIdUnit") as string | null) || undefined,
    zohoItemIdDisplay: (formData.get("zohoItemIdDisplay") as string | null) || undefined,
    zohoItemIdCase:    (formData.get("zohoItemIdCase") as string | null) || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, sku, ...rest } = parsed.data;
  const resolvedSku = sku?.trim() || generateSku(rest.name);
  const input = { sku: resolvedSku, ...rest };
  try {
    if (id) {
      await updateProduct(id, input, actor);
      revalidatePath("/products");
      return { ok: true };
    } else {
      const row = await createProduct(input, actor);
      revalidatePath("/products");
      return { ok: true, id: row.id };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

export async function deleteProductAction(
  id: string,
): Promise<{ error?: string; ok?: true }> {
  const actor = await requireAdmin();
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { error: "Invalid product ID." };
  try {
    await deleteProduct(parsed.data, actor);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    if (msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint")) {
      return { error: "This product has production records and cannot be deleted. Deactivate it instead." };
    }
    return { error: msg };
  }
  revalidatePath("/products");
  return { ok: true };
}
