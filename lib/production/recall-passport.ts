// LOT-1B — receiving-bridge helpers for the finished-lot / recall
// passport schema.
//
// Pure functions only. No DB calls. These helpers shape the raw-bag
// QR payload and the finished-lot trace code so receiving / production
// surfaces (LOT-1C onward) can call them without re-inventing the
// rules.
//
// Strict invariants (per LOT-1A §4 + LOT-1B prompt):
//   - bag_qr_code is a Luma-issued raw-bag identifier prefixed `BAG-`.
//   - finished_lot.trace_code is the customer-facing printed code
//     prefixed `FL-`. Trace codes are NOT vendor lot numbers and
//     should not expose supplier_lot_number unless a customer
//     explicitly opts in via customers.supplier_lot_visible.
//   - Internal receipt numbers are operator-friendly and constructed
//     from receives.receive_name + box_number + bag_number. Existing
//     legacy rows can survive without one (nullable column) — never
//     guess.
//   - bag_qr_code and trace_code live in different namespaces. The
//     prefixes make scanner-routing trivial without a DB lookup.

import type { ShortageConfidence } from "./packtrack-shortage";

// ─── Confidence ladder ────────────────────────────────────────────────

/** Same four-tier ladder used by PT-6 / PT-7 / PBOM. Re-exported for
 *  finished_lot_raw_bags + finished_lot_packaging_lots consumers. */
export type RecallConfidence = ShortageConfidence;

/** Rollup of N edges in a recall chain — MIN wins.
 *  Order: MISSING < LOW < MEDIUM < HIGH. */
export function rollupRecallConfidence(
  values: RecallConfidence[],
): RecallConfidence {
  if (values.length === 0) return "MISSING";
  const rank: Record<RecallConfidence, number> = {
    MISSING: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
  };
  let min: RecallConfidence = "HIGH";
  for (const v of values) {
    if (rank[v] < rank[min]) min = v;
  }
  return min;
}

// ─── Internal receipt numbers ─────────────────────────────────────────

/** Build the canonical internal-receipt-number string from the
 *  receive + small box + bag sequence. Returns null when any required
 *  input is missing — receiving never guesses. */
export function buildInternalReceiptNumber(input: {
  receiveName?: string | null;
  boxNumber?: number | null;
  bagNumber: number | null | undefined;
}): string | null {
  const rcv =
    typeof input.receiveName === "string" ? input.receiveName.trim() : "";
  if (rcv.length === 0) return null;
  if (input.bagNumber == null || !Number.isFinite(input.bagNumber)) {
    return null;
  }
  const box =
    input.boxNumber != null && Number.isFinite(input.boxNumber)
      ? `-B${input.boxNumber}`
      : "";
  return `${rcv}${box}-${input.bagNumber}`;
}

const INTERNAL_RECEIPT_RE = /^[A-Z0-9][A-Z0-9_-]{1,80}[A-Z0-9]$/i;

/** Validation rule for internal_receipt_number. Accepts the
 *  receive-name + bag-sequence shape (e.g. `PO123-R1-B2-7`) but also
 *  any legacy receipt-pad number the operators already use, as long
 *  as it's alphanumeric / dash / underscore and reasonable length. */
export function validateInternalReceiptNumber(value: unknown): {
  ok: boolean;
  reason?: string;
} {
  if (typeof value !== "string") {
    return { ok: false, reason: "must be a string" };
  }
  const v = value.trim();
  if (v.length < 3) return { ok: false, reason: "too short (min 3 chars)" };
  if (v.length > 82) return { ok: false, reason: "too long (max 82 chars)" };
  if (!INTERNAL_RECEIPT_RE.test(v)) {
    return {
      ok: false,
      reason:
        "must be alphanumeric / dash / underscore and start+end with an alphanumeric",
    };
  }
  return { ok: true };
}

// ─── Supplier lot numbers ─────────────────────────────────────────────

/** Trim + collapse internal whitespace + uppercase. Suppliers are
 *  inconsistent ("ABC-123", " ABC 123 ", "abc_123" — all the same
 *  lot). The receive flow stores this canonical form so recall can
 *  match without false negatives. Returns null for empty input. */
export function normalizeSupplierLotNumber(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\s+/g, " ").toUpperCase();
}

// ─── Raw bag QR codes ─────────────────────────────────────────────────

/** Payload encoded inside the QR symbol printed at receive time. The
 *  string itself (returned by buildRawBagQrPayload) is what
 *  inventory_bags.bag_qr_code stores; the JSON envelope returned by
 *  buildRawBagQrPayloadJson is what the QR encodes when the printer
 *  supports a structured payload. Scanners route by the BAG- prefix. */
export type RawBagQrInput = {
  /** UUID of the inventory_bag this QR is bound to. Required. */
  inventoryBagId: string;
  /** Internal receipt number (post-build). Required. */
  internalReceiptNumber: string;
  /** Supplier lot number (post-normalisation). Optional; may be null
   *  for legacy / unknown intake. */
  supplierLotNumber?: string | null;
  /** Product hint — typically `tabletTypes.name` at intake. Optional. */
  productHint?: string | null;
  /** Bag sequence inside the small box (1, 2, 3…). Required. */
  bagSequence: number;
};

const QR_PREFIX = "BAG-";

/** Build the string value stored in inventory_bags.bag_qr_code. The
 *  prefix lets scanners route between raw-bag QRs and workflow-bag
 *  QR card tokens without a DB lookup. */
