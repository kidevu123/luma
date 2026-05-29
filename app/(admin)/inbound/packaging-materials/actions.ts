"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, inArray, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import { compact } from "@/lib/db/compact";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
  machines,
  stations,
} from "@/lib/db/schema";
import { computeNetWeight } from "@/lib/production/material";
import { kgToGrams } from "@/lib/inbound/roll-weight";
import {
  parseRollReceiveRowsJson,
  validateRollReceiveBatch,
  validateRollReceiveWeightBatch,
} from "@/lib/inbound/roll-receive-batch";
import {
  assignRollNumbersForBatch,
  rollNumberGroupPrefix,
} from "@/lib/inbound/roll-number-generator";
import {
  adminMountRollLot,
  assertNoConflictingMountedRoll,
} from "@/lib/inbound/admin-roll-mount";
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

// ─── Mode 2b — batch PVC / foil roll receive (legacy-friendly) ──

const rollBatchSchema = z.object({
  packagingMaterialId: z.string().uuid(),
  receiptType: z.enum(["NORMAL", "LEGACY_OPENING_BALANCE"]),
  receiptNumber: z.string().max(60).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  rollsJson: z.string().min(2, "Roll list is required."),
  alreadyMounted: z.enum(["true", "false"]).optional(),
  mountStationId: z.string().uuid().optional().nullable(),
  // Advanced — optional, collapsed in UI
  supplier: z.string().max(120).optional().nullable(),
  lotNumber: z.string().max(60).optional().nullable(),
  grossWeightKg: z.coerce.number().min(0).optional().nullable(),
  tareWeightKg: z.coerce.number().min(0).optional().nullable(),
  widthMm: z.coerce.number().int().min(0).optional().nullable(),
  thicknessMicrons: z.coerce.number().int().min(0).optional().nullable(),
  materialSpec: z.string().max(120).optional().nullable(),
  coreWeightKg: z.coerce.number().min(0).optional().nullable(),
  location: z.string().max(120).optional().nullable(),
});

