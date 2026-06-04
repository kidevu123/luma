type QrCardSortable = {
  card: { label: string; cardType: string };
  intakeBag?: {
    internalReceiptNumber: string | null;
    receiveName?: string | null;
    poNumber?: string | null;
    tabletTypeName?: string | null;
  } | null;
  intakeBatchNumber?: string | null;
  productName?: string | null;
  workflowState?: {
    stage?: string | null;
  } | null;
};

const TYPE_PRIORITY: Record<string, number> = {
  RAW_BAG: 0,
  VARIETY_PACK: 1,
  WORKFLOW_TRAVELER: 2,
  UNKNOWN: 3,
};

/**
 * Extracts the trailing integer from a label, regardless of separator style.
 * "bag-card-42"  → 42
 * "Bag Card 042" → 42
 * "variety-pack-5" → 5
 * "old-legacy" → 0 (no digits → sort to front of group)
 */
export function numericSuffix(label: string): number {
  const m = label.match(/(\d+)\D*$/);
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * Sorts QR card rows: RAW_BAG first, then VARIETY_PACK, then others.
 * Within each group, sorts by the trailing numeric suffix of the label
 * so that bag-card-2 < bag-card-10 < bag-card-200 regardless of whether
 * labels use hyphens ("bag-card-N"), spaces ("Bag Card N"), or mixed case.
 * Falls back to locale-alphabetical for ties (equal suffix or no digits).
 * Returns a new array; does not mutate input.
 */
export function sortQrRows<T extends QrCardSortable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = TYPE_PRIORITY[a.card.cardType] ?? 4;
    const pb = TYPE_PRIORITY[b.card.cardType] ?? 4;
    if (pa !== pb) return pa - pb;
    const na = numericSuffix(a.card.label);
    const nb = numericSuffix(b.card.label);
    if (na !== nb) return na - nb;
    return a.card.label.localeCompare(b.card.label, undefined, {
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
    (row.intakeBag?.poNumber?.toLowerCase().includes(qLower) ?? false) ||
    (row.intakeBag?.tabletTypeName?.toLowerCase().includes(qLower) ?? false) ||
    (row.intakeBatchNumber?.toLowerCase().includes(qLower) ?? false) ||
    (row.productName?.toLowerCase().includes(qLower) ?? false) ||
    (row.workflowState?.stage?.toLowerCase().includes(qLower) ?? false)
  );
}
