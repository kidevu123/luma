// PRD-1: First-operation product selection helper.
//
// Station vs machine model (authoritative definition):
//   Station  — a floor work area where operators scan bag QRs and record
//              events. Each station has a scan_token URL used to auth the
//              floor PWA. Stations may optionally reference a machine.
//   Machine  — a physical piece of equipment (blister press, sealing
//              machine, etc.). Machines are optional; hand-pack stations
//              have no machine.
//
// Starting-point stations (FIRST_OP_STATION_KINDS below) create fresh
// workflow_bags. Card/blister stations (BLISTER, HANDPACK_BLISTER,
// COMBINED) defer finished-SKU selection to sealing; bottle handpack
// still records product at start.
//
// Normal start flow: operator opens station URL → scans bag QR → system
// picks product automatically if only one match → fires CARD_ASSIGNED.
// Admin "Start Production" page is a supervisor fallback only.
//
// Pure helper — no DB calls — so the rule can be unit-tested without
// integration setup. The action loads rows, this helper decides
// allow/reject.

/** Station kinds that can scan an intake-reserved card and create a
 *  new workflow_bag. */
export const FIRST_OP_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "COMBINED", // does the whole pipeline; first event is BLISTER_COMPLETE
]);

/** Subset of first-op stations where the operator must pick a finished
 *  product before the bag starts. BLISTER / HANDPACK_BLISTER / COMBINED
 *  defer mapping to sealing (PRODUCT-SELECTION-AT-SEALING-1). */
export const PRODUCT_AT_START_STATION_KINDS: ReadonlySet<string> = new Set([
  "BOTTLE_HANDPACK",
]);

/** Map station kind -> product kinds eligible at that station.
 *  Card/blister route stations accept CARD finished goods only.
 *  Variety packs use the dedicated variety-run workflow, not raw-bag
 *  sealing. Bottle handpack may still start BOTTLE or VARIETY runs. */
export const STATION_KIND_TO_PRODUCT_KINDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  BLISTER: ["CARD"],
  HANDPACK_BLISTER: ["CARD"],
  COMBINED: ["CARD"],
  SEALING: ["CARD"],
  PACKAGING: ["CARD"],
  BOTTLE_HANDPACK: ["BOTTLE", "VARIETY"],
  BOTTLE_CAP_SEAL: ["BOTTLE"],
  BOTTLE_STICKER: ["BOTTLE"],
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
 *  the station kind defers product selection to sealing). */
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
  // Card/blister first-op: product is chosen at sealing, not here.
  if (!PRODUCT_AT_START_STATION_KINDS.has(input.stationKind)) {
    return { ok: true, productId: null };
  }
  // Bottle handpack (and any future product-at-start kinds): mandatory.
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
