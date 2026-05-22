// Station kinds that produce CARD (blister) finished goods.
const CARD_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "SEALING",
  "PACKAGING",
]);

// Station kinds that produce BOTTLE finished goods.
const BOTTLE_STATION_KINDS: ReadonlySet<string> = new Set([
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
]);

export interface CandidateProduct {
  id: string;
  name: string;
  sku: string;
  kind: string; // "CARD" | "BOTTLE" | "VARIETY"
}

export type ProductResolution =
  | { kind: "auto"; product: CandidateProduct }
  | { kind: "choose"; candidates: CandidateProduct[] }
  | { kind: "config_error"; message: string; fallback: CandidateProduct[] };

/**
 * Decides which product(s) to present given a station type and allowed product
 * list for a scanned bag's tablet type.
 *
 * - Single candidate → auto-select regardless of station.
 * - Card station (BLISTER/SEALING/PACKAGING) → keep only CARD products.
 * - Bottle station (BOTTLE_HANDPACK/BOTTLE_CAP_SEAL/BOTTLE_STICKER) → keep only BOTTLE products.
 * - COMBINED / unknown station → no filtering; all candidates remain.
 * - After filtering: 1 left → auto; 0 left → config_error with fallback; >1 → choose.
 */
export function resolveStartProductionProduct({
  stationKind,
  candidateProducts,
}: {
  stationKind: string | null | undefined;
  candidateProducts: CandidateProduct[];
}): ProductResolution {
  if (candidateProducts.length === 0) {
    return {
      kind: "config_error",
      message: "No products configured for this tablet type.",
      fallback: [],
    };
  }

  if (candidateProducts.length === 1) {
    return { kind: "auto", product: candidateProducts[0]! };
  }

  // Multiple candidates — try to narrow by station type.
  let filtered: CandidateProduct[];
  if (stationKind && CARD_STATION_KINDS.has(stationKind)) {
    filtered = candidateProducts.filter((p) => p.kind === "CARD");
  } else if (stationKind && BOTTLE_STATION_KINDS.has(stationKind)) {
    filtered = candidateProducts.filter((p) => p.kind === "BOTTLE");
  } else {
    // COMBINED or unknown — cannot narrow.
    filtered = candidateProducts;
  }

  if (filtered.length === 1) {
    return { kind: "auto", product: filtered[0]! };
  }

  if (filtered.length === 0) {
    const expected = stationKind && CARD_STATION_KINDS.has(stationKind)
      ? "CARD"
      : "BOTTLE";
    return {
      kind: "config_error",
      message: `No ${expected} products are configured for this tablet type. This station expects ${expected} products. Contact an admin to fix the product mapping.`,
      fallback: candidateProducts,
    };
  }

  return { kind: "choose", candidates: filtered };
}
