// INTAKE-WORKFLOW-1 — pure helpers for the raw-bag intake workflow.
//
// All functions in this module are pure: no DB, no fetch, no clock.
// They power the one-screen intake form's row generation, validation,
// and variance / lookup math. DB writes live in
// lib/db/queries/raw-bag-intake.ts; this module is fully testable
// with fixtures.

import { z } from "zod";

// ─── Bag row generation ─────────────────────────────────────────────────

/** One generated bag row before save. Operator can edit any field. */
export type RawBagRowSeed = {
  bagSequence: number;
  receiptNumber: string;
  bagQrCode: string | null;
  declaredCount: number | null;
  weightGrams: number | null;
  supplierLotNumber: string;
  notes: string | null;
};

/** Pure: distribute total count across bagCount bags as evenly as possible.
 *  Integer-safe: sum of returned values always equals total.
 *  Remainder distributed to the first bags.
 *  Returns empty array when bagCount <= 0 or total <= 0.
 */
export function distributeDeclaredTotal(
  total: number,
  bagCount: number,
): number[] {
  if (bagCount <= 0 || total <= 0) return [];
  const base = Math.floor(total / bagCount);
  const remainder = total % bagCount;
  return Array.from({ length: bagCount }, (_, i) =>
    base + (i < remainder ? 1 : 0),
  );
}

/** Pure: generate N bag-row seeds with ascending receipt numbers.
 *
 * Receipt number strategy:
 *   - If receiptStart is "1001" → "1001", "1002", …
 *   - If receiptStart is "QA-R1001" → "QA-R1001", "QA-R1002", …
 *   - If receiptStart is "R-007" → "R-008", "R-009", … (strips trailing
 *     digits, increments, re-pads to original width)
 *   - If a separate prefix is supplied, it overrides the prefix extracted
 *     from receiptStart.
 *
 * Returns an empty array when count <= 0. Never throws — invalid input
 * returns either empty or carries whatever the operator typed. The
 * validator (validateBagRowSeeds) reports problems.
 */
export function generateBagRowSeed(input: {
  count: number;
  receiptStart: string;
  receiptPrefix?: string | null;
  declaredCount?: number | null;    // broadcast to all rows (backward compat)
  declaredTotal?: number | null;    // distribute evenly across rows (new)
  weightGrams?: number | null;
  supplierLotNumber?: string | null;
}): RawBagRowSeed[] {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return [];
  const parts = splitReceiptStart(input.receiptStart);
  const prefix =
    input.receiptPrefix && input.receiptPrefix.trim().length > 0
      ? input.receiptPrefix.trim()
      : parts.prefix;
  const startNum = parts.number;
  const pad = parts.padding;
  // If declaredTotal is provided, distribute. Otherwise broadcast declaredCount.
  const counts: (number | null)[] = input.declaredTotal != null && count > 0
    ? distributeDeclaredTotal(input.declaredTotal, count)
    : Array(count).fill(input.declaredCount ?? null);
  const wt = input.weightGrams ?? null;
  const lot = input.supplierLotNumber?.trim() ?? "";
  return Array.from({ length: count }, (_, i) => {
    const n = startNum + i;
    const padded = pad > 0 ? String(n).padStart(pad, "0") : String(n);
    return {
      bagSequence: i + 1,
      receiptNumber: `${prefix}${padded}`,
      bagQrCode: null,
      declaredCount: counts[i] ?? null,
      weightGrams: wt,
      supplierLotNumber: lot,
      notes: null,
    };
  });
}

/** Pure: extract the trailing-digit suffix from a receipt-start string.
 *  Returns the prefix (everything before the digit run), the parsed
 *  integer, and the padding width.
 *
 *  Examples:
 *    "1001"        → { prefix: "",      number: 1001, padding: 4 }
 *    "QA-R1001"    → { prefix: "QA-R",  number: 1001, padding: 4 }
 *    "R-007"       → { prefix: "R-",    number: 7,    padding: 3 }
 *    "ABC"         → { prefix: "ABC",   number: 1,    padding: 0 }  (no digits)
 *    ""            → { prefix: "",      number: 1,    padding: 0 }
 */
export function splitReceiptStart(receiptStart: string): {
  prefix: string;
  number: number;
  padding: number;
} {
  const m = receiptStart.trim().match(/^(.*?)(\d+)$/);
  if (!m) return { prefix: receiptStart.trim(), number: 1, padding: 0 };
  const prefix = m[1] ?? "";
  const digitGroup = m[2] ?? "0";
  const n = Number.parseInt(digitGroup, 10);
  return {
    prefix,
    number: Number.isFinite(n) ? n : 1,
    padding: digitGroup.length,
  };
}

