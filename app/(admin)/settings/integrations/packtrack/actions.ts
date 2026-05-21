"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import {
  externalSystems,
  externalItemMappings,
  packagingMaterials,
} from "@/lib/db/schema";

const createSchema = z.object({
  externalItemId: z.string().min(1, "PackTrack material code is required.").max(120),
  externalItemName: z.string().max(200).optional().nullable(),
  materialItemId: z.string().uuid("Pick a Luma packaging material."),
  // CHECK constraint on external_item_mappings.mapping_type accepts:
  // RAW_MATERIAL, PACKAGING_MATERIAL, COMPONENT, INTERMEDIATE_GOOD,
  // FINISHED_GOOD, SELLABLE_SKU, UNKNOWN. PackTrack receipts are
  // packaging material by default.
  mappingType: z
    .enum([
      "PACKAGING_MATERIAL",
      "RAW_MATERIAL",
      "COMPONENT",
      "INTERMEDIATE_GOOD",
      "FINISHED_GOOD",
      "SELLABLE_SKU",
      "UNKNOWN",
    ])
    .default("PACKAGING_MATERIAL"),
});

/** Create a new active PackTrack -> Luma material mapping. Rejects when
 *  another active mapping already exists for the same external_item_id
 *  (the partial unique on `(external_system_id, external_item_id)`
 *  enforces this at the DB layer too). */
export async function createPacktrackMappingAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireAdmin();
  const parsed = createSchema.safeParse({
    externalItemId: formData.get("externalItemId"),
    externalItemName: formData.get("externalItemName") || null,
    materialItemId: formData.get("materialItemId"),
    mappingType: formData.get("mappingType") || "PACKAGING_MATERIAL",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const [system] = await db
    .select({ id: externalSystems.id })
    .from(externalSystems)
    .where(eq(externalSystems.code, "PACKTRACK"));
  if (!system) {
    return {
      error:
        "PackTrack external_system row not found. Run scripts/register-packtrack.ts first.",
    };
  }

  // Sanity-check the material exists.
  const [mat] = await db
    .select({ id: packagingMaterials.id })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, parsed.data.materialItemId));
  if (!mat) return { error: "Luma packaging material not found." };

  // Reject duplicate active mapping for the same external code.
  const [dup] = await db
    .select({ id: externalItemMappings.id })
    .from(externalItemMappings)
    .where(
      and(
        eq(externalItemMappings.externalSystemId, system.id),
        eq(externalItemMappings.externalItemId, parsed.data.externalItemId),
        eq(externalItemMappings.isActive, true),
      ),
    );
  if (dup) {
    return {
      error: `Active mapping already exists for PackTrack code "${parsed.data.externalItemId}". Deactivate the existing one first.`,
    };
  }

  try {
    await db.insert(externalItemMappings).values({
      externalSystemId: system.id,
      externalItemId: parsed.data.externalItemId,
      externalItemName: parsed.data.externalItemName ?? null,
      materialItemId: parsed.data.materialItemId,
      mappingType: parsed.data.mappingType,
      isActive: true,
    });
  } catch (err) {
    console.error("[packtrack.createMapping] failed:", err);
    return { error: err instanceof Error ? err.message : "Insert failed." };
  }

  revalidatePath("/settings/integrations/packtrack");
  return { ok: true };
}

const deactivateSchema = z.object({
  mappingId: z.string().uuid(),
});

export async function deactivatePacktrackMappingAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireAdmin();
  const parsed = deactivateSchema.safeParse({
    mappingId: formData.get("mappingId"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  await db
    .update(externalItemMappings)
    .set({ isActive: false })
    .where(eq(externalItemMappings.id, parsed.data.mappingId));
  revalidatePath("/settings/integrations/packtrack");
  return { ok: true };
}
