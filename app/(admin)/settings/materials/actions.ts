"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingMaterials,
  packagingLots,
  productPackagingSpecs,
} from "@/lib/db/schema";

const MATERIAL_KINDS = [
  "BLISTER_CARD",
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
  category: z.enum(["PACKAGING", "MATERIAL"]).default("PACKAGING"),
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
    category: formData.get("category") || "PACKAGING",
    uom: formData.get("uom"),
    parLevel: formData.get("parLevel") || null,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...rest } = parsed.data;
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

export async function setMaterialCategoryAction(
  id: string,
  category: "PACKAGING" | "MATERIAL",
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return { error: "Invalid id." };
  try {
    await db
      .update(packagingMaterials)
      .set({ category })
      .where(eq(packagingMaterials.id, id));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Update failed." };
  }
  revalidatePath("/settings/materials");
  return { ok: true };
}

export async function deleteMaterialAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/settings/materials?err=Invalid+material+id");
  try {
    await db.delete(packagingMaterials).where(eq(packagingMaterials.id, id.data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Delete failed.";
    if (msg.includes("foreign key") || msg.includes("violates") || msg.includes("constraint")) {
      redirect(`/settings/materials?err=Has+linked+records&failedId=${id.data}`);
    }
    redirect(`/settings/materials?err=${encodeURIComponent(msg)}&failedId=${id.data}`);
  }
  revalidatePath("/settings/materials");
  revalidatePath("/inbound/packaging-materials");
}

export async function forceDeleteMaterialAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/settings/materials?err=Invalid+material+id");

  // Show what we're about to delete
  const [lots, bomRows] = await Promise.all([
    db.select({ id: packagingLots.id }).from(packagingLots).where(eq(packagingLots.packagingMaterialId, id.data)),
    db.select({ productId: productPackagingSpecs.productId }).from(productPackagingSpecs).where(eq(productPackagingSpecs.packagingMaterialId, id.data)),
  ]);

  // Cascade: delete lots, BOM specs, then the material
  await db.delete(packagingLots).where(eq(packagingLots.packagingMaterialId, id.data));
  await db.delete(productPackagingSpecs).where(eq(productPackagingSpecs.packagingMaterialId, id.data));
  await db.delete(packagingMaterials).where(eq(packagingMaterials.id, id.data));

  revalidatePath("/settings/materials");
  revalidatePath("/inbound/packaging-materials");
  redirect(`/settings/materials?deleted=${lots.length}lots+${bomRows.length}specs`);
}
