// COMMERCIAL-TRACE-2 — pure helpers for the Zoho invoice ↔ finished-lot
// allocation hinge. Schema-only phase: no DB writes here, only
// normalization, validation, and visibility-policy helpers used by
// tests and (later) by COMMERCIAL-TRACE-3/4/6.
//
// Owner decision (2026-05-15) on visibility scope:
//   Customer-facing scope — NEVER expose supplier lot, internal receipt
//   number, raw bag QR, operator names, or machine/station details.
//   CSR / internal scope — MAY expose all of the above with an
//   internal-only token or an authenticated Luma admin context.
//
// The vocabulary for confidence + status mirrors the existing
// HIGH/MEDIUM/LOW/MISSING ladder used by recall passport + finished-lot
// inputs (see lib/projector/finished-lot-passport.ts), so callers can
// reuse the same UI badges.

/** Recognized confidence bands for a finished-lot allocation row.
 *  Free-text in the DB column so the vocabulary can extend without a
 *  migration; this constant defines the canonical set today. */
export const ALLOCATION_CONFIDENCE_VALUES = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "MISSING",
] as const;
export type AllocationConfidence =
  (typeof ALLOCATION_CONFIDENCE_VALUES)[number];

/** Recognized lifecycle states. Free-text in the DB column. */
export const ALLOCATION_STATUS_VALUES = [
  "SUGGESTED",
  "CONFIRMED",
  "REJECTED",
  "NEEDS_REVIEW",
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUS_VALUES)[number];

/** Commercial-trace visibility scope. Customer scope is the strictest;
 *  CSR scope is internal Luma staff (recall investigations, customer
 *  support). The scope determines which fields are exposed by Nexus
 *  lookup endpoints in later phases. */
export type CommercialTraceScope = "customer" | "csr" | "internal";

/** Fields that the visibility policy treats as CSR-only. Customer-scope
 *  responses MUST drop these. The list is the authoritative source for
 *  isCustomerSafeCommercialTraceField + commercialTraceVisibilityPolicy. */
export const CSR_ONLY_COMMERCIAL_TRACE_FIELDS = [
  "supplier_lot",
  "supplier_lot_number",
  "vendor_lot_number",
  "internal_receipt_number",
  "raw_bag_qr",
  "bag_qr_code",
  "operator_name",
  "operator_id",
  "employee_name",
  "employee_id",
  "machine_id",
  "machine_label",
  "station_id",
  "station_label",
  "qc_history",
] as const;
export type CsrOnlyCommercialTraceField =
  (typeof CSR_ONLY_COMMERCIAL_TRACE_FIELDS)[number];

/** Normalize a Zoho invoice number for de-dup + cross-system matching.
 *  Trims whitespace, uppercases, collapses internal whitespace. Returns
 *  null for empty input so callers can detect "no number supplied". */
export function normalizeInvoiceNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase().replace(/\s+/g, " ");
  return trimmed.length === 0 ? null : trimmed;
}

/** Build a stable de-dup key for a single Zoho invoice line. Used by
 *  the sync upsert path to fall back to (parent UUID + line text id)
 *  when Zoho omits the line id. Empty / whitespace input is treated as
 *  missing — caller should not assume idempotency in that case. */
export function normalizeZohoInvoiceLineKey(
  invoiceId: unknown,
  lineId: unknown,
): string | null {
  if (typeof invoiceId !== "string") return null;
  const trimmedInvoice = invoiceId.trim();
  if (trimmedInvoice.length === 0) return null;
  if (typeof lineId !== "string") return null;
  const trimmedLine = lineId.trim();
  if (trimmedLine.length === 0) return null;
  return `${trimmedInvoice}::${trimmedLine}`;
}

/** Validate quantity_allocated. Mirrors the CHECK constraint in
 *  migration 0036 so the same rule can be surfaced as a user-friendly
 *  error in the UI before the DB rejects the row. */
export function validateAllocationQuantity(value: unknown): {
  ok: true;
  value: number;
} | { ok: false; reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "Quantity must be a finite number." };
  }
  if (value <= 0) {
    return { ok: false, reason: "Quantity must be strictly positive." };
  }
  return { ok: true, value };
}

/** True when `field` is safe to return in a customer-scope response.
 *  Anything that names supplier lot, internal receipt, raw bag QR, or
 *  operator/machine accountability is rejected regardless of case. */
export function isCustomerSafeCommercialTraceField(field: string): boolean {
  const normalized = field.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return !(CSR_ONLY_COMMERCIAL_TRACE_FIELDS as readonly string[]).includes(
    normalized,
  );
}

/** The visibility contract for a given scope. Used by Nexus lookup
 *  endpoints (later phases) to filter response fields. Customer scope
 *  blocks every entry in CSR_ONLY_COMMERCIAL_TRACE_FIELDS; CSR /
 *  internal scope permits the full set. */
export type CommercialTraceVisibilityPolicy = {
  scope: CommercialTraceScope;
  /** Returns true if `field` may appear in a response for this scope. */
  allowField: (field: string) => boolean;
  /** Frozen view of the fields blocked for this scope (empty for CSR /
   *  internal). Test helper. */
  blockedFields: readonly string[];
};

export function commercialTraceVisibilityPolicy(
  scope: CommercialTraceScope,
): CommercialTraceVisibilityPolicy {
  if (scope === "customer") {
    return {
      scope,
      allowField: isCustomerSafeCommercialTraceField,
      blockedFields: CSR_ONLY_COMMERCIAL_TRACE_FIELDS,
    };
  }
  // CSR and internal scopes see everything today; the policy still
  // returns a `allowField` callable so calling code stays uniform.
  return {
    scope,
    allowField: () => true,
    blockedFields: [],
  };
}
