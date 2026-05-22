import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  workflowBags,
  batches,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";

export type BagSnapshot = {
  id: string;
  weightGrams: number | null;
  notes: string | null;
  internalReceiptNumber: string | null;
  bagQrCode: string | null;
  batchId: string | null;
  status: string;
};

export type BagEditInput = {
  weightGrams?: number | null;
  notes?: string | null;
  internalReceiptNumber?: string | null;
  supplierLotNumber?: string | null;
  bagQrCode?: string | null;
  editReason?: string | null;
};

type BagPatch = {
  weightGrams?: number | null;
  notes?: string | null;
  internalReceiptNumber?: string | null;
  bagQrCode?: string | null;
  batchId?: string | null;
};

const SENSITIVE_FIELDS: Array<keyof BagEditInput> = [
  "internalReceiptNumber",
  "supplierLotNumber",
  "bagQrCode",
];

export function validateBagEditFields(
  _bag: BagSnapshot,
  input: BagEditInput,
  isInProduction: boolean,
): { ok: true } | { ok: false; error: string } {
  const nonNotes = (
    ["weightGrams", ...SENSITIVE_FIELDS] as Array<keyof BagEditInput>
  ).some((k) => input[k] !== undefined);

  if (isInProduction && nonNotes) {
    return {
      ok: false,
      error: "Bag is in production — only notes can be edited.",
    };
  }

  const sensitiveChanged = SENSITIVE_FIELDS.some((k) => input[k] !== undefined);
  if (sensitiveChanged && !input.editReason?.trim()) {
    return {
      ok: false,
      error: "Edit reason is required for QR, receipt, or lot changes.",
    };
  }

  return { ok: true };
}

export async function getBagForEdit(bagId: string) {
  const [row] = await db
    .select({
      bag: inventoryBags,
      batchNumber: batches.batchNumber,
      tabletTypeId: inventoryBags.tabletTypeId,
    })
    .from(inventoryBags)
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .where(eq(inventoryBags.id, bagId));
  if (!row) return null;

  const [inProd] = await db
    .select({ id: workflowBags.id })
    .from(workflowBags)
    .where(eq(workflowBags.inventoryBagId, bagId))
    .limit(1);

  return { ...row, isInProduction: !!inProd };
}

