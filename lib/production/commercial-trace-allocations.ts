// COMMERCIAL-TRACE-4 — finished-lot allocation suggestion engine.
//
// Pure logic. Given a normalized Zoho invoice line plus a pool of
// finished-lot candidates the DB layer pre-fetched, return suggested
// allocations the operator will later confirm in COMMERCIAL-TRACE-5.
//
// Design contract (per project brief + lib/production/commercial-trace.ts):
//   - Engine NEVER emits HIGH confidence. HIGH only ever comes from an
//     explicit operator confirmation or a pack-out scan.
//   - Engine NEVER marks a row CONFIRMED. CONFIRMED status is also
//     gated behind operator action.
//   - Suggested allocations are SUGGESTED or NEEDS_REVIEW. REJECTED is
//     reserved for fixed problems an operator dismisses; the engine
//     itself uses it for impossible candidates (customer mismatch).
//   - Customer-scope visibility is enforced at the API edge by
//     commercialTraceVisibilityPolicy; this engine returns identifiers
//     that may later be filtered.
//   - One invoice line CAN allocate across multiple finished lots; one
//     finished lot CAN allocate to multiple invoice lines.
//   - Suggested quantity may never exceed the candidate's remaining
//     available quantity unless options.allowOverAllocation is true.
//
// Module is fully pure: no DB, no fetch, no env reads. The DB query
// layer lives in lib/db/queries/commercial-trace-allocations.ts.

// ─── Confidence + status vocab ────────────────────────────────────────────

/** Confidence band the engine may emit. Mirrors the broader vocabulary
 *  in lib/production/commercial-trace.ts but drops HIGH — HIGH is
 *  reserved for confirmed allocations. */
export type EngineConfidence = "MEDIUM" | "LOW" | "MISSING";

/** Status the engine may emit. Mirrors the broader allocation status
 *  vocabulary, again without CONFIRMED. REJECTED is used for candidates
 *  that fail a hard filter (customer mismatch). */
export type EngineStatus = "SUGGESTED" | "NEEDS_REVIEW" | "REJECTED";

/** Free-text source labels for finished_lot_invoice_allocations.source.
 *  The engine always emits an AUTO_SUGGESTED_* variant; operator
 *  confirmations and pack-out scans use OPERATOR_CONFIRMED /
 *  PACK_OUT_SCAN in later phases. */
export const ENGINE_SOURCES = {
  EXACT_ONE_LOT: "AUTO_SUGGESTED_EXACT",
  SPLIT_ACROSS_LOTS: "AUTO_SUGGESTED_SPLIT",
  PARTIAL_SINGLE_LOT: "AUTO_SUGGESTED_PARTIAL",
  REVIEW_FALLBACK: "AUTO_SUGGESTED_REVIEW",
} as const;
export type EngineSource = (typeof ENGINE_SOURCES)[keyof typeof ENGINE_SOURCES];

/** Reason codes attached to a suggestion. Plain-text strings; consumers
 *  render them as chips in the review UI later. */
export type AllocationReason =
  // Product matching
  | "product_match_zoho_item_id"
  | "product_match_external_mapping"
  | "product_match_sku"
  | "product_match_name_fallback"
  | "product_mismatch"
  | "no_product_mapping"
  // Customer matching
  | "customer_match_id"
  | "customer_match_via_zoho_id"
  | "customer_mismatch"
  | "missing_customer"
  // Date signals
  | "date_within_window"
  | "date_outside_window"
  | "packed_before_invoice"
  | "shipped_after_invoice"
  // Quantity matching
  | "quantity_exact"
  | "quantity_split"
  | "quantity_under_match"
  | "quantity_over_match"
  | "quantity_missing"
  | "candidate_quantity_unavailable"
  // Unit handling
  | "unit_match"
  | "unit_missing"
  | "unit_conflict_no_conversion";

export type AllocationWarning = string;

// ─── Input + candidate shapes ─────────────────────────────────────────────

