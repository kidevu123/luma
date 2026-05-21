// PRD-2: Packaging-completion prereq check.
//
// PACKAGING_COMPLETE must NEVER be allowed when the bag has no
// product or the product has no packaging structure — otherwise the
// projector silently records `unitsYielded = 0` and downstream
// reconciliation reports zero finished units.
//
// Pure helper so the rule is unit-testable independent of the DB.
// The action loads the rows, this helper decides allow/reject.

export type PackagingPrereqInput = {
  /** workflow_bags row (only the fields we care about). */
  bag: {
    id: string;
    productId: string | null;
  };
  /** products row keyed by bag.productId, or null if not loaded
   *  because bag has no product. */
  product: {
    id: string;
    name: string | null;
    sku: string | null;
    unitsPerDisplay: number | null;
    displaysPerCase: number | null;
  } | null;
};

export type PackagingPrereqResult =
  | { ok: true }
  | { ok: false; reason: string };

export function checkPackagingPrereqs(
  input: PackagingPrereqInput,
): PackagingPrereqResult {
  if (!input.bag.productId) {
    return {
      ok: false,
      reason:
        "Product not selected for this production run. Cannot complete packaging.",
    };
  }
  if (!input.product) {
    // bag.productId references a row that no longer exists. Distinct
    // from "no product set" — surface the data-integrity case rather
    // than the missing-selection case.
    return {
      ok: false,
      reason:
        "Bag references a product that was not found. Cannot complete packaging.",
    };
  }
  const missingStructure: string[] = [];
  if (input.product.unitsPerDisplay == null) {
    missingStructure.push("units per display");
  }
  if (input.product.displaysPerCase == null) {
    missingStructure.push("displays per case");
  }
  if (missingStructure.length > 0) {
    const skuLabel =
      input.product.sku ?? input.product.name ?? input.product.id.slice(0, 8);
    return {
      ok: false,
      reason: `Product packaging structure missing (${missingStructure.join(
        " and ",
      )}) for SKU ${skuLabel}. Cannot complete packaging.`,
    };
  }
  return { ok: true };
}
