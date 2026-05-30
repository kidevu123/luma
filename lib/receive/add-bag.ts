export const DEFAULT_ADD_BAG_REASON = "Historical migration / manual correction";

export type AddBagToReceiveInput = {
  smallBoxId?: string | null;
  declaredPillCount?: number | null;
  weightGrams?: number | null;
  notes?: string | null;
  internalReceiptNumber?: string | null;
  bagQrCode?: string | null;
  supplierLotNumber?: string | null;
  addReason: string;
};

export function validateAddBagInput(
  input: AddBagToReceiveInput,
  boxCount: number,
): { ok: true } | { ok: false; error: string } {
  if (!input.addReason?.trim()) {
    return { ok: false, error: "Add reason is required." };
  }
  if (boxCount > 1 && !input.smallBoxId?.trim()) {
    return { ok: false, error: "Select which box this bag belongs to." };
  }
  return { ok: true };
}

export function resolveTargetBoxId(
  boxes: readonly { id: string }[],
  smallBoxId?: string | null,
): { ok: true; boxId: string } | { ok: false; error: string } {
  if (boxes.length === 0) {
    return { ok: false, error: "This receive has no boxes — cannot add a bag." };
  }
  if (boxes.length === 1) {
    return { ok: true, boxId: boxes[0]!.id };
  }
  const id = smallBoxId?.trim();
  if (!id) {
    return { ok: false, error: "Select which box this bag belongs to." };
  }
  const box = boxes.find((b) => b.id === id);
  if (!box) {
    return { ok: false, error: "Selected box does not belong to this receive." };
  }
  return { ok: true, boxId: box.id };
}

export function nextBagNumber(existingMax: number | null | undefined): number {
  return (existingMax ?? 0) + 1;
}