/** Pure input shape. Mirrors the COMMERCIAL-TRACE-4 spec field-for-field. */
export type InvoiceLineAllocationInput = {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string | Date | null;
  customerId: string | null;
  zohoCustomerId: string | null;
  invoiceLineId: string;
  zohoItemId: string | null;
  sku: string | null;
  itemName: string;
  quantity: number | null;
  unit: string | null;
};

/** One pre-fetched finished-lot candidate. The DB layer composes these
 *  from finished_lots ⋈ shipment_finished_lots ⋈ products. */
export type FinishedLotAllocationCandidate = {
  finishedLotId: string;
  shipmentFinishedLotId: string | null;
  customerId: string | null;
  productId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  traceCode: string | null;
  /** Total quantity of this lot/shipment-pair available to allocate
   *  against (typically shipment_finished_lots.quantity minus the sum
   *  of confirmed allocations against this pair). null when unknown. */
  quantityAvailable: number | null;
  unit: string | null;
  packedAt: Date | null;
  shippedAt: Date | null;
  /** Quantity already allocated to other invoice lines (confirmed or
   *  suggested). Engine subtracts this from quantityAvailable. */
  alreadyAllocatedQuantity: number | null;
  /** Latest invoice_allocation_status on the shipment_finished_lots row. */
  invoiceAllocationStatus: string | null;
  /** External-item-mapping evidence the DB layer can attach when the
   *  candidate matched via external_item_mappings rather than direct
   *  zoho_item_id on products. Free-text; presence flips the matching
   *  reason. */
  matchedViaExternalMapping?: boolean;
};

/** One returned suggestion. The DB layer converts these into
 *  finished_lot_invoice_allocations rows via buildAllocationInsertRows. */
export type AllocationSuggestion = {
  invoiceLineId: string;
  finishedLotId: string;
  shipmentFinishedLotId: string | null;
  quantitySuggested: number;
  unit: string | null;
  confidence: EngineConfidence;
  source: EngineSource;
  status: EngineStatus;
  reasons: readonly AllocationReason[];
  warnings: readonly AllocationWarning[];
};

export type SuggestAllocationsOptions = {
  /** When true, suggested quantity may exceed candidate available
   *  quantity (rare — useful when allocation is intentionally manual).
   *  Default false. */
  allowOverAllocation?: boolean;
  /** Days of slack on either side of invoiceDate for the "date within
   *  window" heuristic. Default 14 days. */
  dateWindowDays?: number;
};

export type SuggestAllocationsResult = {
  suggestions: AllocationSuggestion[];
  unallocatedQuantity: number;
  warnings: AllocationWarning[];
  /** Diagnostic — every candidate evaluated, including rejected ones,
   *  with the reason it was rejected. UI can show this in a "Why this
   *  was rejected" expander. */
  evaluatedCandidates: Array<{
    finishedLotId: string;
    shipmentFinishedLotId: string | null;
    rejected: boolean;
    reasons: readonly AllocationReason[];
  }>;
};

// ─── Date helpers ─────────────────────────────────────────────────────────

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function diffDays(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / 86_400_000);
}

// ─── Pure matching helpers ────────────────────────────────────────────────

/** Pure: classify the product-side match between an invoice line and a
 *  candidate finished lot. Returns the matching reason plus a confidence
 *  hint. Hierarchy: zoho_item_id → external_item_mappings → sku →
 *  name fallback (NEEDS_REVIEW). */
