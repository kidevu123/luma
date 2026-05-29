"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
} from "@/lib/db/schema";
import { computeNetWeight } from "@/lib/production/material";
import { kgToGrams } from "@/lib/inbound/roll-weight";
import {
  computeAcceptance,
  classifyVarianceSeverity,
} from "@/lib/inbound/packaging-receipt";
import {
  resolveAdminAccountability,
  withAccountabilityPayload,
} from "@/lib/production/station-operator-session";

// ─── Mode 1 — count-based receive ───────────────────────────────

const countSchema = z
  .object({
    packagingMaterialId: z.string().uuid(),
    supplier: z.string().max(120).optional().nullable(),
    receiptNumber: z.string().max(60).optional().nullable(),
    lotNumber: z.string().max(60).optional().nullable(),
    boxNumber: z.string().max(60).optional().nullable(),
    declaredQuantity: z.coerce.number().int().min(0).optional().nullable(),
    countedQuantity: z.coerce.number().int().min(0).optional().nullable(),
    /** Legacy single-quantity field for back-compat. If declared/
     *  counted are absent and qtyReceived is set, treat it as a
     *  manually counted ("HIGH" confidence) entry. */
    qtyReceived: z.coerce.number().int().min(0).optional().nullable(),
    uom: z.string().min(1).max(40),
    location: z.string().max(120).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine(
    (d) =>
      d.declaredQuantity != null ||
      d.countedQuantity != null ||
      d.qtyReceived != null,
    {
      message:
        "Enter at least one of declared quantity, counted quantity, or legacy qty.",
      path: ["declaredQuantity"],
    },
  );

export async function receivePackagingMaterialAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true; lotId?: string } | void> {
  const actor = await requireAdmin();
  const parsed = countSchema.safeParse({
    packagingMaterialId: formData.get("packagingMaterialId"),
    supplier: formData.get("supplier") || null,
    receiptNumber: formData.get("receiptNumber") || null,
    lotNumber: formData.get("lotNumber") || null,
    boxNumber: formData.get("boxNumber") || null,
    declaredQuantity: formData.get("declaredQuantity") || null,
    countedQuantity: formData.get("countedQuantity") || null,
    qtyReceived: formData.get("qtyReceived") || null,
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
  // Resolve the receipt-quantity model. PT-2: if declared/counted
  // are explicit, use them. Otherwise fall back to the legacy
  // qty_received as a counted entry (HIGH confidence — operator
  // has typed a verified number).
  const declaredIn = parsed.data.declaredQuantity ?? null;
  const countedIn =
    parsed.data.countedQuantity ?? parsed.data.qtyReceived ?? null;
  const acceptance = computeAcceptance({
    declaredQuantity: declaredIn,
    countedQuantity: countedIn,
    source: "MANUAL_LUMA",
  });
  if (acceptance.acceptedQuantity == null || acceptance.acceptedQuantity <= 0) {
    return { error: "Quantity must be > 0." };
  }
  const acceptedQty: number = acceptance.acceptedQuantity;

  try {
    let lotId: string | undefined;
    await db.transaction(async (tx) => {
      const accountability = await resolveAdminAccountability(tx, { actor });
      const [lot] = await tx
        .insert(packagingLots)
        .values(
          compact({
            packagingMaterialId: parsed.data.packagingMaterialId,
            qtyReceived: acceptedQty, // back-compat
            qtyOnHand: acceptedQty,
            supplier: parsed.data.supplier,
            location: parsed.data.location,
            notes: parsed.data.notes,
            status: "AVAILABLE" as const,
            confidence: acceptance.confidence,
            declaredQuantity: declaredIn,
            countedQuantity: countedIn,
            acceptedQuantity: acceptedQty,
            boxNumber: parsed.data.boxNumber,
            supplierLotNumber: parsed.data.lotNumber,
            sourceSystem: "MANUAL_LUMA" as const,
            receivedByUserId: actor.id,
          }),
        )
        .returning({ id: packagingLots.id });
      if (!lot) throw new Error("Insert returned no lot id.");
      lotId = lot.id;

      // 1. MATERIAL_RECEIVED — generic ledger row (existing pattern).
      await tx.insert(materialInventoryEvents).values({
        eventType: "MATERIAL_RECEIVED",
        packagingMaterialId: parsed.data.packagingMaterialId,
        packagingLotId: lot.id,
        actorUserId: actor.id,
        quantityUnits: acceptedQty,
        unitOfMeasure: parsed.data.uom,
        payload: withAccountabilityPayload(
          {
            supplier: parsed.data.supplier ?? null,
            receipt_number: parsed.data.receiptNumber ?? null,
            lot_number: parsed.data.lotNumber ?? null,
            location: parsed.data.location ?? null,
            source_system: "MANUAL_LUMA",
          },
          accountability,
        ),
        source: "admin.receive_packaging",
      });

      // 2. PACKAGING_BOX_RECEIVED — declared box label entry.
      if (declaredIn != null) {
        await tx.insert(materialInventoryEvents).values({
          eventType: "PACKAGING_BOX_RECEIVED",
          packagingMaterialId: parsed.data.packagingMaterialId,
          packagingLotId: lot.id,
          actorUserId: actor.id,
          quantityUnits: declaredIn,
          unitOfMeasure: parsed.data.uom,
          payload: withAccountabilityPayload(
            {
              source_system: "MANUAL_LUMA",
              box_number: parsed.data.boxNumber ?? null,
              declared_quantity: declaredIn,
              supplier_lot_number: parsed.data.lotNumber ?? null,
            },
            accountability,
          ),
          source: "admin.receive_packaging",
        });
      }

      // 3. PACKAGING_BOX_COUNTED — physically counted entry.
      if (countedIn != null) {
        await tx.insert(materialInventoryEvents).values({
          eventType: "PACKAGING_BOX_COUNTED",
          packagingMaterialId: parsed.data.packagingMaterialId,
          packagingLotId: lot.id,
          actorUserId: actor.id,
          quantityUnits: countedIn,
          unitOfMeasure: parsed.data.uom,
          payload: withAccountabilityPayload(
            {
              box_number: parsed.data.boxNumber ?? null,
              counted_quantity: countedIn,
              prior_declared_quantity: declaredIn,
              variance: declaredIn != null ? countedIn - declaredIn : null,
            },
            accountability,
          ),
          source: "admin.receive_packaging",
        });
      }

      // 4. PACKAGING_VARIANCE_RECORDED — only when counted ≠ declared.
      if (acceptance.hasVariance && acceptance.variance != null && declaredIn != null) {
        await tx.insert(materialInventoryEvents).values({
          eventType: "PACKAGING_VARIANCE_RECORDED",
          packagingMaterialId: parsed.data.packagingMaterialId,
          packagingLotId: lot.id,
          actorUserId: actor.id,
          quantityUnits: Math.abs(acceptance.variance),
          unitOfMeasure: parsed.data.uom,
          payload: withAccountabilityPayload(
            {
              declared_quantity: declaredIn,
              counted_quantity: countedIn,
              variance: acceptance.variance,
              variance_pct:
                declaredIn > 0 ? acceptance.variance / declaredIn : null,
              severity: classifyVarianceSeverity({
                variance: acceptance.variance,
                declared: declaredIn,
              }),
              kind: "RECEIPT_VARIANCE",
            },
            accountability,
          ),
          source: "admin.receive_packaging",
        });
      }
    });
    revalidatePath("/inbound/packaging-materials");
    return { ok: true, ...(lotId ? { lotId } : {}) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Receive failed." };
  }
}

// ─── Mode 2 — PVC / foil roll receive ───────────────────────────

// User enters kg (decimal). Server converts to integer grams before storage.
const rollSchema = z
  .object({
    packagingMaterialId: z.string().uuid(),
    supplier: z.string().max(120).optional().nullable(),
    receiptNumber: z.string().max(60).optional().nullable(),
    lotNumber: z.string().max(60).optional().nullable(),
    rollNumber: z.string().min(1, "Roll number is required").max(80),
    grossWeightKg: z.coerce.number().min(0).optional().nullable(),
    tareWeightKg: z.coerce.number().min(0).optional().nullable(),
    netWeightKg: z.coerce.number().min(0).optional().nullable(),
    widthMm: z.coerce.number().int().min(0).optional().nullable(),
    thicknessMicrons: z.coerce.number().int().min(0).optional().nullable(),
    materialSpec: z.string().max(120).optional().nullable(),
    coreWeightKg: z.coerce.number().min(0).optional().nullable(),
    location: z.string().max(120).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
  })
  .refine(
    // Either gross+tare OR direct net must produce a positive net.
    (d) =>
      (d.grossWeightKg != null && d.tareWeightKg != null) ||
      (d.netWeightKg != null && d.netWeightKg > 0),
    {
      message:
        "Provide gross + tare weights OR enter the net weight directly.",
      path: ["netWeightKg"],
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
    grossWeightKg: formData.get("grossWeightKg") || null,
    tareWeightKg: formData.get("tareWeightKg") || null,
    netWeightKg: formData.get("netWeightKg") || null,
    widthMm: formData.get("widthMm") || null,
    thicknessMicrons: formData.get("thicknessMicrons") || null,
    materialSpec: formData.get("materialSpec") || null,
    coreWeightKg: formData.get("coreWeightKg") || null,
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

  // Convert user-entered kg → integer grams at the server boundary.
  const grossWeightGrams = kgToGrams(parsed.data.grossWeightKg ?? null);
  const tareWeightGrams = kgToGrams(parsed.data.tareWeightKg ?? null);
  const directNetGrams = kgToGrams(parsed.data.netWeightKg ?? null);
  const coreWeightGrams = kgToGrams(parsed.data.coreWeightKg ?? null);

  // Compute net weight via the pure helper. Never invents.
  const net = computeNetWeight({
    grossWeightGrams,
    tareWeightGrams,
    directNetGrams,
  });
  if (net.netGrams == null) {
    return { error: "Could not compute net weight from inputs." };
  }

  try {
    let lotId: string | undefined;
    await db.transaction(async (tx) => {
      const accountability = await resolveAdminAccountability(tx, { actor });
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
            // All weight columns store integer grams. User entered kg.
            grossWeightGrams,
            tareWeightGrams,
            netWeightGrams: net.netGrams,
            currentWeightGramsEstimate: net.netGrams,
            weightUnit: "kg" as const,
            widthMm: parsed.data.widthMm ?? null,
            thicknessMicrons: parsed.data.thicknessMicrons ?? null,
            materialSpec: parsed.data.materialSpec ?? null,
            coreWeightGrams,
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
        payload: withAccountabilityPayload(
          {
            supplier: parsed.data.supplier ?? null,
            receipt_number: parsed.data.receiptNumber ?? null,
            lot_number: parsed.data.lotNumber ?? null,
            roll_number: parsed.data.rollNumber,
            gross_weight_kg: parsed.data.grossWeightKg ?? null,
            tare_weight_kg: parsed.data.tareWeightKg ?? null,
            gross_weight_grams: grossWeightGrams,
            tare_weight_grams: tareWeightGrams,
            weight_unit: "kg",
            confidence: net.confidence,
            missing_inputs: net.missingInputs,
          },
          accountability,
        ),
        source: "admin.receive_roll",
      });
    });
    revalidatePath("/inbound/packaging-materials");
    return { ok: true, ...(lotId ? { lotId } : {}) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Receive failed." };
  }
}

// ─── Void / scrap a lot (test-data cleanup or correction) ───────

export async function voidPackagingLotAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true }> {
  const actor = await requireAdmin();
  const parsed = z.string().uuid().safeParse(formData.get("id"));
  if (!parsed.success) return { error: "Invalid lot ID." };

  try {
    await db.transaction(async (tx) => {
      const [lot] = await tx
        .select({ id: packagingLots.id, packagingMaterialId: packagingLots.packagingMaterialId })
        .from(packagingLots)
        .where(eq(packagingLots.id, parsed.data))
        .limit(1);
      if (!lot) throw new Error("Lot not found.");
      await tx
        .update(packagingLots)
        .set({ status: "SCRAPPED" })
        .where(eq(packagingLots.id, parsed.data));
      const accountability = await resolveAdminAccountability(tx, { actor });
      await tx.insert(materialInventoryEvents).values({
        eventType: "MATERIAL_SCRAPPED",
        packagingMaterialId: lot.packagingMaterialId,
        packagingLotId: lot.id,
        actorUserId: actor.id,
        quantityUnits: 0,
        unitOfMeasure: "each",
        payload: withAccountabilityPayload({ reason: "voided_by_admin" }, accountability),
        source: "admin.void_lot",
      });
    });
    revalidatePath("/inbound/packaging-materials");
    revalidatePath("/settings/blister-standards");
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Void failed." };
  }
}
