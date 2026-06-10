// ZOHO-RAW-BAG-RECEIPT — receipt granularity policy (locked for v1.20.8).

/**
 * Policy A: one Zoho purchase receive per physical inventory bag.
 *
 * Rationale: each Path B bag has its own declared physical quantity, QR
 * reservation, and floor allocation. Zoho Inventory receives post per bag
 * at full declaredPillCount. Intake receive groups bags for operator UX only.
 *
 * Policy B (one receive per Luma intake receive) is NOT supported in v1.20.8.
 */
export const RAW_BAG_RECEIPT_GRANULARITY = {
  policy: "ONE_ZOHO_RECEIVE_PER_PHYSICAL_BAG" as const,
  operatorSummary:
    "Each physical bag commits as its own Zoho purchase receive. A 6-bag intake creates up to 6 Zoho PRs when all bags are committed.",
  idempotencyScope: "inventory_bag_id",
  zohoReceiveIdUnique: true,
} as const;