// ─── Validation: duplicates + required fields ──────────────────────────

export type RawBagRowValidationIssue = {
  bagSequence: number;
  field: "receiptNumber" | "bagQrCode" | "declaredCount";
  reason:
    | "missing"
    | "duplicate_in_payload"
    | "duplicate_in_db"
    | "must_be_positive";
};

/** Pure: detect duplicate receipt numbers + duplicate QR codes within
 *  the row list. Empty/null QR/receipt aren't compared for duplicates
 *  — caller decides whether to flag missing-required-field separately. */
export function detectDuplicatesInPayload(
  rows: readonly RawBagRowSeed[],
): RawBagRowValidationIssue[] {
  const issues: RawBagRowValidationIssue[] = [];
  const receiptCounts = new Map<string, number[]>();
  const qrCounts = new Map<string, number[]>();
  for (const r of rows) {
    const rec = r.receiptNumber.trim();
    if (rec.length > 0) {
      const arr = receiptCounts.get(rec) ?? [];
      arr.push(r.bagSequence);
      receiptCounts.set(rec, arr);
    }
    const qr = (r.bagQrCode ?? "").trim();
    if (qr.length > 0) {
      const arr = qrCounts.get(qr) ?? [];
      arr.push(r.bagSequence);
      qrCounts.set(qr, arr);
    }
  }
  for (const [, seqs] of receiptCounts) {
    if (seqs.length > 1) {
      for (const seq of seqs) {
        issues.push({
          bagSequence: seq,
          field: "receiptNumber",
          reason: "duplicate_in_payload",
        });
      }
    }
  }
  for (const [, seqs] of qrCounts) {
    if (seqs.length > 1) {
      for (const seq of seqs) {
        issues.push({
          bagSequence: seq,
          field: "bagQrCode",
          reason: "duplicate_in_payload",
        });
      }
    }
  }
  return issues;
}

/** Pure: required-field validation. Missing QR / receipt / declared
 *  count → flagged. Validator never decides "no-QR is ok" — that's a
 *  policy decision the caller makes (e.g. legacy reference). */
export function validateBagRowSeeds(
  rows: readonly RawBagRowSeed[],
  opts: { requireQr?: boolean; requireDeclaredCount?: boolean } = {},
): RawBagRowValidationIssue[] {
  const requireQr = opts.requireQr ?? true;
  const requireDeclared = opts.requireDeclaredCount ?? true;
  const issues: RawBagRowValidationIssue[] = [];
  for (const r of rows) {
    if (r.receiptNumber.trim().length === 0) {
      issues.push({
        bagSequence: r.bagSequence,
        field: "receiptNumber",
        reason: "missing",
      });
    }
    if (requireQr && (!r.bagQrCode || r.bagQrCode.trim().length === 0)) {
      issues.push({
        bagSequence: r.bagSequence,
        field: "bagQrCode",
        reason: "missing",
      });
    }
    if (requireDeclared) {
      if (r.declaredCount == null) {
        issues.push({
          bagSequence: r.bagSequence,
          field: "declaredCount",
          reason: "missing",
        });
      } else if (r.declaredCount <= 0) {
        issues.push({
          bagSequence: r.bagSequence,
          field: "declaredCount",
          reason: "must_be_positive",
        });
      }
    }
  }
  return [...issues, ...detectDuplicatesInPayload(rows)];
}

// ─── Variance ─────────────────────────────────────────────────────────

export type VarianceVerdict = {
  receivedQuantity: number;
  orderedQuantity: number | null;
  variance: number | null;
  status: "EXACT" | "PARTIAL" | "OVER" | "UNKNOWN";
};

/** Pure: sum the declared count across rows + compare to ordered qty.
 *  Returns UNKNOWN when ordered is null (manual fallback PO without
 *  qty). Never throws on null fields. */
export function computeReceivedTotal(rows: readonly RawBagRowSeed[]): number {
  let total = 0;
  for (const r of rows) total += r.declaredCount ?? 0;
  return total;
}

export function computeVariance(input: {
  rows: readonly RawBagRowSeed[];
  orderedQuantity: number | null;
}): VarianceVerdict {
  const receivedQuantity = computeReceivedTotal(input.rows);
  if (input.orderedQuantity == null) {
    return {
      receivedQuantity,
      orderedQuantity: null,
      variance: null,
      status: "UNKNOWN",
    };
  }
  const variance = receivedQuantity - input.orderedQuantity;
  let status: VarianceVerdict["status"];
  if (variance === 0) status = "EXACT";
  else if (variance < 0) status = "PARTIAL";
  else status = "OVER";
  return {
    receivedQuantity,
    orderedQuantity: input.orderedQuantity,
    variance,
    status,
  };
}

