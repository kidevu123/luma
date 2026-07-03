"use server";

import { requireLead, requireAdmin } from "@/lib/auth-guards";
import { editInventoryBag, repairQrReservation, type BagEditInput } from "@/lib/db/queries/bag-edits";
import { repairLostQrReservationsBatch } from "@/lib/db/queries/lost-qr-reservations";
import { revalidatePath } from "next/cache";

export type EditBagFormData = {
  weightKg?: string;
  declaredPillCount?: string;
  notes?: string;
  internalReceiptNumber?: string;
  supplierLotNumber?: string;
  bagQrCode?: string;
  editReason?: string;
};

export async function editBagAction(
  receiveId: string,
  bagId: string,
  raw: EditBagFormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireLead();

  const input: BagEditInput = {};

  if (raw.weightKg !== undefined && raw.weightKg.trim() !== "") {
    const kg = parseFloat(raw.weightKg);
    if (isNaN(kg) || kg < 0) return { ok: false, error: "Invalid weight." };
    input.weightGrams = Math.round(kg * 1000);
  } else if (raw.weightKg === "") {
    input.weightGrams = null;
  }

  if (raw.declaredPillCount !== undefined) {
    const trimmed = raw.declaredPillCount.trim();
    if (trimmed === "") {
      input.declaredPillCount = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: "Invalid declared pill count." };
      }
      input.declaredPillCount = n;
    }
  }

  if (raw.notes !== undefined) input.notes = raw.notes.trim() || null;
  if (raw.internalReceiptNumber !== undefined)
    input.internalReceiptNumber = raw.internalReceiptNumber.trim() || null;
  if (raw.supplierLotNumber !== undefined)
    input.supplierLotNumber = raw.supplierLotNumber.trim() || null;
  if (raw.bagQrCode !== undefined)
    input.bagQrCode = raw.bagQrCode.trim() || null;
  if (raw.editReason !== undefined)
    input.editReason = raw.editReason.trim() || null;

  const result = await editInventoryBag(bagId, input, actor);

  if (result.ok) {
    revalidatePath(`/inbound/${receiveId}`);
    revalidatePath(`/inbound/${receiveId}/bag/${bagId}/edit`);
    revalidatePath("/qr-cards");
  }

  return result;
}

// QR-RESERVE-REPAIR-1 — re-reserve a bag's own IDLE QR (lost intake
// reservation). Guarded + audited; never touches a card active in production.
export async function repairQrReservationAction(
  receiveId: string,
  bagId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireLead();
  const result = await repairQrReservation(bagId, actor);
  if (result.ok) {
    revalidatePath(`/inbound/${receiveId}`);
    revalidatePath("/qr-cards");
  }
  return result;
}

// BATCH-LOST-QR-RESERVATION-REPAIR-1 — admin one-click repair of ALL safe lost
// intake reservations (bags pointing at their own IDLE RAW_BAG card). Guarded +
// audited; skips unsafe/conflicting rows; never touches workflow/allocation.
export async function repairLostQrReservationsAction(
  receiveId: string,
): Promise<
  | { ok: true; repaired: number; skipped: number; capped: boolean }
  | { ok: false; error: string }
> {
  const actor = await requireAdmin();
  try {
    const r = await repairLostQrReservationsBatch(actor);
    if (r.repaired > 0) {
      revalidatePath(`/inbound/${receiveId}`);
      revalidatePath("/qr-cards");
    }
    return { ok: true, repaired: r.repaired, skipped: r.skipped, capped: r.capped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Batch repair failed." };
  }
}
