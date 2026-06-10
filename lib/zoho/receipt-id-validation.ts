// ZOHO-RECEIPT-ID — keep Luma internal receipt numbers distinct from Zoho entity IDs.

/** Zoho Inventory entity IDs are long numeric strings (typically 15–20 digits). */
const ZOHO_ENTITY_ID_PATTERN = /^\d{12,22}$/;

/**
 * Short numeric tokens (e.g. 352176) are Luma internal receipt numbers, not Zoho IDs.
 */
export function isLikelyLumaInternalReceiptNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  return trimmed.length <= 8;
}

export function looksLikeZohoPurchaseReceiveEntityId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isLikelyLumaInternalReceiptNumber(trimmed)) return false;
  return ZOHO_ENTITY_ID_PATTERN.test(trimmed);
}

export function validateZohoPurchaseReceiveIdCandidate(
  candidate: string,
  internalReceiptNumber: string | null,
): { ok: true; zohoPurchaseReceiveId: string } | { ok: false; reason: string } {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "Zoho purchase receive ID is required.",
    };
  }

  if (
    internalReceiptNumber &&
    trimmed === internalReceiptNumber.trim()
  ) {
    return {
      ok: false,
      reason:
        "This value is the Luma receipt number, not a Zoho purchase receive ID. Look up the Zoho Inventory entity ID instead.",
    };
  }

  if (isLikelyLumaInternalReceiptNumber(trimmed)) {
    return {
      ok: false,
      reason:
        "Short numeric values are Luma receipt numbers. Enter the Zoho Inventory purchase receive entity ID.",
    };
  }

  if (!looksLikeZohoPurchaseReceiveEntityId(trimmed)) {
    return {
      ok: false,
      reason:
        "Value does not look like a Zoho Inventory entity ID. Use the ID returned by Zoho (long numeric string).",
    };
  }

  return { ok: true, zohoPurchaseReceiveId: trimmed };
}
