"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireLead } from "@/lib/auth-guards";
import { addBagToReceive, type AddBagToReceiveInput } from "@/lib/db/queries/receive-add-bag";

export type AddBagFormData = {
  smallBoxId?: string;
  declaredPillCount?: string;
  weightKg?: string;
  notes?: string;
  internalReceiptNumber?: string;
  bagQrCode?: string;
  supplierLotNumber?: string;
  addReason?: string;
};

export async function addBagAction(
  receiveId: string,
  raw: AddBagFormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const actor = await requireLead();

  const input: AddBagToReceiveInput = {
    addReason: raw.addReason ?? "",
  };

  if (raw.smallBoxId?.trim()) input.smallBoxId = raw.smallBoxId.trim();
  if (raw.notes !== undefined) input.notes = raw.notes.trim() || null;
  if (raw.internalReceiptNumber !== undefined) {
    input.internalReceiptNumber = raw.internalReceiptNumber.trim() || null;
  }
  if (raw.bagQrCode !== undefined) input.bagQrCode = raw.bagQrCode.trim() || null;
  if (raw.supplierLotNumber !== undefined) {
    input.supplierLotNumber = raw.supplierLotNumber.trim() || null;
  }

  if (raw.declaredPillCount !== undefined && raw.declaredPillCount.trim() !== "") {
    const n = Number(raw.declaredPillCount.trim());
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "Invalid declared pill count." };
    }
    input.declaredPillCount = n;
  }

  if (raw.weightKg !== undefined && raw.weightKg.trim() !== "") {
    const kg = parseFloat(raw.weightKg);
    if (isNaN(kg) || kg < 0) return { ok: false, error: "Invalid weight." };
    input.weightGrams = Math.round(kg * 1000);
  }

  const result = await addBagToReceive(receiveId, input, actor);
  if (result.ok) {
    revalidatePath(`/inbound/${receiveId}`);
    revalidatePath("/inbound");
    revalidatePath("/qr-cards");
  }
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function addBagAndRedirect(
  receiveId: string,
  raw: AddBagFormData,
): Promise<{ ok: false; error: string } | void> {
  const result = await addBagAction(receiveId, raw);
  if (!result.ok) return result;
  redirect(`/inbound/${receiveId}`);
}
