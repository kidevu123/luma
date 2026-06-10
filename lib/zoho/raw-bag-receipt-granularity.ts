// ZOHO-RAW-BAG-RECEIPT — bag-finish receive granularity (v1.21).

/**
 * Policy: one Zoho purchase receive per physical inventory bag, committed at
 * bag finish/close/deplete — not at intake and not from production-output qty.
 *
 * Same PO line + item + batch/lot may have many physical bags; each bag is
 * tracked and received separately in Luma and Zoho.
 */
export const RAW_BAG_RECEIPT_GRANULARITY = {
  policy: "ONE_ZOHO_RECEIVE_PER_PHYSICAL_BAG_AT_FINISH" as const,
  timing: "bag_finish_close_deplete" as const,
  operatorSummary:
    "Each physical bag gets its own Zoho purchase receive when the bag is finished or depleted on the floor. A 6-bag intake may create up to 6 Zoho PRs — one per bag — after each bag's production cycle completes.",
  idempotencyScope: "inventory_bag_id",
  idempotencyKeyPrefix: "luma-bag-finish-receive",
  zohoReceiveIdUnique: true,
} as const;
