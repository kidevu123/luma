type QrCardSortable = {
  card: { label: string; cardType: string };
  intakeBag?: {
    internalReceiptNumber: string | null;
    receiveName?: string | null;
  } | null;
  intakeBatchNumber?: string | null;
  productName?: string | null;
};

const TYPE_PRIORITY: Record<string, number> = {
  RAW_BAG: 0,
  VARIETY_PACK: 1,
  WORKFLOW_TRAVELER: 2,
  UNKNOWN: 3,
};

/**
 * Sorts QR card rows: RAW_BAG first, then VARIETY_PACK, then others.
 * Within each group, numerically by label (bag-card-1 < bag-card-2 < bag-card-49 < bag-card-200).
 * Returns a new array; does not mutate input.
 */
export function sortQrRows<T extends QrCardSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = TYPE_PRIORITY[a.card.cardType] ?? 4;
    const pb = TYPE_PRIORITY[b.card.cardType] ?? 4;
    if (pa !== pb) return pa - pb;
    return a.card.label.localeCompare(b.card.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * Returns true if the row matches the search query.
 * Matches: label, scan token (and its numeric portion), receipt number, supplier lot, product name.
 */
export function matchesQrSearch(row: QrCardSortable & { card: { scanToken?: string } }, q: string): boolean {
  if (!q) return true;
  const qLower = q.toLowerCase();
  return (
    row.card.label.toLowerCase().includes(qLower) ||
    (row.card.scanToken?.toLowerCase().includes(qLower) ?? false) ||
    (row.intakeBag?.internalReceiptNumber?.toLowerCase().includes(qLower) ?? false) ||
    (row.intakeBag?.receiveName?.toLowerCase().includes(qLower) ?? false) ||
    (row.intakeBatchNumber?.toLowerCase().includes(qLower) ?? false) ||
    (row.productName?.toLowerCase().includes(qLower) ?? false)
  );
}
