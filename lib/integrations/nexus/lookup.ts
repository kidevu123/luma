// COMMERCIAL-TRACE-6 — Nexus read-only invoice/batch lookup helpers.
//
// Pure helpers (auth, scope resolution, sanitizers, response builders)
// plus a small set of structured error / response types. DB queries
// live next door in lib/db/queries/nexus-lookups.ts; this module is
// fully pure so the three route handlers can compose freely and tests
// can exercise visibility behavior without spinning up the DB.
//
// Visibility contract enforced via commercialTraceVisibilityPolicy:
//   - customer scope NEVER returns supplier_lot, supplier_lot_number,
//     vendor_lot_number, internal_receipt_number, raw_bag_qr,
//     bag_qr_code, operator_name, employee_id, machine_id,
//     station_id, qc_history. Plus we explicitly strip these on
//     every passport/batch response.
//   - csr / internal scope MAY return all of the above.
//
// Auth contract:
//   - Authorization: Bearer <token>
//   - NEXUS_LOOKUP_TOKEN → customer scope
//   - NEXUS_CSR_LOOKUP_TOKEN → csr scope
//   - if neither env is set → 503 NOT_CONFIGURED
//   - if header missing / malformed → 401
//   - if token doesn't match either configured value → 401
//   - tokens are never logged or echoed; constant-time compare via
//     `safeEqual`.

import { commercialTraceVisibilityPolicy } from "@/lib/production/commercial-trace";

// ─── Env / config ─────────────────────────────────────────────────────

export const NEXUS_LOOKUP_TOKEN_ENV = "NEXUS_LOOKUP_TOKEN";
export const NEXUS_CSR_LOOKUP_TOKEN_ENV = "NEXUS_CSR_LOOKUP_TOKEN";

export type NexusLookupScope = "customer" | "csr";

export type NexusLookupConfigValidation = {
  hasCustomerToken: boolean;
  hasCsrToken: boolean;
  configured: boolean;
  issues: readonly string[];
};

/** Pure: validate which Nexus lookup tokens are configured in env.
 *  At least one must be set or every endpoint returns 503. */
export function validateNexusLookupConfig(
  env: Record<string, string | undefined> = process.env,
): NexusLookupConfigValidation {
  const customer = env[NEXUS_LOOKUP_TOKEN_ENV];
  const csr = env[NEXUS_CSR_LOOKUP_TOKEN_ENV];
  const hasCustomer = isNonBlank(customer);
  const hasCsr = isNonBlank(csr);
  const issues: string[] = [];
  if (!hasCustomer && !hasCsr) {
    issues.push(
      `Neither ${NEXUS_LOOKUP_TOKEN_ENV} nor ${NEXUS_CSR_LOOKUP_TOKEN_ENV} is configured.`,
    );
  }
  return {
    hasCustomerToken: hasCustomer,
    hasCsrToken: hasCsr,
    configured: hasCustomer || hasCsr,
    issues: Object.freeze(issues),
  };
}

// ─── Structured error / result types ──────────────────────────────────

export type NexusLookupError =
  | {
      kind: "NOT_CONFIGURED";
      httpStatus: 503;
      code: "NEXUS_LOOKUP_NOT_CONFIGURED";
      message: string;
    }
  | {
      kind: "UNAUTHORIZED";
      httpStatus: 401;
      code: "UNAUTHORIZED";
      message: string;
    }
  | {
      kind: "INVALID_REQUEST";
      httpStatus: 400;
      code: "INVALID_REQUEST";
      message: string;
    }
  | {
      kind: "NOT_FOUND";
      httpStatus: 404;
      code: "NOT_FOUND";
      message: string;
    }
  | {
      kind: "CUSTOMER_SCOPE_MISMATCH";
      httpStatus: 422;
      code: "CUSTOMER_SCOPE_MISMATCH";
      message: string;
    }
  | {
      kind: "METHOD_NOT_ALLOWED";
      httpStatus: 405;
      code: "METHOD_NOT_ALLOWED";
      message: string;
    }
  | {
      kind: "SERVER_ERROR";
      httpStatus: 500;
      code: "SERVER_ERROR";
      message: string;
    };

