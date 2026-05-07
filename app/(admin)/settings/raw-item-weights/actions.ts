"use server";

// Phase H.x3.5 — Server actions for raw-item unit-weight standards.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rawItemWeightStandards } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { compact } from "@/lib/db/compact";

const saveSchema = z.object({
  tabletTypeId: z.string().uuid(),
  standardUnitWeight: z.coerce.number().positive(),
  sampleSource: z.string().max(200).optional().nullable(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  effectiveFrom: z.string().date(),
  notes: z.string().max(500).optional().nullable(),
});

export async function saveRawItemWeightAction(formData: FormData) {
  const actor = await requireAdmin();
  const parsed = saveSchema.safeParse({
    tabletTypeId: formData.get("tabletTypeId"),
    standardUnitWeight: formData.get("standardUnitWeight"),
    sampleSource: formData.get("sampleSource") || null,
    confidence: formData.get("confidence"),
    effectiveFrom: formData.get("effectiveFrom"),
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const d = parsed.data;

  // Deactivate any prior open-ended active row for the same tablet
  // type so there's only one "current" standard at a time.
  await db.execute(sql`
    UPDATE raw_item_weight_standards
       SET is_active = false,
           effective_to = COALESCE(effective_to, ${d.effectiveFrom}::date - INTERVAL '1 day'),
           updated_at = now()
     WHERE tablet_type_id = ${d.tabletTypeId}
       AND is_active = true
       AND effective_to IS NULL
  `);

  await db.insert(rawItemWeightStandards).values(
    compact({
      tabletTypeId: d.tabletTypeId,
      standardUnitWeight: String(d.standardUnitWeight),
      weightUnit: "g",
      sampleSource: d.sampleSource,
      confidence: d.confidence,
      effectiveFrom: d.effectiveFrom,
      notes: d.notes,
      createdById: actor.id,
      isActive: true,
    }),
  );

  revalidatePath("/settings/raw-item-weights");
}

export async function deactivateRawItemWeightAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("Missing id.");
  await db.execute(sql`
    UPDATE raw_item_weight_standards
       SET is_active = false,
           effective_to = COALESCE(effective_to, CURRENT_DATE),
           updated_at = now()
     WHERE id = ${id}
  `);
  revalidatePath("/settings/raw-item-weights");
}