export async function editInventoryBag(
  bagId: string,
  input: BagEditInput,
  actor: CurrentUser,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const loaded = await getBagForEdit(bagId);
  if (!loaded) return { ok: false, error: "Bag not found." };

  const { bag, isInProduction, tabletTypeId } = loaded;
  const snapshot: BagSnapshot = {
    id: bag.id,
    weightGrams: bag.weightGrams ?? null,
    notes: bag.notes ?? null,
    internalReceiptNumber: bag.internalReceiptNumber ?? null,
    bagQrCode: bag.bagQrCode ?? null,
    batchId: bag.batchId ?? null,
    status: bag.status,
  };

  const validation = validateBagEditFields(snapshot, input, isInProduction);
  if (!validation.ok) return validation;

  // Wrap entire mutation in a transaction and convert thrown errors to { ok: false }.
  // Drizzle only rolls back on throw — never on return — so all validation failures
  // that happen after mutations have started must throw to guarantee atomicity.
  try {
    return await db.transaction(async (tx) => {
      // ── QR card swap ──────────────────────────────────────────────────────
      if (input.bagQrCode !== undefined && input.bagQrCode !== bag.bagQrCode) {
        const newToken = input.bagQrCode?.trim() ?? null;

        // Release old card to IDLE only if intake-reserved (ASSIGNED + null workflowBagId)
        if (bag.bagQrCode) {
          const [oldCard] = await tx
            .select()
            .from(qrCards)
            .where(eq(qrCards.scanToken, bag.bagQrCode));
          if (
            oldCard &&
            oldCard.status === "ASSIGNED" &&
            oldCard.assignedWorkflowBagId === null
          ) {
            await tx
              .update(qrCards)
              .set({ status: "IDLE" as const })
              .where(eq(qrCards.scanToken, bag.bagQrCode));
            await writeAudit(
              {
                actorId: actor.id,
                actorRole: actor.role,
                action: "qr_card.released_at_bag_edit",
                targetType: "QrCard",
                targetId: oldCard.id,
                before: { status: oldCard.status, scanToken: oldCard.scanToken },
                after: { status: "IDLE", reason: input.editReason ?? null },
              },
              tx,
            );
          }
        }

        // Assign new card — throw on any validation failure to trigger rollback
        if (newToken) {
          const [newCard] = await tx
            .select()
            .from(qrCards)
            .where(eq(qrCards.scanToken, newToken));
          if (!newCard)
            throw new Error(`QR card "${newToken}" not found.`);
          if (newCard.cardType === "VARIETY_PACK")
            throw new Error("Variety pack cards cannot be used for raw bags.");
          if (newCard.status === "RETIRED")
            throw new Error("Retired QR cards cannot be assigned.");
          if (newCard.status === "ASSIGNED" && newCard.assignedWorkflowBagId !== null)
            throw new Error("This QR card is already active in production.");

          await tx
            .update(qrCards)
            .set({ status: "ASSIGNED" as const, assignedWorkflowBagId: null })
            .where(eq(qrCards.scanToken, newToken));
          await writeAudit(
            {
              actorId: actor.id,
              actorRole: actor.role,
              action: "qr_card.reserved_at_bag_edit",
              targetType: "QrCard",
              targetId: newCard.id,
              before: { status: newCard.status, scanToken: newCard.scanToken },
              after: { status: "ASSIGNED", reason: input.editReason ?? null },
            },
            tx,
          );
        }
      }

      // ── Supplier lot swap ─────────────────────────────────────────────────
      let newBatchId: string | null | undefined;
      if (
        input.supplierLotNumber !== undefined &&
        input.supplierLotNumber !== loaded.batchNumber
      ) {
        const newLot = input.supplierLotNumber?.trim() ?? null;
        if (newLot) {
          // unique index is on (kind, batchNumber) so this lookup is unambiguous
          const [existing] = await tx
            .select({ id: batches.id })
            .from(batches)
            .where(
              and(eq(batches.kind, "TABLET"), eq(batches.batchNumber, newLot)),
            );
          if (existing) {
            newBatchId = existing.id;
          } else {
            const [created] = await tx
              .insert(batches)
              .values({
                kind: "TABLET" as const,
                batchNumber: newLot,
                tabletTypeId,
                status: "QUARANTINE" as const,
                statusChangedById: actor.id,
                qtyReceived: 0,
                qtyOnHand: 0,
              })
              .returning({ id: batches.id });
            if (!created) throw new Error("Failed to create batch.");
            newBatchId = created.id;
            await writeAudit(
              {
                actorId: actor.id,
                actorRole: actor.role,
                action: "batch.create",
                targetType: "Batch",
                targetId: newBatchId,
                after: {
                  batchNumber: newLot,
                  tabletTypeId,
                  kind: "TABLET",
                  reason: input.editReason ?? null,
                },
              },
              tx,
            );
          }
        } else {
          newBatchId = null;
        }
      }

      // ── Apply patch ───────────────────────────────────────────────────────
      const patch: BagPatch = {};
      if (input.weightGrams !== undefined) patch.weightGrams = input.weightGrams;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.internalReceiptNumber !== undefined)
        patch.internalReceiptNumber = input.internalReceiptNumber;
      if (input.bagQrCode !== undefined)
        patch.bagQrCode = input.bagQrCode?.trim() ?? null;
      if (newBatchId !== undefined) patch.batchId = newBatchId;

      if (Object.keys(patch).length > 0) {
        await tx
          .update(inventoryBags)
          .set(patch)
          .where(eq(inventoryBags.id, bagId));
      }

      await writeAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: "inventory_bag.edit",
          targetType: "InventoryBag",
          targetId: bagId,
          before: snapshot,
          after: { ...snapshot, ...patch, reason: input.editReason ?? null },
        },
        tx,
      );

      return { ok: true as const };
    });
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Unexpected error during bag edit.",
    };
  }
}
