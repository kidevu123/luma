// STATION-3B — pure scan-to-start decisions for the floor station form.
// No React, no DB — unit-tested without mounting the client component.

export type FloorScanProduct = {
  id: string;
  allowedTabletTypeIds: string[];
};

export type FloorScanStartDecision =
  | { kind: "auto-start"; productId: string }
  | { kind: "pick-product" }
  | { kind: "config-error"; message: string }
  | { kind: "pickup-auto" };

/** Mirror scan-card-form filteredProducts / handleResolvedToken narrowing. */
export function narrowProductsByTablet<T extends FloorScanProduct>(
  products: T[],
  tabletTypeId: string | null,
): T[] {
  if (!tabletTypeId) return products;
  return products.filter((p) => p.allowedTabletTypeIds.includes(tabletTypeId));
}

export function productConfigErrorMessage(tabletTypeId: string | null): string {
  return tabletTypeId
    ? "No active products are configured for this tablet type at this station. Ask a supervisor to set up the product mapping."
    : "No active products configured for this station kind. Supervisor must add a product to the route.";
}

/** After lookupCardByTokenAction succeeds, decide whether to auto-submit. */
export function decideScanStartAfterLookup(args: {
  requireProductForFreshBag: boolean;
  isIntakeReserved: boolean;
  tabletTypeId: string | null;
  allowedProducts: FloorScanProduct[];
}): FloorScanStartDecision {
  if (args.requireProductForFreshBag && args.isIntakeReserved) {
    const narrowed = narrowProductsByTablet(args.allowedProducts, args.tabletTypeId);
    if (narrowed.length === 1 && narrowed[0]) {
      return { kind: "auto-start", productId: narrowed[0].id };
    }
    if (narrowed.length === 0) {
      return { kind: "config-error", message: productConfigErrorMessage(args.tabletTypeId) };
    }
    return { kind: "pick-product" };
  }
  return { kind: "pickup-auto" };
}

/** True when a second resolve/submit for the same raw token should be ignored. */
export function shouldIgnoreDuplicateScan(args: {
  rawToken: string;
  inFlightToken: string | null;
  submitInFlight: boolean;
  scanPending: boolean;
}): boolean {
  const trimmed = args.rawToken.trim();
  if (!trimmed) return true;
  if (args.submitInFlight || args.scanPending) return true;
  if (args.inFlightToken !== null && args.inFlightToken === trimmed) return true;
  return false;
}
