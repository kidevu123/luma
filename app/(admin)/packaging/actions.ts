"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import {
  createPackagingMaterial,
  updatePackagingMaterial,
} from "@/lib/db/queries/packaging";

const KIND = z.enum([
  "BLISTER_FOIL",
  "HEAT_SEAL_FILM",
  "BOTTLE",
  "CAP",
  "INDUCTION_SEAL",
  "LABEL",
  "DESICCANT",
  "COTTON",
  "DISPLAY",
  "CASE",
  "INSERT",
  "OTHER",
]);

const schema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  kind: KIND,
  uom: z.string().min(1).max(20),
  parLevel: z.coerce.number().int().min(0).optional().nullable(),
  zohoItemId: z.string().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

export async function savePackagingMaterialAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    sku: formData.get("sku"),
    name: formData.get("name"),
    kind: formData.get("kind"),
    uom: formData.get("uom"),
    parLevel: formData.get("parLevel") || null,
    zohoItemId: formData.get("zohoItemId") || null,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...input } = parsed.data;
  try {
    if (id) await updatePackagingMaterial(id, input, actor);
    else await createPackagingMaterial(input, actor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/packaging");
  return { ok: true };
}