export function classifyProductMatch(input: {
  invoiceLine: Pick<InvoiceLineAllocationInput, "zohoItemId" | "sku" | "itemName">;
  candidate: Pick<
    FinishedLotAllocationCandidate,
    "zohoItemId" | "sku" | "matchedViaExternalMapping"
  > & { productName?: string | null };
}):
  | {
      matched: true;
      reason: Extract<
        AllocationReason,
        | "product_match_zoho_item_id"
        | "product_match_external_mapping"
        | "product_match_sku"
        | "product_match_name_fallback"
      >;
      /** "MEDIUM" for id-based matches, "LOW" for SKU or name fallback. */
      strength: "MEDIUM" | "LOW";
    }
  | { matched: false; reason: "product_mismatch" | "no_product_mapping" } {
  const inv = input.invoiceLine;
  const cand = input.candidate;
  const invId = (inv.zohoItemId ?? "").trim();
  const invSku = (inv.sku ?? "").trim().toLowerCase();
  const invName = (inv.itemName ?? "").trim().toLowerCase();
  const candId = (cand.zohoItemId ?? "").trim();
  const candSku = (cand.sku ?? "").trim().toLowerCase();
  const candName = (cand.productName ?? "").trim().toLowerCase();

  // Direct zoho_item_id match.
  if (invId.length > 0 && candId.length > 0) {
    if (invId === candId) {
      return {
        matched: true,
        reason: "product_match_zoho_item_id",
        strength: "MEDIUM",
      };
    }
    // Both sides carry ids and they don't match — different products.
    if (invSku.length > 0 && candSku.length > 0 && invSku !== candSku) {
      return { matched: false, reason: "product_mismatch" };
    }
  }

  // Mapped via external_item_mappings.
  if (cand.matchedViaExternalMapping === true) {
    return {
      matched: true,
      reason: "product_match_external_mapping",
      strength: "MEDIUM",
    };
  }

  // SKU match.
  if (invSku.length > 0 && candSku.length > 0) {
    if (invSku === candSku) {
      return {
        matched: true,
        reason: "product_match_sku",
        strength: "MEDIUM",
      };
    }
    return { matched: false, reason: "product_mismatch" };
  }

  // Name-only fallback — LOW confidence.
  if (invName.length > 0 && candName.length > 0 && invName === candName) {
    return {
      matched: true,
      reason: "product_match_name_fallback",
      strength: "LOW",
    };
  }

  // Neither id, SKU, nor name agreed — no usable mapping.
  return { matched: false, reason: "no_product_mapping" };
}

/** Pure: classify the customer-side match between an invoice line and
 *  a candidate. Customer mismatch is a hard filter. Missing customer on
 *  either side becomes NEEDS_REVIEW (not a rejection — review can fix). */
export function classifyCustomerMatch(input: {
  invoiceLine: Pick<InvoiceLineAllocationInput, "customerId" | "zohoCustomerId">;
  candidate: Pick<FinishedLotAllocationCandidate, "customerId">;
  zohoCustomerIdToLumaId?: Map<string, string>;
}):
  | { matched: true; reason: "customer_match_id" | "customer_match_via_zoho_id" }
  | { matched: false; reason: "customer_mismatch" | "missing_customer" } {
  const invCustomer = input.invoiceLine.customerId;
  const candCustomer = input.candidate.customerId;

  if (invCustomer && candCustomer) {
    return invCustomer === candCustomer
      ? { matched: true, reason: "customer_match_id" }
      : { matched: false, reason: "customer_mismatch" };
  }

  // Try the zoho_customer_id → luma customer_id lookup.
  if (
    input.invoiceLine.zohoCustomerId &&
    input.zohoCustomerIdToLumaId &&
    candCustomer
  ) {
    const mapped = input.zohoCustomerIdToLumaId.get(
      input.invoiceLine.zohoCustomerId,
    );
    if (mapped) {
      return mapped === candCustomer
        ? { matched: true, reason: "customer_match_via_zoho_id" }
        : { matched: false, reason: "customer_mismatch" };
    }
  }

  return { matched: false, reason: "missing_customer" };
}

/** Pure: classify the unit relationship between invoice line and
 *  candidate. Never invents conversions. */
