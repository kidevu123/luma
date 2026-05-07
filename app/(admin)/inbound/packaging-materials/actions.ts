"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
} from "@/lib/db/schema";
import { computeNetWeight } from "@/lib/production/material";

// ─── Mode 1 — count-based receive ───────────────────────────────

const countSchema = z.object({
  packagingMaterialId: z.string().uuid(),
  supplier: z.string().max(120).optional().nullable(),
  receiptNumber: z.string().max(60).optional().nullable(),
  lotNumber: z.string().max(60).optional().nullable(),
  qtyReceived: z.coerce.number().int().min(1, "Quantity must be > 0"),
  uom: z.string().min(1).max(40),
  location: z.string().max(120).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function receivePackagingMaterialAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true; lotId?: string } | void> {
  const actor = await requireAdmin();
  const parsed = countSchema.safeParse({
    packagingMaterialId: formData.get("packagingMaterialId"),
    supplier: formData.get("supplier") || null,
    receiptNumber: formData.get("receiptNumber") || null,
    lotNumber: formData.get("lotNumber") || null,
    qtyReceived: formData.get("qtyReceived"),
    uom: formData.get("uom") || "each",
    location: formData.get("location") || null,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  // Reject when the chosen material is a roll kind — rolls go through
  // the roll-receive flow, not count-based.
  const [mat] = await db
    .select({ kind: packagingMaterials.kind })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, parsed.data.packagingMaterialId))
    .limit(1);
  if (!mat) return { error: "Material not found." };
  if (["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(mat.kind)) {
    return {
      error: "This material is a roll. Use the PVC/foil roll form instead.",
    };
  }
  try {
    let lotId: string | undefined;
    await db.transaction(async (tx) => {
      const [lot] = await tx
        .insert(packagingLots)
        .values(
          compact({
            packagingMaterialId: parsed.data.packagingMaterialId,
            qtyReceived: parsed.data.qtyReceived,
            qtyOnHand: parsed.data.qtyReceived,
            supplier: parsed.data.supplier,
            location: parsed.data.location,
            notes: parsed.data.notes,
            status: "AVAILABLE" as const,
            confidence: "HIGH",
          }),
        )
        .returning({ id: packagingLots.id });
      if (!lot) throw new Error("Insert returned no lot id.");
      lotId = lot.id;
      await tx.insert(materialInventoryEvents).values({
        eventType: "MATERIAL_RECEIVED",
        packagingMaterialId: parsed.data.packagingMaterialId,
        packagingLotId: lot.id,
        actorUserId: actor.id,
        quantityUnits: parsed.data.qtyReceived,
        unitOfMeasure: parsed.data.uom,
        payload: {
          supplier: parsed.data.supplier ?? null,
          receipt_number: parsed.data.receiptNumber ?? null,
          lot_number: parsed.data.lotNumber ?? null,
          location: parsed.data.location ?? null,
        },
        source: "admin.receive_packaging",
      });
    });
    revalidatePath("/inbound/packaging-materials");
    return { ok: true, ...(lotId ? { lotId } : {}) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Receive failed." };
  }
}

// ─── Mode 2 — PVC / foil roll receive ───────────────────────────

const rollSchema = z
  .object({
    packagingMaterialId: z.string().uuid(),
    supplier: z.string().max(120).optional().nullable(),
    receiptNumber: z.string().max(60).optional().nullable(),
    lotNumber: z.string().max(60).optional().nullable(),
    rollNumber: z.string().min(1, "Roll number is required").max(80),
    grossWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    tareWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    netWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    weightUnit: z.enum(["g", "kg", "lb"]).default("g"),
    widthMm: z.coerce.number().int().min(0).optional().nullable(),
    thicknessMicrons: z.coerce.number().int().min(0).optional().nullable(),
    materialSpec: z.string().max(120).optional().nullable(),
    coreWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
    location: z.string().max(120).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine(
    // Either gross+tare OR direct net must produce a positive net.
    (d) =>
      (d.grossWeightGrams != null && d.tareWeightGrams != null) ||
      (d.netWeightGrams != null && d.netWeightGrams > 0),
    {
      message:
        "Provide gross + tare weights OR enter the net weight directly.",
      path: ["netWeightGrams"],
    },
  );

export async function receiveRollAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true; lotId?: string } | void> {
  const actor = await requireAdmin();
  const parsed = rollSchema.safeParse({
    packagingMaterialId: formData.get("packagingMaterialId"),
    supplier: formData.get("supplier") || null,
    receiptNumber: formData.get("receiptNumber") || null,
    lotNumber: formData.get("lotNumber") || null,
    rollNumber: formData.get("rollNumber"),
    grossWeightGrams: formData.get("grossWeightGrams") || null,
    tareWeightGrams: formData.get("tareWeightGrams") || null,
    netWeightGrams: formData.get("netWeightGrams") || null,
    weightUnit: formData.get("weightUnit") || "g",
    widthMm: formData.get("widthMm") || null,
    thicknessMicrons: formData.get("thicknessMicrons") || null,
    materialSpec: formData.get("materialSpec") || null,
    coreWeightGrams: formData.get("coreWeightGrams") || null,
    location: formData.get("location") || null,
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Verify roll-kind material.
  const [mat] = await db
    .select({ kind: packagingMaterials.kind })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, parsed.data.packagingMaterialId))
    .limit(1);
  if (!mat) return { error: "Material not found." };
  if (!["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(mat.kind)) {
    return {
      error:
        "Material must be PVC_ROLL or FOIL_ROLL — picked " + mat.kind + ".",
    };
  }

  // Reject duplicate active roll number.
  const dupe = await db
    .select({ id: packagingLots.id })
    .from(packagingLots)
    .where(eq(packagingLots.rollNumber, parsed.data.rollNumber))
    .limit(1);
  if (dupe.length > 0) {
    return {
      error: `Roll number "${parsed.data.rollNumber}" already exists in inventory.`,
    };
  }

  // Compute net weight via the pure helper. Never invents.
  const net = computeNetWeight({
    grossWeightGrams: parsed.data.grossWeightGrams ?? null,
    tareWeightGrams: parsed.data.tareWeightGrams ?? null,
    directNetGrams: parsed.data.netWeightGrams ?? null,
  });
  if (net.netGrams == null) {
    return { error: "Could not compute net weight from inputs." };
  }

  try {
    let lotId: string | undefined;
    await db.transaction(async (tx) => {
      const [lot] = await tx
        .insert(packagingLots)
        .values(
          compact({
            packagingMaterialId: parsed.data.packagingMaterialId,
            // Roll lots use weight, not count — but qty_received is
            // notNull. Use 1 (one roll) as the count-equivalent.
            qtyReceived: 1,
            qtyOnHand: 1,
            supplier: parsed.data.supplier,
            rollNumber: parsed.data.rollNumber,
            grossWeightGrams: parsed.data.grossWeightGrams ?? null,
            tareWeightGrams: parsed.data.tareWeightGrams ?? null,
            netWeightGrams: net.netGrams,
            currentWeightGramsEstimate: net.netGrams,
            weightUnit: parsed.data.weightUnit,
            widthMm: parsed.data.widthMm ?? null,
            thicknessMicrons: parsed.data.thicknessMicrons ?? null,
            materialSpec: parsed.data.materialSpec ?? null,
            coreWeightGrams: parsed.data.coreWeightGrams ?? null,
            location: parsed.data.location ?? null,
            notes: parsed.data.notes ?? null,
            status: "AVAILABLE" as const,
            confidence: net.confidence,
          }),
        )
        .returning({ id: packagingLots.id });
      if (!lot) throw new Error("Insert returned no lot id.");
      lotId = lot.id;
      await tx.insert(materialInventoryEvents).values({
        eventType: "MATERIAL_RECEIVED",
        packagingMaterialId: parsed.data.packagingMaterialId,
        packagingLotId: lot.id,
        actorUserId: actor.id,
        quantityGrams: net.netGrams,
        unitOfMeasure: "g",
        payload: {
          supplier: parsed.data.supplier ?? null,
          receipt_number: parsed.data.receiptNumber ?? null,
          lot_number: parsed.data.lotNumber ?? null,
          roll_number: parsed.data.rollNumber,
          gross_weight_grams: parsed.data.grossWeightGrams ?? null,
          tare_weight_grams: parsed.data.tareWeightGrams ?? null,
          weight_unit: parsed.data.weightUnit,
          confidence: net.confidence,
          missing_inputs: net.missingInputs,
        },
        source: "admin.receive_roll",
      });
    });
    revalidatePath("/inbound/packaging-materials");
    return { ok: true, ...(lotId ? { lotId } : {}) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Receive failed." };
  }
}
