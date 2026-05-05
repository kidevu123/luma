"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  setAllowedTablet,
  upsertPackagingSpec,
  deletePackagingSpec,
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