// ─── PO verification status ─────────────────────────────────────────────

export type PoVerificationStatus =
  | "VERIFIED_LOCAL"
  | "VERIFIED_ZOHO"
  | "MANUAL_REFERENCE"
  | "MISSING_PRODUCT_MAPPING";

/** Pure: classify the operator's PO selection. The page passes the
 *  resolved local PO row (or null when manual reference), the Zoho
 *  cached PO presence flag, and the product mapping presence. */
export function derivePoVerificationStatus(input: {
  localPoFound: boolean;
  zohoCachedPoFound: boolean;
  productMappingResolved: boolean;
  manualOverride: boolean;
}): PoVerificationStatus {
  if (input.manualOverride) {
    return input.productMappingResolved
      ? "MANUAL_REFERENCE"
      : "MISSING_PRODUCT_MAPPING";
  }
  if (input.localPoFound) {
    return input.productMappingResolved
      ? "VERIFIED_LOCAL"
      : "MISSING_PRODUCT_MAPPING";
  }
  if (input.zohoCachedPoFound) {
    return input.productMappingResolved
      ? "VERIFIED_ZOHO"
      : "MISSING_PRODUCT_MAPPING";
  }
  return "MISSING_PRODUCT_MAPPING";
}

/** Pure: human-readable copy for the verification badge. Used by the
 *  page; tests assert the exact strings so the data-honesty rules
 *  stay enforced. */
export function verificationStatusLabel(status: PoVerificationStatus): string {
  switch (status) {
    case "VERIFIED_LOCAL":
      return "Verified from local Luma PO";
    case "VERIFIED_ZOHO":
      return "Verified from cached Zoho PO";
    case "MANUAL_REFERENCE":
      return "Manual PO reference — not verified against Zoho yet";
    case "MISSING_PRODUCT_MAPPING":
      return "Missing product mapping — review before save";
  }
}

// ─── Zod schema for the save-action payload ─────────────────────────────

