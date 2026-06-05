import { eq, and, sql, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  receives,
  smallBoxes,
  inventoryBags,
  batches,
  qrCards,
  tabletTypes,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  buildInternalReceiptNumber,
  buildRawBagQrPayload,
} from "@/lib/production/recall-passport";
import { DEFAULT_INTAKE_BATCH_STATUS } from "@/lib/production/batch-production-guard";
import { validateQrCardForRawBag } from "@/lib/db/queries/bag-edits";
import {
  type AddBagToReceiveInput,
  validateAddBagInput,
  resolveTargetBoxId,
  nextBagNumber,
} from "@/lib/receive/add-bag";

export type { AddBagToReceiveInput } from "@/lib/receive/add-bag";
export { DEFAULT_ADD_BAG_REASON } from "@/lib/receive/add-bag";

export async function addBagToReceive(
  receiveId: string,
  input: AddBagToReceiveInput,
  actor: CurrentUser,
): Promise<
  { ok: true; bagId: string } | { ok: false; error: string }
> {
  const [receiveRow] = await db
    .select({
      id: receives.id,
      receiveName: receives.receiveName,
      closedAt: receives.closedAt,
    })
    .from(receives)
    .where(eq(receives.id, receiveId));
  if (!receiveRow) return { ok: false, error: "Receive not found." };
  if (receiveRow.closedAt) {
    return {
      ok: false,
      error:
        "This receive is closed. Reopen it from Edit receive before adding bags.",
    };
  }

  const boxes = await db
    .select({
      id: smallBoxes.id,
      boxNumber: smallBoxes.boxNumber,
      defaultBatchId: smallBoxes.defaultBatchId,
      defaultTabletTypeId: smallBoxes.defaultTabletTypeId,
      totalBags: smallBoxes.totalBags,
      tabletName: tabletTypes.name,
      batchNumber: batches.batchNumber,
    })
    .from(smallBoxes)
    .leftJoin(tabletTypes, eq(smallBoxes.defaultTabletTypeId, tabletTypes.id))
    .leftJoin(batches, eq(smallBoxes.defaultBatchId, batches.id))
    .where(eq(smallBoxes.receiveId, receiveId))
    .orderBy(smallBoxes.boxNumber);

  const fieldValidation = validateAddBagInput(input, boxes.length);
  if (!fieldValidation.ok) return fieldValidation;

  const boxResolution = resolveTargetBoxId(boxes, input.smallBoxId);
  if (!boxResolution.ok) return boxResolution;

  const box = boxes.find((b) => b.id === boxResolution.boxId);
  if (!box?.defaultTabletTypeId) {
    return { ok: false, error: "Selected box is missing tablet type context." };
  }
  const tabletTypeId = box.defaultTabletTypeId;

  try {
    return await db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ maxNum: max(inventoryBags.bagNumber) })
        .from(inventoryBags)
        .where(eq(inventoryBags.smallBoxId, box.id));
      const bagNumber = nextBagNumber(maxRow?.maxNum ?? 0);

      let batchId = box.defaultBatchId;
      const supplierLot = input.supplierLotNumber?.trim();
      if (supplierLot && supplierLot !== (box.batchNumber ?? "")) {
        const [existingBatch] = await tx
          .select({ id: batches.id })
          .from(batches)
          .where(
            and(
              eq(batches.kind, "TABLET"),
              eq(batches.batchNumber, supplierLot),
              eq(batches.tabletTypeId, tabletTypeId),
            ),
          );
        if (existingBatch) {
          batchId = existingBatch.id;
        } else {
          const [created] = await tx
            .insert(batches)
            .values({
              kind: "TABLET" as const,
              batchNumber: supplierLot,
              tabletTypeId,
              status: DEFAULT_INTAKE_BATCH_STATUS,
              statusChangedById: actor.id,
              qtyReceived: 0,
              qtyOnHand: 0,
            })
            .returning({ id: batches.id });
          if (!created) throw new Error("Failed to create batch.");
          batchId = created.id;
          await writeAudit(
            {
              actorId: actor.id,
              actorRole: actor.role,
              action: "batch.create",
              targetType: "Batch",
              targetId: batchId,
              after: {
                batchNumber: supplierLot,
                tabletTypeId,
                reason: input.addReason.trim(),
              },
            },
            tx,
          );
        }
      }

      const internalReceiptNumber =
        input.internalReceiptNumber?.trim() ||
        buildInternalReceiptNumber({
          receiveName: receiveRow.receiveName,
          boxNumber: box.boxNumber,
          bagNumber,
        });

      if (internalReceiptNumber) {
        const [rcptConflict] = await tx
          .select({ id: inventoryBags.id })
          .from(inventoryBags)
          .where(eq(inventoryBags.internalReceiptNumber, internalReceiptNumber))
          .limit(1);
        if (rcptConflict) {
          throw new Error(
            `Receipt number "${internalReceiptNumber}" is already used by another bag.`,
          );
        }
      }

      const bagId = randomUUID();
      let bagQrCode =
        input.bagQrCode?.trim() ||
        buildRawBagQrPayload({
          inventoryBagId: bagId,
          internalReceiptNumber: internalReceiptNumber ?? `RECV-${bagId}`,
          bagSequence: bagNumber,
        });

      if (input.bagQrCode?.trim()) {
        const token = input.bagQrCode.trim();
        const [newCard] = await tx
          .select()
          .from(qrCards)
          .where(eq(qrCards.scanToken, token));
        if (!newCard) throw new Error(`QR card "${token}" not found.`);
        const cardValidation = validateQrCardForRawBag(newCard);
        if (!cardValidation.ok) throw new Error(cardValidation.error);

        const [existingBag] = await tx
          .select({ id: inventoryBags.id })
          .from(inventoryBags)
          .where(eq(inventoryBags.bagQrCode, token))
          .limit(1);
        if (existingBag) {
          throw new Error(
            "This QR is already assigned to another bag. Choose another QR.",
          );
        }

        await tx
          .update(qrCards)
          .set({ status: "ASSIGNED" as const, assignedWorkflowBagId: null })
          .where(eq(qrCards.scanToken, token));
        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "qr_card.reserved_at_bag_add",
            targetType: "QrCard",
            targetId: newCard.id,
            before: { status: newCard.status, scanToken: newCard.scanToken },
            after: { status: "ASSIGNED", reason: input.addReason.trim() },
          },
          tx,
        );
        bagQrCode = token;
      }

      const declared = input.declaredPillCount ?? null;
      const [inserted] = await tx
        .insert(inventoryBags)
        .values({
          id: bagId,
          smallBoxId: box.id,
          bagNumber,
          tabletTypeId,
          batchId,
          pillCount: declared,
          declaredPillCount: declared,
          weightGrams: input.weightGrams ?? null,
          notes: input.notes?.trim() || null,
          internalReceiptNumber,
          bagQrCode,
          status: "AVAILABLE" as const,
        })
        .returning({ id: inventoryBags.id });

      if (!inserted) throw new Error("Failed to create bag.");

      await tx
        .update(smallBoxes)
        .set({ totalBags: sql`${smallBoxes.totalBags} + 1` })
        .where(eq(smallBoxes.id, box.id));

      if (batchId && declared != null && declared > 0) {
        await tx
          .update(batches)
          .set({
            qtyReceived: sql`${batches.qtyReceived} + ${declared}`,
            qtyOnHand: sql`${batches.qtyOnHand} + ${declared}`,
          })
          .where(eq(batches.id, batchId));
      }

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "inventory_bag.add",
          targetType: "InventoryBag",
          targetId: bagId,
          after: {
            receiveId,
            receiveName: receiveRow.receiveName,
            smallBoxId: box.id,
            boxNumber: box.boxNumber,
            bagNumber,
            internalReceiptNumber,
            bagQrCode,
            batchId,
            declaredPillCount: declared,
            weightGrams: input.weightGrams ?? null,
            reason: input.addReason.trim(),
          },
        },
        tx,
      );

      return { ok: true as const, bagId };
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Save failed.",
    };
  }
}