export function classifyUnitMatch(input: {
  invoiceUnit: string | null;
  candidateUnit: string | null;
}):
  | { ok: true; reason: "unit_match" | "unit_missing" }
  | { ok: false; reason: "unit_conflict_no_conversion" } {
  const a = (input.invoiceUnit ?? "").trim().toLowerCase();
  const b = (input.candidateUnit ?? "").trim().toLowerCase();
  if (a === "" && b === "") return { ok: true, reason: "unit_missing" };
  if (a === "" || b === "") return { ok: true, reason: "unit_missing" };
  if (a === b) return { ok: true, reason: "unit_match" };
  return { ok: false, reason: "unit_conflict_no_conversion" };
}

/** Pure: derive a per-candidate score for ranking. Higher = preferred.
 *  Score breakdown:
 *    +100 for zoho_item_id match
 *    +80  for external_item_mappings match
 *    +60  for SKU match
 *    +20  for name fallback
 *    +30  if shipped within dateWindowDays of invoiceDate
 *    +10  if packed before invoice date
 *    -20  if customer mismatched (will be filtered earlier; defensive)
 *    +20  if remaining-available quantity >= invoice line quantity */
function scoreCandidate(input: {
  productMatchReason: AllocationReason;
  unitOk: boolean;
  dateProximityDays: number | null;
  dateWindowDays: number;
  remainingAvailable: number;
  invoiceQuantity: number | null;
}): number {
  let score = 0;
  switch (input.productMatchReason) {
    case "product_match_zoho_item_id":
      score += 100;
      break;
    case "product_match_external_mapping":
      score += 80;
      break;
    case "product_match_sku":
      score += 60;
      break;
    case "product_match_name_fallback":
      score += 20;
      break;
    default:
      break;
  }
  if (!input.unitOk) score -= 10;
  if (input.dateProximityDays != null) {
    if (input.dateProximityDays <= input.dateWindowDays) score += 30;
    else if (input.dateProximityDays <= input.dateWindowDays * 2) score += 10;
  }
  if (
    input.invoiceQuantity != null &&
    input.remainingAvailable >= input.invoiceQuantity
  ) {
    score += 20;
  }
  return score;
}

// ─── Core engine ─────────────────────────────────────────────────────────

/** Pure: suggest finished-lot allocations for one invoice line.
 *
 *  Steps:
 *    1. Pre-filter candidates by hard rules (customer mismatch =>
 *       rejected). Customer-missing candidates stay in the pool with
 *       NEEDS_REVIEW.
 *    2. Run product + unit + date classifiers. Discard product
 *       mismatches.
 *    3. Score and sort surviving candidates.
 *    4. Greedy-allocate: assign as much of the invoice-line quantity to
 *       each candidate as it has remaining-available quantity (subject
 *       to allowOverAllocation). Stop when quantity is exhausted.
 *    5. Surface unallocated quantity + warnings.
 *
 *  Idempotent: same input → same suggestions (sort stable on
 *  (score desc, shippedAt desc, finishedLotId asc)). */
