// PRODUCT-SELECTION-AT-SEALING-1 — pure helpers for sealing-time
// product mapping. Card/blister bags may start without a product;
// sealing staff pick the finished SKU before SEALING_COMPLETE.

import {
  STATION_KIND_TO_PRODUCT_KINDS,
} from "@/lib/production/first-op-product";

/** Product kinds eligible when mapping at a card-route sealing station. */
export const SEALING_STATION_KINDS = new Set(["SEALING", "COMBINED"]);

export type SealingProductRow = {
  id: string;
  sku: string | null;
  name: string | null;
  kind: string;
  isActive: boolean;
};

export type SealingProductPickInput = {
  stationKind: string;
  pickedProductId: string | null | undefined;
  product: SealingProductRow | null;
  tabletTypeId: string | null;
  allowedTabletTypeIds: readonly string[];
};

export type SealingProductPickResult =
  | { ok: true; productId: string }
  | { ok: false; reason: string };

/** Filter active CARD/VARIETY products to those compatible with a tablet type. */
export function filterSealingProductsByTabletType<
  T extends { id: string; allowedTabletTypeIds: readonly string[] },
>(products: readonly T[], tabletTypeId: string | null): T[] {
  if (!tabletTypeId) return [...products];
  return products.filter((p) => p.allowedTabletTypeIds.includes(tabletTypeId));
}

/** Validate a product pick at sealing before persisting to workflow_bags. */
export function validateSealingProductPick(
  input: SealingProductPickInput,
): SealingProductPickResult {
  if (!SEALING_STATION_KINDS.has(input.stationKind)) {
    return {
      ok: false,
      reason: `Station kind ${input.stationKind} cannot map product at sealing.`,
    };
  }
  if (!input.pickedProductId) {
    return {
      ok: false,
      reason:
        "Select the finished product before completing sealing.",
    };
  }
  if (!input.product) {
    return { ok: false, reason: "Selected product not found." };
  }
  if (!input.product.isActive) {
    return {
      ok: false,
      reason: `Product ${input.product.sku ?? input.product.id.slice(0, 8)} is inactive.`,
    };
  }
  const allowedKinds = STATION_KIND_TO_PRODUCT_KINDS[input.stationKind] ?? [
    "CARD",
    "VARIETY",
  ];
  if (!allowedKinds.includes(input.product.kind)) {
    return {
      ok: false,
      reason: `Product kind ${input.product.kind} is not valid for this sealing station.`,
    };
  }
  if (
    input.tabletTypeId &&
    input.allowedTabletTypeIds.length > 0 &&
    !input.allowedTabletTypeIds.includes(input.tabletTypeId)
  ) {
    return {
      ok: false,
      reason:
        "Selected product is not configured for this bag's tablet type.",
    };
  }
  return { ok: true, productId: input.pickedProductId };
}
