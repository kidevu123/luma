"use server";

// PBOM-2 — admin actions for product_material_compatibility.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingMaterials,
  productMaterialCompatibility,
} from "@/lib/db/schema";
import {
  COMPATIBILITY_ROLES,
  canRegisterCompatibility,
  type CompatibilityRole,
} from "@/lib/production/product-material-compatibility";
import type {
  PackagingBomScope,
  PackagingMaterialKind,
} from "@/lib/production/packaging-bom-kinds";

const SCOPES = ["UNIT", "DISPLAY", "CASE"] as const;

const addSchema = z.object({
  productId: z.string().uuid(),
  routeId: z.string().uuid().optional().nullable(),
  materialId: z.string().uuid(),
  scope: z.enum(SCOPES),
  compatibilityRole: z.enum(COMPATIBILITY_ROLES),
  required: z
    .string()
    .optional()
    .transform((s) => s === "true" || s === "1" || s === "on"),
  defaultForProduct: z
    .string()
    .optional()
    .transform((s) => s === "true" || s === "1" || s === "on"),
  notes: z.string().max(2000).optional().nullable(),
});

type ActionResult = { ok?: true; error?: string };

export async function addCompatibilityAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin();
  const parsed = addSchema.safeParse({
    productId: formData.get("productId"),
    routeId: formData.get("routeId") || null,
    materialId: formData.get("materialId"),
    scope: formData.get("scope"),
    compatibilityRole: formData.get("compatibilityRole"),
    required: (formData.get("required") as string) ?? "false",
    defaultForProduct: (formData.get("defaultForProduct") as string) ?? "false",
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const input = parsed.data;

  // Pull material kind for the kind-axis check.
  const [matRow] = await db
    .select({ kind: packagingMaterials.kind, isActive: packagingMaterials.isActive })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, input.materialId));
  if (!matRow) return { error: "Packaging material not found." };
  if (!matRow.isActive) return { error: "Packaging material is inactive." };
  const guard = canRegisterCompatibility(
    matRow.kind as PackagingMaterialKind,
    input.scope as PackagingBomScope,
  );
  if (!guard.ok) return { error: guard.reason };

  try {
    await db.transaction(async (tx) => {
      // If defaultForProduct=true, demote any existing active default
      // for the same (product, route, scope, role) tuple. The partial-
      // unique would otherwise refuse the INSERT.
      if (input.defaultForProduct) {
        const route = input.routeId ?? null;
        await tx
          .update(productMaterialCompatibility)
          .set({ defaultForProduct: false, updatedAt: new Date() })
          .where(
            and(
              eq(productMaterialCompatibility.productId, input.productId),
              route == null
                ? sql`${productMaterialCompatibility.routeId} IS NULL`
                : eq(productMaterialCompatibility.routeId, route),
              eq(productMaterialCompatibility.scope, input.scope),
              eq(
                productMaterialCompatibility.compatibilityRole,
                input.compatibilityRole,
              ),
              eq(productMaterialCompatibility.defaultForProduct, true),
              eq(productMaterialCompatibility.active, true),
            ),
          );
      }
      await tx
        .insert(productMaterialCompatibility)
        .values({
          productId: input.productId,
          routeId: input.routeId ?? null,
          materialId: input.materialId,
          scope: input.scope,
          compatibilityRole: input.compatibilityRole,
          required: input.required,
          defaultForProduct: input.defaultForProduct,
          notes: input.notes ?? null,
        });
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Save failed.",
    };
  }
  revalidatePath("/settings/product-material-compatibility");
  revalidatePath("/settings/packaging-bom");
  return { ok: true };
}

export async function deactivateCompatibilityAction(input: {
  id: string;
}): Promise<ActionResult> {
  await requireAdmin();
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Invalid input." };
  try {
    await db
      .update(productMaterialCompatibility)
      .set({
        active: false,
        defaultForProduct: false,
        effectiveTo: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productMaterialCompatibility.id, parsed.data.id));
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Deactivate failed.",
    };
  }
  revalidatePath("/settings/product-material-compatibility");
  revalidatePath("/settings/packaging-bom");
  return { ok: true };
}