export async function receiveRollsBatchAction(
  formData: FormData,
): Promise<{
  error?: string;
  ok?: true;
  lotIds?: string[];
  mounted?: boolean;
  mountMessage?: string;
}> {
  const actor = await requireAdmin();
  const parsed = rollBatchSchema.safeParse({
    packagingMaterialId: formData.get("packagingMaterialId"),
    receiptType: formData.get("receiptType") ?? "NORMAL",
    receiptNumber: formData.get("receiptNumber") || null,
    notes: formData.get("notes") || null,
    rollsJson: formData.get("rollsJson"),
    alreadyMounted: formData.get("alreadyMounted") || undefined,
    mountStationId: formData.get("mountStationId") || null,
    supplier: formData.get("supplier") || null,
    lotNumber: formData.get("lotNumber") || null,
    grossWeightKg: formData.get("grossWeightKg") || null,
    tareWeightKg: formData.get("tareWeightKg") || null,
    widthMm: formData.get("widthMm") || null,
    thicknessMicrons: formData.get("thicknessMicrons") || null,
    materialSpec: formData.get("materialSpec") || null,
    coreWeightKg: formData.get("coreWeightKg") || null,
    location: formData.get("location") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;

  const rowParse = parseRollReceiveRowsJson(d.rollsJson);
  if ("error" in rowParse) return { error: rowParse.error };
  const weightErr = validateRollReceiveWeightBatch(rowParse.rows);
  if (weightErr) return { error: weightErr };

  if (d.receiptType === "NORMAL" && !d.receiptNumber?.trim()) {
    return { error: "PO / receipt reference is required for normal receipts." };
  }

  const wantMount = d.alreadyMounted === "true";
  if (wantMount && rowParse.rows.length !== 1) {
    return {
      error:
        "“Already mounted on machine” applies to exactly one roll. Set count to 1 or uncheck the option.",
    };
  }
  if (wantMount && !d.mountStationId) {
    return { error: "Select a machine / station to mount this roll." };
  }

  const [mat] = await db
    .select({ kind: packagingMaterials.kind, name: packagingMaterials.name })
    .from(packagingMaterials)
    .where(eq(packagingMaterials.id, d.packagingMaterialId))
    .limit(1);
  if (!mat) return { error: "Material not found." };
  if (!["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"].includes(mat.kind)) {
    return {
      error: `Material must be a roll kind — picked ${mat.kind}.`,
    };
  }

  const formatInput = {
    materialKind: mat.kind,
    materialName: mat.name,
    receiptType: d.receiptType,
    receiptReference: d.receiptNumber ?? null,
  };
  if (!rollNumberGroupPrefix(formatInput)) {
    return { error: "PO / receipt reference is required for normal receipts." };
  }

  let mountTarget: {
    stationId: string;
    machineId: string;
    label: string;
  } | null = null;
  if (wantMount && d.mountStationId) {
    const [target] = await db
      .select({
        stationId: stations.id,
        machineId: stations.machineId,
        stationLabel: stations.label,
        machineName: machines.name,
      })
      .from(stations)
      .innerJoin(machines, eq(machines.id, stations.machineId))
      .where(
        and(
          eq(stations.id, d.mountStationId),
          eq(stations.isActive, true),
          eq(machines.isActive, true),
        ),
      )
      .limit(1);
    if (!target?.machineId) {
      return { error: "Selected station is not bound to an active machine." };
    }
    mountTarget = {
      stationId: target.stationId,
      machineId: target.machineId,
      label: `${target.machineName} — ${target.stationLabel}`,
    };
  }

  const grossWeightGrams = kgToGrams(d.grossWeightKg ?? null);
  const tareWeightGrams = kgToGrams(d.tareWeightKg ?? null);
  const coreWeightGrams = kgToGrams(d.coreWeightKg ?? null);

  try {
    const lotIds: string[] = [];
    let mounted = false;
    let mountMessage: string | undefined;

    await db.transaction(async (tx) => {
      const accountability = await resolveAdminAccountability(tx, { actor });

      if (mountTarget) {
        const conflict = await assertNoConflictingMountedRoll(
          tx,
          mountTarget.machineId,
          mat.kind,
        );
        if (conflict) throw new Error(conflict);
      }

      const groupPrefix = rollNumberGroupPrefix(formatInput);
      if (!groupPrefix) {
        throw new Error("PO / receipt reference is required for normal receipts.");
      }

      const existingRows = await tx
        .select({ rollNumber: packagingLots.rollNumber })
        .from(packagingLots)
        .where(ilike(packagingLots.rollNumber, `${groupPrefix}%`));
      const existingRollNumbers = existingRows
        .map((r) => r.rollNumber)
        .filter((v): v is string => v != null && v.trim().length > 0);

      const assigned = assignRollNumbersForBatch({
        ...formatInput,
        count: rowParse.rows.length,
        existingRollNumbers,
      });
      if ("error" in assigned) throw new Error(assigned.error);

      const receiveRows = rowParse.rows.map((row, i) => ({
        rollNumber: assigned.rollNumbers[i]!,
        netWeightKg: row.netWeightKg,
      }));
      const batchErr = validateRollReceiveBatch(receiveRows);
      if (batchErr) throw new Error(batchErr);

      const dupesInDb = await tx
        .select({ rollNumber: packagingLots.rollNumber })
        .from(packagingLots)
        .where(inArray(packagingLots.rollNumber, assigned.rollNumbers));
      if (dupesInDb.length > 0) {
        const hit = dupesInDb[0]!.rollNumber ?? assigned.rollNumbers[0];
        throw new Error(`Roll number "${hit}" already exists in inventory.`);
      }

      for (const row of receiveRows) {
        const directNetGrams = kgToGrams(row.netWeightKg);
        const net = computeNetWeight({
          grossWeightGrams,
          tareWeightGrams,
          directNetGrams,
        });
        if (net.netGrams == null || net.netGrams <= 0) {
          throw new Error(
            `Could not compute net weight for roll "${row.rollNumber}".`,
          );
        }

        const [lot] = await tx
          .insert(packagingLots)
          .values(
            compact({
              packagingMaterialId: d.packagingMaterialId,
              qtyReceived: 1,
              qtyOnHand: 1,
              supplier: d.supplier,
              rollNumber: row.rollNumber.trim(),
              grossWeightGrams,
              tareWeightGrams,
              netWeightGrams: net.netGrams,
              currentWeightGramsEstimate: net.netGrams,
              weightUnit: "kg" as const,
              widthMm: d.widthMm ?? null,
              thicknessMicrons: d.thicknessMicrons ?? null,
              materialSpec: d.materialSpec ?? null,
              coreWeightGrams,
              location: d.location ?? null,
              notes: d.notes ?? null,
              status: "AVAILABLE" as const,
              confidence: net.confidence,
              supplierLotNumber: d.lotNumber,
              sourceSystem: "MANUAL_LUMA" as const,
              receivedByUserId: actor.id,
            }),
          )
          .returning({ id: packagingLots.id });
        if (!lot) throw new Error("Insert returned no lot id.");
        lotIds.push(lot.id);

        await tx.insert(materialInventoryEvents).values({
          eventType: "MATERIAL_RECEIVED",
          packagingMaterialId: d.packagingMaterialId,
          packagingLotId: lot.id,
          actorUserId: actor.id,
          quantityGrams: net.netGrams,
          unitOfMeasure: "g",
          payload: withAccountabilityPayload(
            {
              receipt_type: d.receiptType,
              supplier: d.supplier ?? null,
              receipt_number: d.receiptNumber ?? null,
              lot_number: d.lotNumber ?? null,
              roll_number: row.rollNumber.trim(),
              net_weight_kg: row.netWeightKg,
              net_weight_grams: net.netGrams,
              weight_unit: "kg",
              confidence: net.confidence,
              missing_inputs: net.missingInputs,
              source_system: "MANUAL_LUMA",
            },
            accountability,
          ),
          source: "admin.receive_roll_batch",
        });

        if (mountTarget && lotIds.length === 1) {
          await adminMountRollLot(tx, {
            lotId: lot.id,
            packagingMaterialId: d.packagingMaterialId,
            materialKind: mat.kind,
            netWeightGrams: net.netGrams,
            previousStatus: "AVAILABLE",
            machineId: mountTarget.machineId,
            stationId: mountTarget.stationId,
            actorUserId: actor.id,
            accountability,
            notes: d.notes ?? null,
          });
          mounted = true;
          mountMessage = `Roll mounted at ${mountTarget.label}.`;
        }
      }
    });

    revalidatePath("/inbound/packaging-materials");
    return {
      ok: true as const,
      lotIds,
      ...(mounted && mountMessage
        ? { mounted: true as const, mountMessage }
        : {}),
    };
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
