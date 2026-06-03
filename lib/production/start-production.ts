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

export type QrValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validates that a QR card looked up from a raw bag's bagQrCode is eligible
 * to start production. The card parameter is null if no card was found.
 */
export function validateRawBagQrForStart(
  card: { status: string; cardType: string; assignedWorkflowBagId: string | null } | null,
  bagQrCode: string | null,
  options?: { allowPartialBagRestart?: boolean },
): QrValidationResult {
  if (!bagQrCode) {
    return { ok: false, error: "This raw bag has no QR card assigned. Assign a QR card at receiving before starting production." };
  }
  if (!card) {
    return { ok: false, error: `No QR card found for code ${bagQrCode}. Contact admin.` };
  }
  if (card.cardType !== "RAW_BAG") {
    return { ok: false, error: `The QR card for this bag is type ${card.cardType}, not RAW_BAG. Contact admin.` };
  }
  if (card.status === "RETIRED") {
    return { ok: false, error: "The QR card for this bag is retired and cannot be used. Contact admin to replace it." };
  }
  if (card.status === "ASSIGNED" && card.assignedWorkflowBagId !== null) {
    if (options?.allowPartialBagRestart) {
      return { ok: true };
    }
    return { ok: false, error: "The QR card for this bag is already assigned to an active production workflow. If this bag is already in production, do not start it again." };
  }
  // Allow IDLE or ASSIGNED+null (intake-reserved). Reject anything else, including future status values.
  if (card.status !== "IDLE" && card.status !== "ASSIGNED") {
    return { ok: false, error: `QR card status is ${card.status}; cannot start production.` };
  }
  return { ok: true };
}
