// PT-6B — Pure 8-bucket reconciliation helpers.
//
// Implements the math defined in docs/PT-6_RECONCILIATION_PLAN.md
// without touching the database. PT-6C will feed these helpers from
// projectors / read models; PT-6D will render the result on the
// admin reconciliation page.
//
// Bucket model:
//   1. DECLARED              — supplier / PO / box-label quantity (MEDIUM at best)
//   2. COUNTED               — physically counted (HIGH)
//   3. ACCEPTED              — counted ?? declared ?? legacy qty_received
//   4. CONSUMED_ESTIMATED    — output × BOM / standards / segment ledger
//   5. CONSUMED_ACTUAL       — weigh-back / depletion yield / cycle-count delta
//   6. SCRAPPED_OR_DAMAGED   — explicit scrap or damage signal
//   7. ON_HAND               — current usable remaining
//   8. VARIANCE (4 subtypes) — RECEIPT / CYCLE_COUNT / CONSUMPTION / UNKNOWN
//
// Hard rules (from the plan):
//   - Vendor shortage (RECEIPT_VARIANCE) is NEVER labelled production loss.
//   - Cycle-count drift (CYCLE_COUNT_VARIANCE) is NEVER auto-blamed on supplier.
//   - The four variance subtypes are PARALLEL, not additive — each is reported
//     independently and never sums into another.
//   - DECLARED is never HIGH confidence (by definition not yet verified).
//   - UNKNOWN_VARIANCE is never reported above LOW confidence (by construction
//     we cannot classify what kind of gap it is).

// ─────────────────────────────────────────────────────────────────────────────
// Type model
// ─────────────────────────────────────────────────────────────────────────────

export type ReconciliationConfidence = "HIGH" | "MEDIUM" | "LOW" | "MISSING";

export type ReconciliationBucketName =
  | "DECLARED"
  | "COUNTED"
  | "ACCEPTED"
  | "CONSUMED_ESTIMATED"
  | "CONSUMED_ACTUAL"
  | "SCRAPPED_OR_DAMAGED"
  | "ON_HAND"
  | "VARIANCE";

export type VarianceKind =
  | "RECEIPT_VARIANCE"
  | "CYCLE_COUNT_VARIANCE"
  | "CONSUMPTION_VARIANCE"
  | "UNKNOWN_VARIANCE";

export type VarianceSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "MISSING";

export type ReconciliationQuantity = {
  value: number | null;
  unit: string | null;
  confidence: ReconciliationConfidence;
  /** Free-text source identifier — names the column or event that
   *  populated this quantity. Read by the UI for the per-bucket
   *  badge and by audit reports. */
  source: string | null;
  missingInputs: string[];
  explanation?: string;
  /** True when the value is BOM/standards-derived rather than a
   *  direct measurement. UI must render the "estimated" pill. */
  estimated?: boolean;
};

export type ReconciliationVariance = {
  kind: VarianceKind;
  value: number | null;
  unit: string | null;
  confidence: ReconciliationConfidence;
  severity: VarianceSeverity;
  explanation: string;
  missingInputs: string[];
};