export function suggestAllocationsForInvoiceLine(
  input: InvoiceLineAllocationInput,
  candidates: readonly FinishedLotAllocationCandidate[],
  options: SuggestAllocationsOptions & {
    /** Optional table from the customers Drizzle query — invoice's
     *  zoho_customer_id → luma customer_id. */
    zohoCustomerIdToLumaId?: Map<string, string>;
  } = {},
): SuggestAllocationsResult {
  const dateWindowDays = options.dateWindowDays ?? 14;
  const allowOverAllocation = options.allowOverAllocation === true;
  const invoiceDate = toDate(input.invoiceDate);

  const warnings: AllocationWarning[] = [];
  const evaluated: SuggestAllocationsResult["evaluatedCandidates"] = [];

  if (input.quantity == null) {
    return {
      suggestions: [
        // Single MISSING suggestion documents the gap; consumers render
        // it as "needs review — quantity unknown".
        {
          invoiceLineId: input.invoiceLineId,
          finishedLotId: "",
          shipmentFinishedLotId: null,
          quantitySuggested: 0,
          unit: input.unit,
          confidence: "MISSING",
          source: ENGINE_SOURCES.REVIEW_FALLBACK,
          status: "NEEDS_REVIEW",
          reasons: Object.freeze(["quantity_missing"] as AllocationReason[]),
          warnings: Object.freeze([
            "Invoice line quantity is missing; engine cannot suggest a quantity to allocate.",
          ] as AllocationWarning[]),
        },
      ],
      unallocatedQuantity: 0,
      warnings: ["Invoice line has no quantity."],
      evaluatedCandidates: evaluated,
    };
  }

  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return {
      suggestions: [
        {
          invoiceLineId: input.invoiceLineId,
          finishedLotId: "",
          shipmentFinishedLotId: null,
          quantitySuggested: 0,
          unit: input.unit,
          confidence: "MISSING",
          source: ENGINE_SOURCES.REVIEW_FALLBACK,
          status: "NEEDS_REVIEW",
          reasons: Object.freeze([
            "quantity_missing",
          ] as AllocationReason[]),
          warnings: Object.freeze([
            `Invoice line quantity ${input.quantity} is not a positive finite number.`,
          ] as AllocationWarning[]),
        },
      ],
      unallocatedQuantity: 0,
      warnings: [],
      evaluatedCandidates: evaluated,
    };
  }

  type Scored = {
    candidate: FinishedLotAllocationCandidate;
    productReason: AllocationReason;
    productStrength: "MEDIUM" | "LOW";
    customerReason: AllocationReason;
    unitOk: boolean;
    unitReason: AllocationReason;
    dateReason: AllocationReason | null;
    dateProximityDays: number | null;
    remainingAvailable: number;
    score: number;
  };

  const scored: Scored[] = [];

  for (const c of candidates) {
    const reasons: AllocationReason[] = [];

    // Customer.
    const customer = classifyCustomerMatch({
      invoiceLine: input,
      candidate: c,
      zohoCustomerIdToLumaId: options.zohoCustomerIdToLumaId ?? new Map(),
    });
    if (!customer.matched && customer.reason === "customer_mismatch") {
      evaluated.push({
        finishedLotId: c.finishedLotId,
        shipmentFinishedLotId: c.shipmentFinishedLotId,
        rejected: true,
        reasons: Object.freeze(["customer_mismatch"] as AllocationReason[]),
      });
      continue;
    }
    reasons.push(customer.reason);

    // Product.
    const product = classifyProductMatch({
      invoiceLine: input,
      candidate: c,
    });
    if (!product.matched) {
      evaluated.push({
        finishedLotId: c.finishedLotId,
        shipmentFinishedLotId: c.shipmentFinishedLotId,
        rejected: true,
        reasons: Object.freeze([
          customer.reason,
          product.reason,
        ] as AllocationReason[]),
      });
      continue;
    }
    reasons.push(product.reason);

    // Unit.
    const unit = classifyUnitMatch({
      invoiceUnit: input.unit,
      candidateUnit: c.unit,
    });
    reasons.push(unit.reason);

    // Date.
    let dateReason: AllocationReason | null = null;
    let dateProximity: number | null = null;
    if (invoiceDate) {
      const shipDate = c.shippedAt ?? c.packedAt;
      if (shipDate) {
        const days = diffDays(invoiceDate, shipDate);
        dateProximity = days;
        if (days <= dateWindowDays) {
          dateReason = "date_within_window";
        } else {
          dateReason = "date_outside_window";
        }
      }
      if (c.packedAt && c.packedAt.getTime() < invoiceDate.getTime()) {
        reasons.push("packed_before_invoice");
      }
      if (c.shippedAt && c.shippedAt.getTime() > invoiceDate.getTime()) {
        reasons.push("shipped_after_invoice");
      }
    }
    if (dateReason) reasons.push(dateReason);

    const totalAvail = c.quantityAvailable ?? 0;
    const used = c.alreadyAllocatedQuantity ?? 0;
    const remaining = Math.max(0, totalAvail - used);
    if (remaining <= 0 && !allowOverAllocation) {
      evaluated.push({
        finishedLotId: c.finishedLotId,
        shipmentFinishedLotId: c.shipmentFinishedLotId,
        rejected: true,
        reasons: Object.freeze([
          ...reasons,
          "candidate_quantity_unavailable",
        ]),
      });
      continue;
    }

    const score = scoreCandidate({
      productMatchReason: product.reason,
      unitOk: unit.ok,
      dateProximityDays: dateProximity,
      dateWindowDays,
      remainingAvailable: remaining,
      invoiceQuantity: input.quantity,
    });

    evaluated.push({
      finishedLotId: c.finishedLotId,
      shipmentFinishedLotId: c.shipmentFinishedLotId,
      rejected: false,
      reasons: Object.freeze(reasons),
    });

    scored.push({
      candidate: c,
      productReason: product.reason,
      productStrength: product.strength,
      customerReason: customer.reason,
      unitOk: unit.ok,
      unitReason: unit.reason,
      dateReason,
      dateProximityDays: dateProximity,
      remainingAvailable: remaining,
      score,
    });
  }

  if (scored.length === 0) {
    // No usable candidates. One NEEDS_REVIEW suggestion documenting it.
    return {
      suggestions: [
        {
          invoiceLineId: input.invoiceLineId,
          finishedLotId: "",
          shipmentFinishedLotId: null,
          quantitySuggested: 0,
          unit: input.unit,
          confidence: "MISSING",
          source: ENGINE_SOURCES.REVIEW_FALLBACK,
          status: "NEEDS_REVIEW",
          reasons: Object.freeze(["no_product_mapping"] as AllocationReason[]),
          warnings: Object.freeze([
            "No usable finished-lot candidates found for this invoice line.",
          ] as AllocationWarning[]),
        },
      ],
      unallocatedQuantity: input.quantity,
      warnings: ["No candidate lots matched."],
      evaluatedCandidates: evaluated,
    };
  }

  // Stable sort: score desc, then shippedAt desc (newer ships first),
  // then finishedLotId asc for determinism.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aShip = a.candidate.shippedAt?.getTime() ?? 0;
    const bShip = b.candidate.shippedAt?.getTime() ?? 0;
    if (bShip !== aShip) return bShip - aShip;
    return a.candidate.finishedLotId.localeCompare(b.candidate.finishedLotId);
  });

  // Greedy allocation.
  const suggestions: AllocationSuggestion[] = [];
  let remainingInvoiceQty = input.quantity;
  const customerIsMissing = scored[0]!.customerReason === "missing_customer";

  for (const s of scored) {
    if (remainingInvoiceQty <= 0) break;
    const take = allowOverAllocation
      ? remainingInvoiceQty
      : Math.min(remainingInvoiceQty, s.remainingAvailable);
    if (take <= 0) continue;

    const isExactSingleLot =
      take === input.quantity && suggestions.length === 0;
    const reasonsForRow: AllocationReason[] = [
      s.customerReason,
      s.productReason,
      s.unitReason,
    ];
    if (s.dateReason) reasonsForRow.push(s.dateReason);

    let confidence: EngineConfidence;
    let status: EngineStatus = "SUGGESTED";
    let source: EngineSource;

    if (isExactSingleLot && s.productStrength === "MEDIUM" && s.unitOk) {
      confidence = "MEDIUM";
      source = ENGINE_SOURCES.EXACT_ONE_LOT;
      reasonsForRow.push("quantity_exact");
    } else if (
      take < remainingInvoiceQty &&
      s.productStrength === "MEDIUM" &&
      s.unitOk
    ) {
      confidence = "MEDIUM";
      source = ENGINE_SOURCES.SPLIT_ACROSS_LOTS;
      reasonsForRow.push("quantity_split");
    } else if (s.productStrength === "MEDIUM" && s.unitOk) {
      // Last lot covering remainder, or partial single lot.
      confidence = "MEDIUM";
      source =
        suggestions.length === 0
          ? ENGINE_SOURCES.PARTIAL_SINGLE_LOT
          : ENGINE_SOURCES.SPLIT_ACROSS_LOTS;
    } else {
      // LOW: name fallback OR unit conflict.
      confidence = "LOW";
      source = ENGINE_SOURCES.REVIEW_FALLBACK;
      status = "NEEDS_REVIEW";
    }

    if (!s.unitOk) {
      // Unit conflict alone is enough to flip the row.
      status = "NEEDS_REVIEW";
      if (confidence === "MEDIUM") confidence = "LOW";
    }
    if (customerIsMissing) {
      status = "NEEDS_REVIEW";
      if (confidence === "MEDIUM") confidence = "LOW";
    }

    suggestions.push({
      invoiceLineId: input.invoiceLineId,
      finishedLotId: s.candidate.finishedLotId,
      shipmentFinishedLotId: s.candidate.shipmentFinishedLotId,
      quantitySuggested: take,
      unit: input.unit ?? s.candidate.unit,
      confidence,
      source,
      status,
      reasons: Object.freeze(reasonsForRow),
      warnings: Object.freeze(
        buildPerRowWarnings({
          unitOk: s.unitOk,
          missingCustomer: customerIsMissing,
        }),
      ),
    });

    remainingInvoiceQty -= take;
  }

  // Under-match: rows exhausted before quantity filled.
  if (remainingInvoiceQty > 0) {
    warnings.push(
      `Could not fully allocate invoice line quantity ${input.quantity} ${input.unit ?? ""}: ${remainingInvoiceQty} remaining.`,
    );
    for (const row of suggestions) {
      // Mark all rows NEEDS_REVIEW with under-match reason.
      Object.defineProperty(row, "reasons", {
        value: Object.freeze([...row.reasons, "quantity_under_match"]),
      });
      if (row.status === "SUGGESTED") row.status = "NEEDS_REVIEW";
    }
  }

  // Over-match: not currently produced by greedy code path unless
  // allowOverAllocation; if it does happen, flag the rows.
  const totalSuggested = suggestions.reduce(
    (s, r) => s + r.quantitySuggested,
    0,
  );
  if (totalSuggested > input.quantity) {
    warnings.push(
      `Allocated more (${totalSuggested}) than the invoice-line quantity (${input.quantity}).`,
    );
    for (const row of suggestions) {
      Object.defineProperty(row, "reasons", {
        value: Object.freeze([...row.reasons, "quantity_over_match"]),
      });
      if (row.status === "SUGGESTED") row.status = "NEEDS_REVIEW";
    }
  }

  return {
    suggestions,
    unallocatedQuantity: Math.max(0, remainingInvoiceQty),
    warnings,
    evaluatedCandidates: evaluated,
  };
}