export function buildRawBagQrPayload(input: RawBagQrInput): string {
  if (!input.inventoryBagId || input.inventoryBagId.length < 8) {
    throw new Error("inventoryBagId is required");
  }
  if (!input.internalReceiptNumber || input.internalReceiptNumber.length < 3) {
    throw new Error("internalReceiptNumber is required");
  }
  if (!Number.isFinite(input.bagSequence) || input.bagSequence < 1) {
    throw new Error("bagSequence must be >= 1");
  }
  return `${QR_PREFIX}${input.inventoryBagId}`;
}

/** Structured JSON payload for printer drivers that encode richer QR
 *  contents. Receiving may persist this as a snapshot for legacy
 *  archives — but the canonical scanner-readable value remains the
 *  short `BAG-<uuid>` string. */
export type RawBagQrJsonPayload = {
  schema_version: "1.0";
  kind: "RAW_BAG";
  bag_id: string;
  internal_receipt_number: string;
  supplier_lot_number: string | null;
  product_hint: string | null;
  bag_sequence: number;
};

export function buildRawBagQrPayloadJson(
  input: RawBagQrInput,
): RawBagQrJsonPayload {
  // Re-use the short builder for the side-effect of validation.
  buildRawBagQrPayload(input);
  return {
    schema_version: "1.0",
    kind: "RAW_BAG",
    bag_id: input.inventoryBagId,
    internal_receipt_number: input.internalReceiptNumber,
    supplier_lot_number: input.supplierLotNumber ?? null,
    product_hint: input.productHint ?? null,
    bag_sequence: input.bagSequence,
  };
}

/** Convenience: returns both the inventory_bag identity fields the
 *  receive flow needs to persist in one shot. Used by the bridge
 *  layer in LOT-1C / LOT-1D / LOT-1E so the same code path stamps
 *  every new bag the same way. */
export function getRawBagReceiptIdentity(input: {
  inventoryBagId: string;
  receiveName?: string | null;
  boxNumber?: number | null;
  bagNumber: number;
  supplierLotNumber?: string | null;
  productHint?: string | null;
}): {
  bagQrCode: string;
  internalReceiptNumber: string | null;
  supplierLotNumber: string | null;
  qrPayloadJson: RawBagQrJsonPayload | null;
} {
  const internal = buildInternalReceiptNumber({
    receiveName: input.receiveName ?? null,
    boxNumber: input.boxNumber ?? null,
    bagNumber: input.bagNumber,
  });
  const supplier = normalizeSupplierLotNumber(input.supplierLotNumber);
  if (!internal) {
    return {
      bagQrCode: `${QR_PREFIX}${input.inventoryBagId}`,
      internalReceiptNumber: null,
      supplierLotNumber: supplier,
      qrPayloadJson: null,
    };
  }
  const qrInput: RawBagQrInput = {
    inventoryBagId: input.inventoryBagId,
    internalReceiptNumber: internal,
    bagSequence: input.bagNumber,
    ...(supplier !== null ? { supplierLotNumber: supplier } : {}),
    ...(input.productHint != null ? { productHint: input.productHint } : {}),
  };
  return {
    bagQrCode: buildRawBagQrPayload(qrInput),
    internalReceiptNumber: internal,
    supplierLotNumber: supplier,
    qrPayloadJson: buildRawBagQrPayloadJson(qrInput),
  };
}

// ─── Finished lot trace codes ─────────────────────────────────────────

/** Build the customer-facing trace code printed on displays and
 *  master cases. The plan calls for a single code per finished lot
 *  with a stable prefix; here we use the finishedLotNumber as the
 *  body and ensure the FL- prefix is present. */
export type FinishedLotTraceInput = {
  /** finishedLotNumber from the row. Required. */
  finishedLotNumber: string;
  /** Optional check digit / random suffix to make trace codes harder
   *  to guess (recall surface accepts both with and without). */
  suffix?: string | null;
};

const TRACE_PREFIX = "FL-";

export function buildFinishedLotTraceCode(input: FinishedLotTraceInput): string {
  const body = (input.finishedLotNumber ?? "").trim();
  if (body.length === 0) {
    throw new Error("finishedLotNumber is required for trace_code");
  }
  const base = body.startsWith(TRACE_PREFIX) ? body : `${TRACE_PREFIX}${body}`;
  const suffix =
    input.suffix && input.suffix.trim().length > 0
      ? `-${input.suffix.trim()}`
      : "";
  return `${base}${suffix}`;
}

const TRACE_CODE_RE = /^FL-[A-Z0-9][A-Z0-9-]{1,80}[A-Z0-9]$/i;

/** Validation rule for finished_lot.trace_code. Customer-safe:
 *  no whitespace, no slashes, no special characters that could
 *  collide with URL parsing or barcode encoding. Must start with the
 *  FL- prefix. */
export function validateTraceCode(value: unknown): {
  ok: boolean;
  reason?: string;
} {
  if (typeof value !== "string") {
    return { ok: false, reason: "must be a string" };
  }
  const v = value.trim();
  if (v.length < 6) return { ok: false, reason: "too short (min 6 chars)" };
  if (v.length > 84) return { ok: false, reason: "too long (max 84 chars)" };
  if (!v.startsWith(TRACE_PREFIX)) {
    return { ok: false, reason: "must start with FL-" };
  }
  if (!TRACE_CODE_RE.test(v)) {
    return {
      ok: false,
      reason:
        "must be alphanumeric / dash and start+end with an alphanumeric after the FL- prefix",
    };
  }
  return { ok: true };
}

/** Tells the print layer whether a raw supplier_lot_number is safe
 *  to embed in customer-bound payloads. Default: NO. Customer-level
 *  opt-in lives on `customers.supplier_lot_visible`. */
export function shouldExposeSupplierLot(opts: {
  customerSupplierLotVisible?: boolean | null;
}): boolean {
  return opts.customerSupplierLotVisible === true;
}
