"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guards";
import { createTabletType, updateTabletType } from "@/lib/db/queries/tablet-types";

const schema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().max(60).optional().nullable(),
  name: z.string().min(1).max(120),
  defaultMgPerTablet: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  zohoItemId: z.string().max(60).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

export async function saveTabletTypeAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    id: formData.get("id") || undefined,
    sku: formData.get("sku") || null,
    name: formData.get("name"),
    defaultMgPerTablet: formData.get("defaultMgPerTablet") || null,
    zohoItemId: formData.get("zohoItemId") || null,
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { id, ...input } = parsed.data;
  try {
    if (id) {
      await updateTabletType(id, input, actor);
    } else {
      await createTabletType(input, actor);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Save failed." };
  }
  revalidatePath("/tablet-types");
  return { ok: true };
}