function buildPerRowWarnings(input: {
  unitOk: boolean;
  missingCustomer: boolean;
}): AllocationWarning[] {
  const out: AllocationWarning[] = [];
  if (!input.unitOk)
    out.push(
      "Invoice line unit and candidate unit conflict; no conversion configured.",
    );
  if (input.missingCustomer)
    out.push(
      "Customer linkage missing on invoice line or candidate; review before confirming.",
    );
  return out;
}

// ─── Summary + DB-row builders ───────────────────────────────────────────

export type SuggestionSummary = {
  totalSuggestedQuantity: number;
  unallocatedQuantity: number;
  confidenceRollup: Record<EngineConfidence, number>;
  statusRollup: Record<EngineStatus, number>;
  warnings: AllocationWarning[];
  candidateCount: number;
  suggestedCount: number;
};

/** Pure: roll up multiple suggestion-engine results. */
export function summarizeAllocationSuggestions(
  results: ReadonlyArray<SuggestAllocationsResult>,
): SuggestionSummary {
  const confidenceRollup: Record<EngineConfidence, number> = {
    MEDIUM: 0,
    LOW: 0,
    MISSING: 0,
  };
  const statusRollup: Record<EngineStatus, number> = {
    SUGGESTED: 0,
    NEEDS_REVIEW: 0,
    REJECTED: 0,
  };
  let totalSuggestedQuantity = 0;
  let unallocatedQuantity = 0;
  const warnings: AllocationWarning[] = [];
  let candidateCount = 0;
  let suggestedCount = 0;

  for (const r of results) {
    for (const s of r.suggestions) {
      confidenceRollup[s.confidence]++;
      statusRollup[s.status]++;
      totalSuggestedQuantity += s.quantitySuggested;
      suggestedCount++;
    }
    unallocatedQuantity += r.unallocatedQuantity;
    warnings.push(...r.warnings);
    candidateCount += r.evaluatedCandidates.length;
  }

  return {
    totalSuggestedQuantity,
    unallocatedQuantity,
    confidenceRollup,
    statusRollup,
    warnings,
    candidateCount,
    suggestedCount,
  };
}

