// Which finished product is this bag making?
//
// Card-route bags start without a product: BLISTER / HANDPACK_BLISTER /
// COMBINED defer the finished SKU to sealing
// (PRODUCT-SELECTION-AT-SEALING-1, lib/production/first-op-product.ts).
// The engine answers the question the same way a human would: look at
// which active products this tablet type can legally become at this
// station, and only ask the operator when there is a real choice.
//
// Pure — the caller (getStationView) supplies the already-filtered list.

import type { ProductOption } from "./types";

export type ProductChoice =
  /** Exactly one compatible product. Nothing to ask: the answer is
   *  master data, not an operator opinion. */
  | { kind: "AUTO"; productId: string }
  /** Two or more. The operator picks; every option is legal, so this is
   *  a choice, not a validation. */
  | { kind: "PICK"; options: ProductOption[] }
  /** None. NOT a pick with an empty list — an operator cannot invent a
   *  product that master data does not have, so the bag stays blocked
   *  and someone fixes product_allowed_tablets. */
  | { kind: "NONE" };

/** Decide whether the bag's product is knowable, pickable, or neither.
 *
 *  Input order is preserved: the loader orders the options (by name),
 *  and re-sorting here would let two callers show the same operator two
 *  different button orders for the same bag. */
export function resolveProductChoice(
  compatible: readonly ProductOption[],
): ProductChoice {
  const first = compatible[0];
  if (!first) return { kind: "NONE" };
  if (compatible.length === 1) return { kind: "AUTO", productId: first.productId };
  return { kind: "PICK", options: [...compatible] };
}
