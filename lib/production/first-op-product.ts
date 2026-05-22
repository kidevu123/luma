// PRD-1: First-operation product selection helper.
//
// At the first production station for a given route (Blister for the
// card route, Bottle Filling for the bottle route, etc.), the
// operator must select the finished product/SKU being made when
// they scan a fresh IDLE card. That product is then locked on the
// workflow_bag and inherited by every downstream station.
//
// Pure helper — no DB calls — so the rule can be unit-tested without
// integration setup. The action loads rows, this helper decides
// allow/reject.

/** Station kinds where the operator must pick a product when starting
 *  a fresh bag (IDLE card scan). Other station kinds either pick up
 *  an already-assigned bag or are not first-op for any route. Bottle
 *  Filling will join this set in PRD-3. */
export const FIRST_OP_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "COMBINED", // does the whole pipeline; first event is BLISTER_COMPLETE
]);

/** Map station kind -> product kinds eligible to start there. CARD
 *  products and VARIETY products both feed the card/blister route.
 *  COMBINED accepts the same. Bottle stations come later. */
export const STATION_KIND_TO_PRODUCT_KINDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  BLISTER: ["CARD", "VARIETY"],
  HANDPACK_BLISTER: ["CARD", "VARIETY"],
  COMBINED: ["CARD", "VARIETY"],
  BOTTLE_HANDPACK: ["BOTTLE", "VARIETY"],
};

export type FirstOpInput = {
  stationKind: string;
  cardStatus: "IDLE" | "ASSIGNED" | "RETIRED";
  /** A productId provided by the operator on the form (or undefined
   *  if not provided). */
  pickedProductId: string | null | undefined;
  /** The product row corresponding to pickedProductId, or null if
   *  pickedProductId is unset / the product doesn't exist. */
  product: {
    id: string;
    sku: string | null;
    name: string | null;
    kind: string;
    isActive: boolean;
  } | null;
};

export type FirstOpResult =
  | { ok: true; productId: string | null }
  | { ok: false; reason: string };

/** Decide whether a fresh-card scan at this station can proceed.
 *  Returns the productId to set on the new workflow_bag (null when
 *  the station kind doesn't require first-op selection). */
export function checkFirstOpProductSelection(
  input: FirstOpInput,
): FirstOpResult {
  // Pickup of an already-assigned card: server fetches product from
  // the existing bag, this helper does not gate it.
  if (input.cardStatus !== "IDLE") {
    return { ok: true, productId: null };
  }
  // Stations that aren't first-op: no product gate. The IDLE-card
  // path here is unusual — log the case but allow.
  if (!FIRST_OP_STATION_KINDS.has(input.stationKind)) {
    return { ok: true, productId: null };
  }
  // First-op station + IDLE card: product is mandatory.
  if (!input.pickedProductId) {
    return {
      ok: false,
      reason:
        "Pick a product before starting. The first production station must record what's being made.",
    };
  }
  if (!input.product) {
    return {
      ok: false,
      reason: "Selected product not found.",
    };
  }
  if (!input.product.isActive) {
    return {
      ok: false,
      reason: `Product ${input.product.sku ?? input.product.id.slice(0, 8)} is inactive.`,
    };
  }
  const allowedKinds = STATION_KIND_TO_PRODUCT_KINDS[input.stationKind] ?? [];
  if (!allowedKinds.includes(input.product.kind)) {
    return {
      ok: false,
      reason: `Product kind ${input.product.kind} cannot start at a ${input.stationKind} station.`,
    };
  }
  return { ok: true, productId: input.pickedProductId };
}
