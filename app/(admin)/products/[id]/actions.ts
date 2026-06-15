"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  setAllowedTablet,
  upsertPackagingSpec,
  deletePackagingSpec,
  updateProduct,
} from "@/lib/db/queries/products";
import { compact } from "@/lib/db/compact";

const allowedSchema = z.object({
  productId: z.string().uuid(),
  tabletTypeId: z.string().uuid(),
  enabled: z.boolean(),
  isPrimary: z.boolean().optional(),
});

export async function toggleAllowedTabletAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = allowedSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await setAllowedTablet(compact(parsed.data), actor);
    revalidatePath(`/products/${parsed.data.productId}`);
    revalidatePath(`/products`);
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

const specSchema = z.object({
  productId: z.string().uuid(),
  packagingMaterialId: z.string().uuid(),
  qtyPerUnit: z.coerce.number().int().min(1).max(100000),
  perScope: z.enum(["UNIT", "DISPLAY", "CASE"]),
  notes: z.string().max(500).optional().nullable(),
});

export async function saveSpecAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = specSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await upsertPackagingSpec(compact(parsed.data), actor);
    revalidatePath(`/products/${parsed.data.productId}`);
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}

const deleteSpecSchema = z.object({
  productId: z.string().uuid(),
  packagingMaterialId: z.string().uuid(),
  perScope: z.string().min(1),
});

export async function deleteSpecAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = deleteSpecSchema.safeParse(payload);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await deletePackagingSpec(parsed.data, actor);
    revalidatePath(`/products/${parsed.data.productId}`);
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Delete failed." };
  }
}

// Lightweight spec-only update for the inline Spec card on the product
// detail page. Used by the "Fix product setup" loop from the Output
// queue — operator lands here, fixes shelf life / packaging structure
// / tablets per unit, returns to the queue.
//
// We keep this separate from the full saveProductAction so the form
// doesn't have to round-trip the entire product payload (name, SKU,
// kind, Zoho IDs) just to change one number.
const specPatchSchema = z.object({
  productId: z.string().uuid(),
  tabletsPerUnit: z.number().int().min(1).max(10000).nullable(),
  unitsPerDisplay: z.number().int().min(1).max(10000).nullable(),
  displaysPerCase: z.number().int().min(1).max(10000).nullable(),
  defaultShelfLifeDays: z.number().int().min(1).max(3650).nullable(),
});

export async function updateProductSpecAction(payload: unknown) {
  const actor = await requireAdmin();
  const parsed = specPatchSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { productId, ...patch } = parsed.data;
  try {
    await updateProduct(productId, patch, actor);
    revalidatePath(`/products/${productId}`);
    // The Production Output queue chip + Action Center tile read product
    // spec via the eligibility query; revalidating /packaging-output
    // and /dashboard guarantees the next render reflects the fix.
    revalidatePath("/packaging-output");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
}