export type NexusAuthResult =
  | { ok: true; scope: NexusLookupScope }
  | { ok: false; error: NexusLookupError };

// ─── Auth ─────────────────────────────────────────────────────────────

/** Pure: extract the bearer token from a Headers-like object. Returns
 *  null when the header is missing or malformed. Never throws. */
export function extractBearerToken(
  headers: { get: (name: string) => string | null } | Headers,
): string | null {
  const raw = headers.get("authorization");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Tolerate "Bearer xxx" / "bearer xxx" / "BEARER xxx" with any
  // amount of whitespace between the scheme and the token.
  const match = /^Bearer\s+(\S.*)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1]!.trim();
  return token.length > 0 ? token : null;
}

/** Pure: constant-time string compare. Equal strings → true; unequal
 *  → false. Always walks both strings fully (or the longer of the two)
 *  so timing leaks the *length*, not the content. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** Pure (env stub-able): authenticate a Nexus lookup request. Returns
 *  the resolved scope or a structured error. NEVER includes the token
 *  value in any returned message. */
export function authenticateNexusLookupRequest(
  request: { headers: { get: (name: string) => string | null } | Headers },
  env: Record<string, string | undefined> = process.env,
): NexusAuthResult {
  const cfg = validateNexusLookupConfig(env);
  if (!cfg.configured) {
    return {
      ok: false,
      error: {
        kind: "NOT_CONFIGURED",
        httpStatus: 503,
        code: "NEXUS_LOOKUP_NOT_CONFIGURED",
        message:
          "Nexus lookup tokens are not configured on the Luma server. Contact ops to set NEXUS_LOOKUP_TOKEN and/or NEXUS_CSR_LOOKUP_TOKEN.",
      },
    };
  }

  const token = extractBearerToken(request.headers);
  if (!token) {
    return {
      ok: false,
      error: {
        kind: "UNAUTHORIZED",
        httpStatus: 401,
        code: "UNAUTHORIZED",
        message: "Missing or malformed Authorization: Bearer <token> header.",
      },
    };
  }

  // CSR scope takes precedence — if a token is both customer and CSR
  // tokens (mis-configuration), we treat it as CSR so internal tools
  // don't accidentally get a stripped response. (We also explicitly
  // refuse to log the token, so this preference is invisible.)
  const customer = env[NEXUS_LOOKUP_TOKEN_ENV];
  const csr = env[NEXUS_CSR_LOOKUP_TOKEN_ENV];
  if (isNonBlank(csr) && safeEqual(token, (csr as string).trim())) {
    return { ok: true, scope: "csr" };
  }
  if (isNonBlank(customer) && safeEqual(token, (customer as string).trim())) {
    return { ok: true, scope: "customer" };
  }
  return {
    ok: false,
    error: {
      kind: "UNAUTHORIZED",
      httpStatus: 401,
      code: "UNAUTHORIZED",
      message: "Bearer token did not match a configured Nexus lookup token.",
    },
  };
}

/** Pure: resolve the effective scope. A CSR token MAY request a
 *  reduced customer-scope response via `?scope=customer` so the same
 *  test harness can preview both shapes. A customer token can NEVER
 *  upgrade itself to CSR — that always returns the customer scope. */
export function resolveNexusLookupScope(
  request: { url: string; headers: { get: (name: string) => string | null } | Headers },
  authScope: NexusLookupScope,
): NexusLookupScope {
  const url = safeParseURL(request.url);
  const explicit = url?.searchParams.get("scope")?.toLowerCase();
  if (authScope === "customer") return "customer";
  if (explicit === "customer") return "customer";
  return "csr";
}

function safeParseURL(input: string): URL | null {
  try {
    return new URL(input, "http://internal.local");
  } catch {
    return null;
  }
}

// ─── Public response shapes ───────────────────────────────────────────

