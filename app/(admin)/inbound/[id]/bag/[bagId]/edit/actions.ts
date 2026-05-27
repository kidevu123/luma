"use server";

import { requireLead } from "@/lib/auth-guards";
import { editInventoryBag, type BagEditInput } from "@/lib/db/queries/bag-edits";
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