export const rawBagIntakeInputSchema = z.object({
  poMode: z.enum(["LOCAL_PO", "ZOHO_CACHED_PO", "MANUAL_REFERENCE"]),
  poId: z.string().uuid().nullable(),
  poLineId: z.string().uuid().nullable(),
  poNumberManual: z.string().trim().max(120).nullable(),
  vendorNameManual: z.string().trim().max(160).nullable(),
  orderedQuantity: z.number().int().nullable(),
  tabletTypeId: z.string().uuid(),
  supplierLotNumber: z.string().trim().min(1).max(80),
  receivedAt: z.string().datetime().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  rows: z
    .array(
      z.object({
        bagSequence: z.number().int().positive(),
        receiptNumber: z.string().trim().min(1).max(120),
        supplierLotNumber: z.string().trim().min(1).max(80),
        bagQrCode: z.string().trim().max(120).nullable().optional(),
        declaredCount: z.number().int().positive().nullable().optional(),
        weightGrams: z.number().int().nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .min(1),
});

export type RawBagIntakeInput = z.infer<typeof rawBagIntakeInputSchema>;

/** Pure: top-level pre-flight validation. Combines: payload-shape
 *  validation (Zod), PO-mode-vs-fields cross-checks, and the row-level
 *  validators above. Returns a result discriminator the action layer
 *  consumes. */
export type RawBagIntakeValidationResult =
  | { ok: true; input: RawBagIntakeInput; issues: readonly RawBagRowValidationIssue[] }
  | { ok: false; error: string; issues: readonly RawBagRowValidationIssue[] };

export function preflightRawBagIntake(
  raw: unknown,
): RawBagIntakeValidationResult {
  const parsed = rawBagIntakeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input shape.",
      issues: [],
    };
  }
  const input = parsed.data;
  if (input.poMode === "MANUAL_REFERENCE") {
    if (!input.poNumberManual)
      return { ok: false, error: "PO number required for manual reference.", issues: [] };
    if (!input.vendorNameManual)
      return { ok: false, error: "Vendor required for manual PO reference.", issues: [] };
  } else {
    if (!input.poId)
      return { ok: false, error: "PO selection required when not using manual reference.", issues: [] };
  }
  const rowSeeds: RawBagRowSeed[] = input.rows.map((r) => ({
    bagSequence: r.bagSequence,
    receiptNumber: r.receiptNumber,
    bagQrCode: r.bagQrCode ?? null,
    declaredCount: r.declaredCount ?? null,
    weightGrams: r.weightGrams ?? null,
    supplierLotNumber: r.supplierLotNumber,
    notes: r.notes ?? null,
  }));
  const issues = validateBagRowSeeds(rowSeeds, {
    requireQr: true,
    requireDeclaredCount: true,
  });
  if (issues.length > 0) {
    return { ok: false, error: "Row validation failed.", issues };
  }
  return { ok: true, input, issues: [] };
}

/** Pure: assign QR codes from a pool to bag rows sequentially.
 *  Pool cards are assigned by index; rows beyond pool.length get null.
 *  Existing bagQrCode values are overwritten.
 */
export function assignQrCodesFromPool(
  rows: RawBagRowSeed[],
  pool: readonly { scanToken: string }[],
): RawBagRowSeed[] {
  return rows.map((row, i) => ({
    ...row,
    bagQrCode: pool[i]?.scanToken ?? null,
  }));
}

// ─── QR token pre-save validation ──────────────────────────────────────

export type QrTokenState =
  | "ok"               // token is in the idle RAW_BAG pool and not duplicated
  | "empty"            // token is blank (field left unfilled)
  | "duplicate_in_form"  // same token appears in another row in this receive
  | "not_in_pool";     // token is non-empty but absent from the idle RAW_BAG pool
                       // (covers: not found, wrong type, retired, already assigned)

/**
 * Pure: classify the QR token on every bag row against the available-pool set
 * and within-form duplicates. No network calls — runs on every render.
 *
 * Duplicate detection takes precedence over pool membership: a duplicated
 * token that happens to be in the pool is still flagged as duplicate_in_form.
 */
export function validateQrTokens(
  rows: readonly { bagSequence: number; bagQrCode?: string | null }[],
  poolSet: ReadonlySet<string>,
): Map<number, QrTokenState> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const token = (r.bagQrCode ?? "").trim();
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const result = new Map<number, QrTokenState>();
  for (const r of rows) {
    const token = (r.bagQrCode ?? "").trim();
    if (!token) {
      result.set(r.bagSequence, "empty");
    } else if ((counts.get(token) ?? 0) > 1) {
      result.set(r.bagSequence, "duplicate_in_form");
    } else if (!poolSet.has(token)) {
      result.set(r.bagSequence, "not_in_pool");
    } else {
      result.set(r.bagSequence, "ok");
    }
  }
  return result;
}

// Statuses that can still accept new raw bag receipts.
// DRAFT/RECEIVED/CLOSED/CANCELLED are excluded.
export const RECEIVABLE_PO_STATUSES = ["OPEN", "RECEIVING"] as const;
export type ReceivablePoStatus = (typeof RECEIVABLE_PO_STATUSES)[number];

// ─── PO line local-receive status ────────────────────────────────────────────
//
// "Local receive status" is distinct from Zoho's line-level receivable status.
// Zoho line status is NOT stored per-line in this schema (only PO-level status
// on purchase_orders). These helpers derive status purely from Luma-local data.

export type PoLineLocalStatus =
  /** No Luma receive exists for this PO line. Operator can receive freely. */
  | "available"
  /** One or more Luma receives already exist for this line. Multiple receives
   *  per line are intentionally supported; this is informational, not blocking. */
  | "received";

export type PoLineReceiveSummary = {
  poLineId: string;
  bagCount: number;
  receiveCount: number;
};

/**
 * Classifies a PO line by its local Luma receive history.
 * Pass `undefined` or a zero-count total → "available".
 */
export function classifyPoLineLocalStatus(
  total: PoLineReceiveSummary | undefined,
): PoLineLocalStatus {
  if (!total || total.receiveCount === 0) return "available";
  return "received";
}

/**
 * Human-readable label for a PO line's local receive status.
 * Used in the Receive Pills line-item cards.
 */
export function poLineLocalStatusLabel(
  status: PoLineLocalStatus,
  total?: PoLineReceiveSummary,
): string {
  if (status === "available") return "Available";
  const bags = total?.bagCount ?? 0;
  const rcvs = total?.receiveCount ?? 0;
  const bagPart = `${bags} bag${bags === 1 ? "" : "s"}`;
  const rcvPart = rcvs > 1 ? ` · ${rcvs} receives` : "";
  return `Received in Luma · ${bagPart}${rcvPart}`;
}