export type NexusBatchRow = {
  shipment_finished_lot_id: string | null;
  finished_lot_id: string;
  trace_code: string | null;
  product_name: string | null;
  product_sku: string | null;
  quantity: number | null;
  unit: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  dropdown_label: string;
  confidence: "HIGH";
  warnings: string[];
  /** CSR-only fields. Stripped for customer scope. */
  supplier_lot_number?: string | null;
  internal_receipt_number?: string | null;
  raw_bag_qr?: string | null;
  operator_name?: string | null;
  machine_id?: string | null;
};

export type NexusInvoiceBatchesResponse = {
  schema_version: "1.0";
  source: "LUMA";
  scope: NexusLookupScope;
  invoice: {
    invoice_number: string;
    invoice_date: string | null;
    customer_code: string | null;
    nexus_customer_id: string | null;
  };
  batches: NexusBatchRow[];
  warnings: string[];
};

export type NexusCustomerBatchesResponse = {
  schema_version: "1.0";
  source: "LUMA";
  scope: NexusLookupScope;
  customer: {
    customer_code: string | null;
    nexus_customer_id: string | null;
  };
  filters: {
    product_sku: string | null;
    date_from: string | null;
    date_to: string | null;
    active_only: boolean;
  };
  batches: NexusBatchRow[];
  warnings: string[];
};

export type NexusPassportRow = {
  trace_code: string | null;
  finished_lot_id: string;
  shipment_finished_lot_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  quantity: number | null;
  unit: string | null;
  warnings: string[];
  missing_links: string[];
  /** CSR-only. Empty arrays / nulls for customer scope. */
  supplier_lots?: Array<{ batch_number: string | null; vendor_name: string | null }>;
  raw_bag_receipts?: string[];
  raw_bag_qrs?: string[];
  pos?: Array<{ po_number: string | null; vendor_name: string | null }>;
  operators?: string[];
  machines?: string[];
  qc_events?: Array<{ event_type: string; occurred_at: string }>;
  packaging_lots?: Array<{
    material_name: string | null;
    roll_number: string | null;
    supplier: string | null;
  }>;
};

export type NexusBatchPassportResponse = {
  schema_version: "1.0";
  source: "LUMA";
  scope: NexusLookupScope;
  passport: NexusPassportRow;
};

// ─── Pure builders / sanitizers ───────────────────────────────────────

/** Pure: build the dropdown label used by Nexus customer UIs. Format:
 *    "Mango Peach 30ct — FL-2026-001 — Shipped May 18"
 *  Falls back gracefully when fields are missing. */
export function buildNexusBatchDropdownLabel(batch: {
  product_name?: string | null;
  trace_code?: string | null;
  shipped_at?: string | Date | null;
  packed_at?: string | Date | null;
}): string {
  const parts: string[] = [];
  if (batch.product_name) parts.push(batch.product_name);
  if (batch.trace_code) parts.push(batch.trace_code);
  const shipped = formatShortDate(batch.shipped_at);
  const packed = formatShortDate(batch.packed_at);
  if (shipped) parts.push(`Shipped ${shipped}`);
  else if (packed) parts.push(`Packed ${packed}`);
  return parts.length === 0 ? "Untitled batch" : parts.join(" — ");
}

function formatShortDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

const CSR_ONLY_BATCH_FIELDS = [
  "supplier_lot_number",
  "internal_receipt_number",
  "raw_bag_qr",
  "operator_name",
  "machine_id",
] as const;

/** Pure: strip CSR-only fields from a batch row for customer scope.
 *  Defensive — even if a builder leaks them, the sanitizer drops them. */