export type ReconciliationResult = {
  declared: ReconciliationQuantity;
  counted: ReconciliationQuantity;
  accepted: ReconciliationQuantity;
  consumedEstimated: ReconciliationQuantity;
  consumedActual: ReconciliationQuantity;
  scrappedOrDamaged: ReconciliationQuantity;
  onHand: ReconciliationQuantity;
  variances: ReconciliationVariance[];
  /** Per the plan's documented rule (NOT lowest-of-all):
   *    - HIGH    if ACCEPTED is HIGH AND (CONSUMED_ACTUAL is HIGH OR ON_HAND is HIGH)
   *    - MEDIUM  if ACCEPTED is MEDIUM, or HIGH-but-only-estimated consumption
   *    - LOW     if ACCEPTED came from legacy fallback
   *    - MISSING if ACCEPTED itself is missing  */
  overallConfidence: ReconciliationConfidence;
  warnings: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Input shapes — what PT-6C will assemble from read models
// ─────────────────────────────────────────────────────────────────────────────

export type ReceiptSourceSystem =
  | "PACKTRACK"
  | "MANUAL_LUMA"
  | "ZOHO"
  | "IMPORT";

export type ReceiptInput = {
  declaredQuantity: number | null;
  countedQuantity: number | null;
  /** Pre-PT-1 fallback: rows that have only qty_received populated.
   *  Used as a LOW-confidence backstop for ACCEPTED. */
  qtyReceivedLegacy: number | null;
  sourceSystem: ReceiptSourceSystem | null;
};

export type EstimatedConsumptionSource =
  | "BOM"
  | "ROLL_SEGMENT_STANDARD"
  | "LEGACY"
  | null;

export type ActualConsumptionSource =
  | "WEIGH_BACK"
  | "DEPLETION_YIELD"
  | "CYCLE_COUNT_DELTA"
  | "MANUAL_ENTRY"
  | null;

export type ConsumptionInput = {
  estimated: {
    value: number | null;
    source: EstimatedConsumptionSource;
  } | null;
  actual: {
    value: number | null;
    source: ActualConsumptionSource;
  } | null;
};

export type OnHandSource =
  | "CYCLE_COUNT"
  | "WEIGH_BACK_DERIVED"
  | "QTY_ON_HAND"
  | null;

export type InventoryInput = {
  onHandQty: number | null;
  onHandSource: OnHandSource;
  /** Latest physical-count value within the window. When present
   *  CYCLE_COUNT_VARIANCE compares this against estimated_remaining. */
  cycleCountActualRemaining: number | null;
};

export type ScrapSource =
  | "EXPLICIT_SCRAP_EVENT"
  | "READ_BAG_METRICS_DAMAGE"
  | null;

export type ScrapInput = {
  value: number | null;
  source: ScrapSource;
};

export type ReconciliationInput = {
  unit: string;
  receipt: ReceiptInput;
  consumption: ConsumptionInput;
  inventory: InventoryInput;
  scrap: ScrapInput | null;
  /** Signed sum of PACKAGING_RECEIPT_ADJUSTED deltas in the window
   *  that AREN'T part of the cycle count being evaluated. Defaults
   *  to 0 — most lots have no mid-life adjustments. */
  adjustments?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure utilities
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeQuantity(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

const CONFIDENCE_RANK: Record<ReconciliationConfidence, number> = {
  MISSING: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/** Lowest-confidence wins. Empty list returns MISSING. The plan's
 *  "don't blindly use lowest" rule is enforced at deriveReconciliation
 *  Result level (overallConfidence), not here — this helper is the
 *  building block for per-bucket combine. */
export function combineConfidence(
  values: ReadonlyArray<ReconciliationConfidence>,
): ReconciliationConfidence {
  if (values.length === 0) return "MISSING";
  let min: ReconciliationConfidence = "HIGH";
  for (const v of values) {
    if (CONFIDENCE_RANK[v] < CONFIDENCE_RANK[min]) min = v;
  }
  return min;
}

/** Variance severity classifier mirrors lib/inbound/packaging-receipt.
 *  Bands: NONE (≈0), LOW (≤1% of baseline), MEDIUM (≤5%), HIGH (>5%).
 *  When baseline is null/zero, falls back to absolute magnitude bands
 *  (≤1, ≤5, >5) so we don't divide by zero. MISSING when value is null. */
export function classifyVarianceSeverity(
  value: number | null,
  baseline: number | null,
): VarianceSeverity {
  if (value == null) return "MISSING";
  if (Math.abs(value) < 0.0001) return "NONE";
  if (baseline == null || baseline === 0) {
    const abs = Math.abs(value);
    if (abs <= 1) return "LOW";
    if (abs <= 5) return "MEDIUM";
    return "HIGH";
  }
  const pct = Math.abs(value / baseline) * 100;
  if (pct <= 1) return "LOW";
  if (pct <= 5) return "MEDIUM";
  return "HIGH";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-bucket derivers
// ─────────────────────────────────────────────────────────────────────────────

export function deriveDeclaredQuantity(
  receipt: ReceiptInput,
  unit: string,
): ReconciliationQuantity {
  const v = normalizeQuantity(receipt.declaredQuantity);
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["declared_quantity"],
    };
  }
  return {
    value: v,
    unit,
    confidence: "MEDIUM",
    source:
      receipt.sourceSystem === "PACKTRACK"
        ? "packtrack_declared"
        : "declared_quantity",
    missingInputs: [],
    explanation: "supplier-declared quantity (never HIGH by definition)",
  };
}

export function deriveCountedQuantity(
  receipt: ReceiptInput,
  unit: string,
): ReconciliationQuantity {
  const v = normalizeQuantity(receipt.countedQuantity);
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["counted_quantity"],
    };
  }
  return {
    value: v,
    unit,
    confidence: "HIGH",
    source: "physical_count",
    missingInputs: [],
  };
}

export function deriveAcceptedQuantity(
  receipt: ReceiptInput,
  unit: string,
): ReconciliationQuantity {
  const counted = normalizeQuantity(receipt.countedQuantity);
  const declared = normalizeQuantity(receipt.declaredQuantity);
  const legacy = normalizeQuantity(receipt.qtyReceivedLegacy);
  if (counted != null) {
    return {
      value: counted,
      unit,
      confidence: "HIGH",
      source: "counted_quantity",
      missingInputs: [],
    };
  }
  if (declared != null) {
    return {
      value: declared,
      unit,
      confidence: "MEDIUM",
      source:
        receipt.sourceSystem === "PACKTRACK"
          ? "packtrack_declared"
          : "declared_quantity",
      missingInputs: ["counted_quantity"],
      explanation:
        "supplier-declared (no physical count) — labelled MEDIUM until counted",
    };
  }
  if (legacy != null) {
    return {
      value: legacy,
      unit,
      confidence: "LOW",
      source: "legacy_qty_received",
      missingInputs: ["counted_quantity", "declared_quantity"],
      explanation:
        "legacy qty_received fallback (pre-PT-1) — LOW confidence, needs backfill",
    };
  }
  return {
    value: null,
    unit,
    confidence: "MISSING",
    source: null,
    missingInputs: [
      "counted_quantity",
      "declared_quantity",
      "qty_received",
    ],
    explanation: "no usable quantity — lot needs intake",
  };
}

export function deriveConsumedEstimated(
  consumption: ConsumptionInput,
  unit: string,
): ReconciliationQuantity {
  const est = consumption.estimated;
  const v = est ? normalizeQuantity(est.value) : null;
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["consumed_estimated"],
      estimated: true,
      explanation: "no BOM-driven or segment-ledger consumption signal",
    };
  }
  let confidence: ReconciliationConfidence = "MEDIUM";
  if (est?.source === "LEGACY") confidence = "LOW";
  return {
    value: v,
    unit,
    confidence,
    source: est?.source ?? null,
    missingInputs: [],
    estimated: true,
  };
}

