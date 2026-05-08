// PT-2: pure helpers for the declared/counted/accepted/confidence
// rule. The action layer loads/inserts rows; this file decides what
// numbers go where and what confidence to label them with.
//
// Business rule: we do not always physically count packaging on
// arrival. Sometimes we trust the supplier box label. Confidence
// tracks which case we're in, and reconciliation must never silently
// treat a supplier-declared count as if it were measured truth.

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";

export type AcceptanceInput = {
  declaredQuantity: number | null | undefined;
  countedQuantity: number | null | undefined;
  /** When `IMPORT`, mark confidence LOW even if quantities are
   *  present. Bulk legacy imports never get HIGH or MEDIUM. */
  source?: "PACKTRACK" | "MANUAL_LUMA" | "ZOHO" | "IMPORT" | null | undefined;
};

export type AcceptanceResult = {
  acceptedQuantity: number | null;
  confidence: Confidence;
  /** True when both declared and counted are present and they
   *  disagree. Receivers must NOT treat this as production loss —
   *  it's a vendor-declared-vs-counted variance, surfaced separately
   *  in reconciliation. */
  hasVariance: boolean;
  /** counted - declared. Null when either is absent. */
  variance: number | null;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number") return null;
  if (!Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/** Compute accepted quantity + confidence + variance per the PT-1
 *  rule. Pure — no DB access. */
export function computeAcceptance(input: AcceptanceInput): AcceptanceResult {
  const declared = num(input.declaredQuantity);
  const counted = num(input.countedQuantity);
  const isImport = input.source === "IMPORT";

  if (counted == null && declared == null) {
    return {
      acceptedQuantity: null,
      confidence: "MISSING",
      hasVariance: false,
      variance: null,
    };
  }

  // Imports never produce HIGH/MEDIUM confidence regardless of which
  // fields are populated — they're bulk historical data.
  if (isImport) {
    return {
      acceptedQuantity: counted ?? declared,
      confidence: "LOW",
      hasVariance: counted != null && declared != null && counted !== declared,
      variance: counted != null && declared != null ? counted - declared : null,
    };
  }

  if (counted != null) {
    return {
      acceptedQuantity: counted,
      confidence: "HIGH",
      hasVariance: declared != null && counted !== declared,
      variance: declared != null ? counted - declared : null,
    };
  }
  // counted absent, declared present.
  return {
    acceptedQuantity: declared,
    confidence: "MEDIUM",
    hasVariance: false,
    variance: null,
  };
}

/** Compose the human-readable label that appears in receipt
 *  summaries / reconciliation rows. Stable strings — UI can
 *  pattern-match them safely. */
export function describeAcceptance(r: AcceptanceResult): string {
  if (r.acceptedQuantity == null) return "No usable quantity recorded";
  switch (r.confidence) {
    case "HIGH":
      if (r.hasVariance) {
        return `Physically counted (${r.acceptedQuantity}) — declared was off by ${r.variance}`;
      }
      return `Physically counted (${r.acceptedQuantity})`;
    case "MEDIUM":
      return `Supplier-declared only (${r.acceptedQuantity}) — not physically counted`;
    case "LOW":
      return `Imported low confidence (${r.acceptedQuantity})`;
    case "MISSING":
      return "No usable quantity recorded";
  }
}

/** Variance severity for `PACKAGING_VARIANCE_RECORDED.payload.severity`.
 *  Default thresholds; downstream report can override per-material. */
export function classifyVarianceSeverity(input: {
  variance: number;
  declared: number;
}): "LOW" | "MEDIUM" | "HIGH" {
  if (input.declared <= 0) return "HIGH";
  const pct = Math.abs(input.variance) / input.declared;
  if (pct <= 0.01) return "LOW"; // <= 1%
  if (pct <= 0.05) return "MEDIUM"; // <= 5%
  return "HIGH";
}
