"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import { productPackagingSpecs } from "@/lib/db/schema";

const PER_SCOPES = ["UNIT", "DISPLAY", "CASE"] as const;

const schema = z
  .object({
    productId: z.string().uuid(),
    packagingMaterialId: z.string().uuid(),
    perScope: z.enum(PER_SCOPES),
    qtyPerUnit: z.coerce.number().int().min(1, "Quantity must be > 0"),
    wasteAllowancePercent: z.coerce
      .number()
      .min(0, "Waste must be 0 or more")
      .max(100, "Waste must be 100 or less"),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine(
    // We don't allow zero. Zero means "not configured" — the row
    // shouldn't exist.
    (d) => d.qtyPerUnit > 0,
    { message: "Quantity must be > 0", path: ["qtyPerUnit"] },
  );

export async function savePackagingBomLineAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  await requireAdmin();
  const parsed = schema.safeParse({
    productId: formData.get("productId"),
    packagingMaterialId: formData.get("packagingMaterialId"),
    perScope: formData.get("perScope"),
    qtyPerUnit: formData.get("qtyPerUnit"),
    wasteAllowancePercent: formData.get("wasteAllowancePercent") || 0,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { wasteAllowancePercent, ...rest } = parsed.data;
  const valuesForDb = {
    ...rest,
    wasteAllowancePercent: String(wasteAllowancePercent),
  };
  try {
    // Upsert on the composite PK (productId, packagingMaterialId, perScope).
    // Existing row's qtyPerUnit + waste get overwritten — admins use this
    // form to update.
    await db
      .insert(productPackagingSpecs)
      .values(compact(valuesForDb))
      .onConflictDoUpdate({
        target: [
          productPackagingSpecs.productId,
          productPackagingSpecs.packagingMaterialId,
          productPackagingSpecs.perScope,
        ],
        set: {
          qtyPerUnit: valuesForDb.qtyPerUnit,
          wasteAllowancePercent: valuesForDb.wasteAllowancePercent,
          notes: valuesForDb.notes ?? null,
        },
      });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath(`/settings/packaging-bom`);
  return { ok: true };
}

export async function deletePackagingBomLineAction(input: {
  productId: string;
  packagingMaterialId: string;
  perScope: "UNIT" | "DISPLAY" | "CASE";
}): Promise<{ error?: string } | void> {
  await requireAdmin();
  const ok = z
    .object({
      productId: z.string().uuid(),
      packagingMaterialId: z.string().uuid(),
      perScope: z.enum(PER_SCOPES),
    })
    .safeParse(input);
  if (!ok.success) return { error: "Invalid input." };
  try {
    await db
      .delete(productPackagingSpecs)
      .where(
        and(
          eq(productPackagingSpecs.productId, input.productId),
          eq(productPackagingSpecs.packagingMaterialId, input.packagingMaterialId),
          eq(productPackagingSpecs.perScope, input.perScope),
        ),
      );
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Delete failed." };
  }
  revalidatePath(`/settings/packaging-bom`);
}