export function sanitizeNexusBatchForScope(
  batch: NexusBatchRow,
  scope: NexusLookupScope,
): NexusBatchRow {
  if (scope === "csr") return batch;
  const policy = commercialTraceVisibilityPolicy("customer");
  const clean: NexusBatchRow = {
    shipment_finished_lot_id: batch.shipment_finished_lot_id,
    finished_lot_id: batch.finished_lot_id,
    trace_code: batch.trace_code,
    product_name: batch.product_name,
    product_sku: batch.product_sku,
    quantity: batch.quantity,
    unit: batch.unit,
    packed_at: batch.packed_at,
    shipped_at: batch.shipped_at,
    dropdown_label: batch.dropdown_label,
    confidence: batch.confidence,
    warnings: batch.warnings.slice(),
  };
  // Triple-check the visibility policy agrees the customer-safe fields
  // are allowed (acts as a regression guard if someone changes the
  // CSR-only field list).
  for (const k of ["trace_code", "product_sku", "packed_at", "shipped_at"]) {
    if (!policy.allowField(k)) {
      // If a customer-safe field is ever blocked, redact it rather
      // than crash.
      (clean as unknown as Record<string, unknown>)[k] = null;
    }
  }
  // Strip CSR-only fields if any leaked in.
  for (const k of CSR_ONLY_BATCH_FIELDS) {
    delete (clean as unknown as Record<string, unknown>)[k];
  }
  return clean;
}

const CUSTOMER_SAFE_PASSPORT_KEYS = [
  "trace_code",
  "finished_lot_id",
  "shipment_finished_lot_id",
  "product_name",
  "product_sku",
  "packed_at",
  "shipped_at",
  "quantity",
  "unit",
  "warnings",
  "missing_links",
] as const;

/** Pure: strip CSR-only fields from a passport for customer scope.
 *  Customer scope sees product + trace + dates + quantity + warnings/
 *  missing_links only. */
export function sanitizeNexusPassportForScope(
  passport: NexusPassportRow,
  scope: NexusLookupScope,
): NexusPassportRow {
  if (scope === "csr") return passport;
  const clean: NexusPassportRow = {
    trace_code: passport.trace_code,
    finished_lot_id: passport.finished_lot_id,
    shipment_finished_lot_id: passport.shipment_finished_lot_id,
    product_name: passport.product_name,
    product_sku: passport.product_sku,
    packed_at: passport.packed_at,
    shipped_at: passport.shipped_at,
    quantity: passport.quantity,
    unit: passport.unit,
    warnings: passport.warnings.slice(),
    missing_links: passport.missing_links.slice(),
  };
  // No CSR-only fields appear on the clean shape; the explicit copy
  // above is the customer-safe whitelist.
  void CUSTOMER_SAFE_PASSPORT_KEYS;
  return clean;
}

// ─── Top-level response builders ──────────────────────────────────────

export function buildInvoiceBatchesResponse(input: {
  scope: NexusLookupScope;
  invoice: NexusInvoiceBatchesResponse["invoice"];
  batches: NexusBatchRow[];
  warnings?: string[];
}): NexusInvoiceBatchesResponse {
  return {
    schema_version: "1.0",
    source: "LUMA",
    scope: input.scope,
    invoice: input.invoice,
    batches: input.batches.map((b) =>
      sanitizeNexusBatchForScope(
        { ...b, dropdown_label: b.dropdown_label || buildNexusBatchDropdownLabel(b) },
        input.scope,
      ),
    ),
    warnings: input.warnings ?? [],
  };
}

export function buildCustomerBatchesResponse(input: {
  scope: NexusLookupScope;
  customer: NexusCustomerBatchesResponse["customer"];
  filters: NexusCustomerBatchesResponse["filters"];
  batches: NexusBatchRow[];
  warnings?: string[];
}): NexusCustomerBatchesResponse {
  return {
    schema_version: "1.0",
    source: "LUMA",
    scope: input.scope,
    customer: input.customer,
    filters: input.filters,
    batches: input.batches.map((b) =>
      sanitizeNexusBatchForScope(
        { ...b, dropdown_label: b.dropdown_label || buildNexusBatchDropdownLabel(b) },
        input.scope,
      ),
    ),
    warnings: input.warnings ?? [],
  };
}

export function buildBatchPassportResponse(input: {
  scope: NexusLookupScope;
  passport: NexusPassportRow;
}): NexusBatchPassportResponse {
  return {
    schema_version: "1.0",
    source: "LUMA",
    scope: input.scope,
    passport: sanitizeNexusPassportForScope(input.passport, input.scope),
  };
}

// ─── Tiny helpers ─────────────────────────────────────────────────────

function isNonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