export type AllocationInsertRow = {
  invoiceLineId: string;
  finishedLotId: string;
  shipmentFinishedLotId: string | null;
  quantityAllocated: string; // numeric — keep precision
  unit: string | null;
  confidence: EngineConfidence;
  source: EngineSource;
  status: EngineStatus;
  confirmed: false;
  confirmedByUserId: null;
  confirmedAt: null;
  notes: string | null;
};

/** Pure: map suggestions into the row shape that fits
 *  finished_lot_invoice_allocations. The DB layer inserts these
 *  verbatim. Drops rows with an empty finishedLotId (synthetic "no
 *  candidates" review rows). Engine never emits a CONFIRMED row. */
export function buildAllocationInsertRows(
  suggestions: ReadonlyArray<AllocationSuggestion>,
): AllocationInsertRow[] {
  const out: AllocationInsertRow[] = [];
  for (const s of suggestions) {
    if (!s.finishedLotId) continue;
    if (s.quantitySuggested <= 0) continue;
    out.push({
      invoiceLineId: s.invoiceLineId,
      finishedLotId: s.finishedLotId,
      shipmentFinishedLotId: s.shipmentFinishedLotId,
      // Engine quantity is always positive (we filter <= 0 above).
      quantityAllocated: s.quantitySuggested.toString(),
      unit: s.unit,
      confidence: s.confidence,
      source: s.source,
      status: s.status,
      confirmed: false,
      confirmedByUserId: null,
      confirmedAt: null,
      notes:
        s.warnings.length > 0
          ? s.warnings.join(" | ")
          : s.reasons.length > 0
            ? `engine reasons: ${s.reasons.join(", ")}`
            : null,
    });
  }
  return out;
}

// ─── Pure confirmation helper ────────────────────────────────────────────

/** Pure: lift a suggestion into a confirmed shape. Side-effect-free —
 *  callers persist the result via the DB write layer in a transaction
 *  that also writes an audit row. Confidence is set to HIGH only here
 *  (and only when an explicit user-supplied userId is provided). */
export function confirmAllocationPure(
  suggestion: AllocationSuggestion,
  userId: string,
  confirmedAt: Date,
): {
  invoiceLineId: string;
  finishedLotId: string;
  shipmentFinishedLotId: string | null;
  quantitySuggested: number;
  unit: string | null;
  confidence: "HIGH";
  source: EngineSource | "OPERATOR_CONFIRMED";
  status: "CONFIRMED";
  confirmed: true;
  confirmedByUserId: string;
  confirmedAt: Date;
  reasons: readonly AllocationReason[];
  warnings: readonly AllocationWarning[];
} {
  if (!userId || userId.trim().length === 0) {
    throw new Error("confirmAllocationPure: userId is required.");
  }
  return {
    ...suggestion,
    confidence: "HIGH",
    status: "CONFIRMED",
    confirmed: true,
    confirmedByUserId: userId,
    confirmedAt,
  };
}
