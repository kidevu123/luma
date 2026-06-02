"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { refreshRollDerivedReadModels } from "@/lib/projector/roll-derived-read-models";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  blisterMaterialStandards,
  packagingMaterials,
} from "@/lib/db/schema";

const ROLES = ["PVC", "FOIL"] as const;

const schema = z
  .object({
    id: z.string().uuid().optional(),
    productId: z.string().uuid().optional().nullable(),
    packagingMaterialId: z.string().uuid(),
    materialRole: z.enum(ROLES),
    expectedGramsPerBlister: z.coerce.number().min(0).optional().nullable(),
    expectedBlistersPerKg: z.coerce.number().min(0).optional().nullable(),
    setupWasteGrams: z.coerce.number().int().min(0),
    changeoverWasteGrams: z.coerce.number().int().min(0),
    effectiveFrom: z.string().date(),
    effectiveTo: z.string().date().optional().nullable(),
    isActive: z.coerce.boolean().optional(),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine(
    (d) =>
      (d.expectedGramsPerBlister != null && d.expectedGramsPerBlister > 0) ||
      (d.expectedBlistersPerKg != null && d.expectedBlistersPerKg > 0),
    {
      message:
        "Set either expected grams per blister OR expected blisters per kg.",
      path: ["expectedGramsPerBlister"],
    },
  );

export async function saveBlisterStandardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    productId: formData.get("productId") || null,
    packagingMaterialId: formData.get("packagingMaterialId"),
    materialRole: formData.get("materialRole"),
    expectedGramsPerBlister: formData.get("expectedGramsPerBlister") || null,
    expectedBlistersPerKg: formData.get("expectedBlistersPerKg") || null,
    setupWasteGrams: formData.get("setupWasteGrams") || 0,
    changeoverWasteGrams: formData.get("changeoverWasteGrams") || 0,
    effectiveFrom: formData.get("effectiveFrom"),
    effectiveTo: formData.get("effectiveTo") || null,
    isActive: formData.get("isActive") === "on",
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  // Verify the material is actually a roll kind.
  const [mat] = await db
    .select({ kind: packagingMaterials.kind })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, parsed.data.packagingMaterialId))
    .limit(1);
  if (!mat) return { error: "Material not found." };
  if (!["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(mat.kind)) {
    return {
      error: "Material must be PVC_ROLL or FOIL_ROLL — picked " + mat.kind,
    };
  }

  const { id, ...rest } = parsed.data;
  // Drizzle wants strings for numerics.
  const valuesForDb = {
    ...rest,
    expectedGramsPerBlister:
      rest.expectedGramsPerBlister != null
        ? String(rest.expectedGramsPerBlister)
        : null,
    expectedBlistersPerKg:
      rest.expectedBlistersPerKg != null
        ? String(rest.expectedBlistersPerKg)
        : null,
  };
  try {
    if (id) {
      await db
        .update(blisterMaterialStandards)
        .set({ ...compact(valuesForDb), updatedAt: new Date() })
        .where(eq(blisterMaterialStandards.id, id));
    } else {
      await db
        .insert(blisterMaterialStandards)
        .values({ ...compact(valuesForDb), createdById: actor.id });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/settings/blister-standards");
  return { ok: true };
}

export async function deleteBlisterStandardAction(id: string) {
  await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return;
  await db
    .delete(blisterMaterialStandards)
    .where(eq(blisterMaterialStandards.id, id));
  revalidatePath("/settings/blister-standards");
}

/** Recompute learned g/blister from roll mount / segment / deplete history. */
export async function rebuildBlisterLearningAction(): Promise<{
  ok?: true;
  error?: string;
}> {
  await requireAdmin();
  try {
    await db.transaction(async (tx) => {
      await refreshRollDerivedReadModels(tx);
    });
    revalidatePath("/settings/blister-standards");
    return { ok: true };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Rebuild failed.",
    };
  }
}