export function deriveConsumedActual(
  consumption: ConsumptionInput,
  unit: string,
): ReconciliationQuantity {
  const act = consumption.actual;
  const v = act ? normalizeQuantity(act.value) : null;
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["consumed_actual"],
      estimated: false,
      explanation:
        "no weigh-back / depletion / cycle-count delta — actual consumption not measured",
    };
  }
  let confidence: ReconciliationConfidence = "HIGH";
  if (act?.source === "DEPLETION_YIELD") confidence = "MEDIUM";
  return {
    value: v,
    unit,
    confidence,
    source: act?.source ?? null,
    missingInputs: [],
    estimated: false,
  };
}

export function deriveScrappedOrDamaged(
  scrap: ScrapInput | null,
  unit: string,
): ReconciliationQuantity {
  const v = scrap ? normalizeQuantity(scrap.value) : null;
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["scrap"],
      explanation:
        "no live raw-material scrap event today — QC subsystem will populate",
    };
  }
  let confidence: ReconciliationConfidence;
  if (scrap?.source === "EXPLICIT_SCRAP_EVENT") confidence = "HIGH";
  else if (scrap?.source === "READ_BAG_METRICS_DAMAGE") confidence = "MEDIUM";
  else confidence = "LOW";
  return {
    value: v,
    unit,
    confidence,
    source: scrap?.source ?? null,
    missingInputs: [],
  };
}

