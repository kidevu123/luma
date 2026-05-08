"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guards";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
} from "@/lib/db/schema";
import { classifyVarianceSeverity } from "@/lib/inbound/packaging-receipt";
import {
  resolveAdminAccountability,
  withAccountabilityPayload,
} from "@/lib/production/station-operator-session";

import { ADJUST_REASON_OPTIONS } from "./constants";

const adjustSchema = z.object({
  lotId: z.string().uuid(),
  countedCurrentQuantity: z.coerce
    .number()
    .int()
    .min(0, "Counted quantity must be ≥ 0."),
  reason: z.enum(ADJUST_REASON_OPTIONS),
  notes: z.string().max(500).optional().nullable(),
});

/** PT-4D — Cycle-count / supervisor adjustment.
 *
 *  Never overwrites the lot's original receipt fields
 *  (declared/counted/accepted at receipt time). Only updates
 *  qty_on_hand to the new physical count, and emits:
 *    - PACKAGING_RECEIPT_ADJUSTED with signed delta + reason
 *    - PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE when delta != 0
 *
 *  The lot's stored confidence may be raised to HIGH because the
 *  current state is now physically verified — but the original
 *  receipt confidence (in the receipt-time event payload) is
 *  preserved unmodified for audit. */
export async function adjustPackagingLotAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const actor = await requireAdmin();
  const parsed = adjustSchema.safeParse({
    lotId: formData.get("lotId"),
    countedCurrentQuantity: formData.get("countedCurrentQuantity"),
    reason: formData.get("reason"),
    notes: formData.get("notes") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await db.transaction(async (tx) => {
      const accountability = await resolveAdminAccountability(tx, { actor });
      const [lot] = await tx
        .select({
          id: packagingLots.id,
          packagingMaterialId: packagingLots.packagingMaterialId,
          qtyOnHand: packagingLots.qtyOnHand,
          confidence: packagingLots.confidence,
          uom: packagingMaterials.uom,
        })
        .from(packagingLots)
        .innerJoin(
          packagingMaterials,
          eq(packagingMaterials.id, packagingLots.packagingMaterialId),
        )
        .where(eq(packagingLots.id, parsed.data.lotId));
      if (!lot) throw new Error("Lot not found.");

      const priorOnHand = lot.qtyOnHand;
      const newOnHand = parsed.data.countedCurrentQuantity;
      const delta = newOnHand - priorOnHand;

      // 1. PACKAGING_RECEIPT_ADJUSTED — signed delta event.
      await tx.insert(materialInventoryEvents).values({
        eventType: "PACKAGING_RECEIPT_ADJUSTED",
        packagingMaterialId: lot.packagingMaterialId,
        packagingLotId: lot.id,
        actorUserId: actor.id,
        quantityUnits: Math.abs(delta),
        unitOfMeasure: lot.uom,
        payload: withAccountabilityPayload(
          {
            adjustment: delta,
            prior_qty_on_hand: priorOnHand,
            new_qty_on_hand: newOnHand,
            reason: parsed.data.reason,
            notes: parsed.data.notes ?? null,
            adjusted_by_user_id: actor.id,
          },
          accountability,
        ),
        source: "admin.cycle_count",
      });

      // 2. PACKAGING_VARIANCE_RECORDED kind=CYCLE_COUNT_VARIANCE when
      //    the delta is non-zero. Distinct from RECEIPT_VARIANCE so
      //    reconciliation can render them as separate buckets.
      if (delta !== 0) {
        const declaredApprox = priorOnHand > 0 ? priorOnHand : 1;
        await tx.insert(materialInventoryEvents).values({
          eventType: "PACKAGING_VARIANCE_RECORDED",
          packagingMaterialId: lot.packagingMaterialId,
          packagingLotId: lot.id,
          actorUserId: actor.id,
          quantityUnits: Math.abs(delta),
          unitOfMeasure: lot.uom,
          payload: withAccountabilityPayload(
            {
              prior_qty_on_hand: priorOnHand,
              counted_quantity: newOnHand,
              variance: delta,
              severity: classifyVarianceSeverity({
                variance: delta,
                declared: declaredApprox,
              }),
              kind: "CYCLE_COUNT_VARIANCE", // NOT receipt variance, NOT production loss
              reason: parsed.data.reason,
            },
            accountability,
          ),
          source: "admin.cycle_count",
        });
      }

      // 3. Update qty_on_hand AND raise confidence to HIGH for current
      //    inventory state (physically verified). The original
      //    receipt confidence remains in the receipt-time event
      //    payload — not overwritten.
      await tx
        .update(packagingLots)
        .set({
          qtyOnHand: newOnHand,
          confidence: "HIGH",
        })
        .where(eq(packagingLots.id, lot.id));
    });
  } catch (err) {
    console.error("[packtrack.adjustLot] failed:", err);
    return { error: err instanceof Error ? err.message : "Adjustment failed." };
  }

  revalidatePath("/packaging-receipts");
  revalidatePath(`/packaging-receipts/${parsed.data.lotId}/adjust`);
  return { ok: true };
}

