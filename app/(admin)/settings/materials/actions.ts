"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import { packagingMaterials } from "@/lib/db/schema";

// Allowed material kinds (the canonical lexicon for Phase H). The
// underlying enum on packaging_material_kind has more values for
// historical reasons (BLISTER_FOIL, HEAT_SEAL_FILM, DESICCANT,
// COTTON, OTHER); we expose the Phase-H subset to the admin form
// + map DISPLAY/CASE → DISPLAY_BOX/MASTER_CASE labels in the UI.

const MATERIAL_KINDS = [
  "DISPLAY",
  "CASE",
  "LABEL",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "INSERT",
  "SHRINK_BAND",
  "PVC_ROLL",
  "FOIL_ROLL",
  "OTHER",
] as const;

const schema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  kind: z.enum(MATERIAL_KINDS),
  uom: z.string().min(1).max(40),
  parLevel: z.coerce.number().int().min(0).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

export async function saveMaterialItemAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    sku: formData.get("sku"),
    name: formData.get("name"),
    kind: formData.get("kind"),
    uom: formData.get("uom"),
    parLevel: formData.get("parLevel") || null,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
  // Duplicate-SKU check on create. The schema enforces unique sku
  // index, but we surface a friendlier error before hitting it.
  if (!id) {
    const dupe = await db
      .select({ id: packagingMaterials.id })
      .from(packagingMaterials)
      .where(eq(packagingMaterials.sku, rest.sku))
      .limit(1);
    if (dupe.length > 0) {
      return { error: `A material with SKU ${rest.sku} already exists.` };
    }
  }
  try {
    if (id) {
      await db
        .update(packagingMaterials)
        .set(compact(rest))
        .where(eq(packagingMaterials.id, id));
    } else {
      await db.insert(packagingMaterials).values(compact(rest));
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/settings/materials");
  return { ok: true };
}

export async function toggleMaterialItemActiveAction(
  id: string,
  active: boolean,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return { error: "Invalid id." };
  try {
    await db
      .update(packagingMaterials)
      .set({ isActive: active })
      .where(eq(packagingMaterials.id, id));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Update failed." };
  }
  revalidatePath("/settings/materials");
  return { ok: true };
}

export async function deleteMaterialAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return { error: "Invalid id." };
  try {
    await db.delete(packagingMaterials).where(and(eq(packagingMaterials.id, id.data)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    if (msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint")) {
      return { error: "This material has receiving or BOM records — deactivate it instead of deleting." };
    }
    return { error: msg };
  }
  revalidatePath("/settings/materials");
  revalidatePath("/inbound/packaging-materials");
  return { ok: true };
}