export function deriveOnHand(
  inventory: InventoryInput,
  unit: string,
): ReconciliationQuantity {
  const v = normalizeQuantity(inventory.onHandQty);
  if (v == null) {
    return {
      value: null,
      unit,
      confidence: "MISSING",
      source: null,
      missingInputs: ["on_hand"],
    };
  }
  let confidence: ReconciliationConfidence;
  if (inventory.onHandSource === "CYCLE_COUNT") confidence = "HIGH";
  else if (inventory.onHandSource === "WEIGH_BACK_DERIVED") confidence = "HIGH";
  else confidence = "MEDIUM"; // QTY_ON_HAND default
  return {
    value: v,
    unit,
    confidence,
    source: inventory.onHandSource ?? null,
    missingInputs: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variance derivers (the four subtypes)
// ─────────────────────────────────────────────────────────────────────────────

export function deriveReceiptVariance(
  receipt: ReceiptInput,
  unit: string,
): ReconciliationVariance {
  const counted = normalizeQuantity(receipt.countedQuantity);
  const declared = normalizeQuantity(receipt.declaredQuantity);
  if (counted == null || declared == null) {
    const missing: string[] = [];
    if (counted == null) missing.push("counted_quantity");
    if (declared == null) missing.push("declared_quantity");
    return {
      kind: "RECEIPT_VARIANCE",
      value: null,
      unit,
      confidence: "MISSING",
      severity: "MISSING",
      explanation:
        "vendor / shipping discrepancy cannot be classified without both counted and declared",
      missingInputs: missing,
    };
  }
  const value = counted - declared;
  return {
    kind: "RECEIPT_VARIANCE",
    value,
    unit,
    confidence: "HIGH",
    severity: classifyVarianceSeverity(value, declared),
    explanation:
      value === 0
        ? "supplier counted matches declared"
        : value < 0
          ? "supplier short-shipped — vendor / shipping discrepancy"
          : "supplier over-shipped — verify with supplier (rare)",
    missingInputs: [],
  };
}

/** Estimated remaining quantity — accepted minus the BOM-driven
 *  consumption + scrap, plus any windowed adjustments. Used as the
 *  baseline for CYCLE_COUNT_VARIANCE. Returns null when ACCEPTED is
 *  itself missing. */
export function deriveEstimatedRemaining(
  input: ReconciliationInput,
): { value: number; confidence: ReconciliationConfidence } | null {
  const accepted = deriveAcceptedQuantity(input.receipt, input.unit);
  if (accepted.value == null) return null;
  const consumedEst = deriveConsumedEstimated(input.consumption, input.unit);
  const scrap = deriveScrappedOrDamaged(input.scrap, input.unit);
  const consumedVal = consumedEst.value ?? 0;
  const scrapVal = scrap.value ?? 0;
  const adj = input.adjustments ?? 0;
  const value = accepted.value - consumedVal - scrapVal + adj;
  // Confidence chains the inputs that actually contributed a value.
  const inputs: ReconciliationConfidence[] = [accepted.confidence];
  if (consumedEst.value != null) inputs.push(consumedEst.confidence);
  if (scrap.value != null) inputs.push(scrap.confidence);
  return { value, confidence: combineConfidence(inputs) };
}

export function deriveCycleCountVariance(
  input: ReconciliationInput,
): ReconciliationVariance {
  const actual = normalizeQuantity(input.inventory.cycleCountActualRemaining);
  const estimated = deriveEstimatedRemaining(input);
  if (actual == null || !estimated) {
    const missing: string[] = [];
    if (actual == null) missing.push("cycle_count_actual_remaining");
    if (!estimated) missing.push("estimated_remaining_inputs");
    return {
      kind: "CYCLE_COUNT_VARIANCE",
      value: null,
      unit: input.unit,
      confidence: "MISSING",
      severity: "MISSING",
      explanation:
        "no cycle count in window — drift / shrinkage cannot be classified",
      missingInputs: missing,
    };
  }
  const value = actual - estimated.value;
  return {
    kind: "CYCLE_COUNT_VARIANCE",
    value,
    unit: input.unit,
    confidence: "HIGH",
    severity: classifyVarianceSeverity(value, estimated.value),
    explanation:
      value === 0
        ? "physical count matches expected — no drift"
        : value < 0
          ? "physical count below expected (shrink / mis-issue / count error)"
          : "physical count above expected (un-issued / mis-counted earlier)",
    missingInputs: [],
  };
}

export function deriveConsumptionVariance(
  input: ReconciliationInput,
): ReconciliationVariance {
  const est = deriveConsumedEstimated(input.consumption, input.unit);
  const act = deriveConsumedActual(input.consumption, input.unit);
  if (est.value == null || act.value == null) {
    const missing: string[] = [];
    if (est.value == null) missing.push("consumed_estimated");
    if (act.value == null) missing.push("consumed_actual");
    return {
      kind: "CONSUMPTION_VARIANCE",
      value: null,
      unit: input.unit,
      confidence: "MISSING",
      severity: "MISSING",
      explanation:
        "process loss vs BOM cannot be computed without both estimated and actual consumption",
      missingInputs: missing,
    };
  }
  const value = act.value - est.value;
  return {
    kind: "CONSUMPTION_VARIANCE",
    value,
    unit: input.unit,
    confidence: combineConfidence([est.confidence, act.confidence]),
    severity: classifyVarianceSeverity(value, est.value),
    explanation:
      value === 0
        ? "actual consumption matches BOM"
        : value > 0
          ? "production used MORE than BOM predicted (setup waste / over-feed)"
          : "production used LESS than BOM predicted (standards may be loose, or yield was higher)",
    missingInputs: [],
  };
}

export function deriveUnknownVariance(
  input: ReconciliationInput,
): ReconciliationVariance {
  const accepted = deriveAcceptedQuantity(input.receipt, input.unit);
  const act = deriveConsumedActual(input.consumption, input.unit);
  const est = deriveConsumedEstimated(input.consumption, input.unit);
  const scrap = deriveScrappedOrDamaged(input.scrap, input.unit);
  const onHand = deriveOnHand(input.inventory, input.unit);
  if (accepted.value == null) {
    return {
      kind: "UNKNOWN_VARIANCE",
      value: null,
      unit: input.unit,
      confidence: "MISSING",
      severity: "MISSING",
      explanation: "cannot compute unknown variance without ACCEPTED",
      missingInputs: ["accepted"],
    };
  }
  // The four named variances are PARALLEL, not additive — see the plan
  // §1.8. Unknown is whatever the equation accepted = consumed_used +
  // scrap + on_hand + unknown leaves over. consumed_used prefers actual
  // (HIGH-confidence) and falls back to estimated.
  const consumedUsed = act.value ?? est.value ?? 0;
  const scrapVal = scrap.value ?? 0;
  const onHandVal = onHand.value ?? 0;
  const value = accepted.value - consumedUsed - scrapVal - onHandVal;
  return {
    kind: "UNKNOWN_VARIANCE",
    value,
    unit: input.unit,
    // Plan rule §1.8.d: UNKNOWN_VARIANCE is NEVER reported above LOW.
    // We can't classify the gap, so the bucket's confidence is by
    // definition LOW — even if every input was HIGH.
    confidence: "LOW",
    severity: classifyVarianceSeverity(value, accepted.value),
    explanation:
      Math.abs(value) < 0.0001
        ? "all material accounted for under named buckets"
        : value > 0
          ? "unaccounted material missing — investigate (unrecorded scrap, missed cycle count, projector lag)"
          : "unaccounted material extra — investigate (double-issue, miscounted on_hand, or duplicate consumption)",
    missingInputs: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level result
// ─────────────────────────────────────────────────────────────────────────────

export function deriveReconciliationResult(
  input: ReconciliationInput,
): ReconciliationResult {
  const declared = deriveDeclaredQuantity(input.receipt, input.unit);
  const counted = deriveCountedQuantity(input.receipt, input.unit);
  const accepted = deriveAcceptedQuantity(input.receipt, input.unit);
  const consumedEstimated = deriveConsumedEstimated(
    input.consumption,
    input.unit,
  );
  const consumedActual = deriveConsumedActual(input.consumption, input.unit);
  const scrappedOrDamaged = deriveScrappedOrDamaged(input.scrap, input.unit);
  const onHand = deriveOnHand(input.inventory, input.unit);

  const variances: ReconciliationVariance[] = [
    deriveReceiptVariance(input.receipt, input.unit),
    deriveCycleCountVariance(input),
    deriveConsumptionVariance(input),
    deriveUnknownVariance(input),
  ];

  // Overall confidence rule (plan §4):
  //   HIGH    if ACCEPTED is HIGH AND (CONSUMED_ACTUAL is HIGH OR ON_HAND is HIGH)
  //   MEDIUM  if ACCEPTED is MEDIUM, OR HIGH-but-only-estimated consumption
  //   LOW     if ACCEPTED came from legacy fallback
  //   MISSING if ACCEPTED itself is missing
  let overallConfidence: ReconciliationConfidence;
  const warnings: string[] = [];
  if (accepted.confidence === "MISSING") {
    overallConfidence = "MISSING";
    warnings.push(
      "ACCEPTED is missing — lot needs intake before reconciliation is meaningful",
    );
  } else if (accepted.confidence === "LOW") {
    overallConfidence = "LOW";
    warnings.push(
      "legacy qty_received fallback in use — needs counted/declared backfill",
    );
  } else if (accepted.confidence === "HIGH") {
    if (
      consumedActual.confidence === "HIGH" ||
      onHand.confidence === "HIGH"
    ) {
      overallConfidence = "HIGH";
    } else {
      overallConfidence = "MEDIUM";
      if (consumedActual.value == null) {
        warnings.push(
          "no actual consumption signal — consumption variance cannot be computed",
        );
      }
    }
  } else {
    overallConfidence = "MEDIUM";
    if (consumedActual.value == null) {
      warnings.push(
        "no actual consumption signal — consumption is estimated only",
      );
    }
  }
  if (scrappedOrDamaged.confidence === "MISSING") {
    warnings.push(
      "no scrap/damage signal — raw-material scrap deferred to QC subsystem",
    );
  }

  return {
    declared,
    counted,
    accepted,
    consumedEstimated,
    consumedActual,
    scrappedOrDamaged,
    onHand,
    variances,
    overallConfidence,
    warnings,
  };
}
