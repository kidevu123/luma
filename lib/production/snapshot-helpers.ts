// Pure helpers for the validation-snapshot script. Extracted so the
// formatting + bag-total reconciliation logic can be unit-tested
// without a database.

export type BagTotalRow = {
  workflow_bag_id: string | null;
  pvc_total: number;
  foil_total: number;
  segment_count: number;
};

export type BagTotalDisplay = {
  workflow_bag_id: string | null;
  pvc_total: number;
  foil_total: number;
  segment_count: number;
  /** Per-bag blister count, derived from the per-role segment sums.
   *  PVC and FOIL counts come from the same physical machine cycle,
   *  so they MUST match for any bag with full per-role coverage.
   *  Null when they don't (mismatch flagged separately). */
  bag_total: number | null;
  mismatch: boolean;
};

/** Reconcile a bag's PVC vs. FOIL segment sums into a single
 *  bag-total. Both rolls advance through the same blister cycles, so
 *  the totals MUST be equal — a mismatch is a data-integrity signal,
 *  not a number to average over. */
export function reconcileBagTotal(row: BagTotalRow): BagTotalDisplay {
  const mismatch = row.pvc_total !== row.foil_total;
  return {
    ...row,
    bag_total: mismatch ? null : row.pvc_total,
    mismatch,
  };
}

/** Format a single line for the snapshot's "Bag totals from segments"
 *  section. Caller groups + headers; this just builds one line. */
export function formatBagTotalLine(d: BagTotalDisplay): string {
  const bagId = (d.workflow_bag_id ?? "—").slice(0, 8).padEnd(10);
  const segs = String(d.segment_count).padStart(2);
  const pvc = String(d.pvc_total).padStart(6);
  const foil = String(d.foil_total).padStart(6);
  if (d.mismatch) {
    return (
      `  bag=${bagId} total=  WARN  segments=${segs}  pvc=${pvc}  foil=${foil}` +
      `  ⚠ PVC/FOIL totals differ — review required`
    );
  }
  return (
    `  bag=${bagId} total=${String(d.bag_total ?? 0).padStart(6)}  ` +
    `segments=${segs}  pvc=${pvc}  foil=${foil}`
  );
}
