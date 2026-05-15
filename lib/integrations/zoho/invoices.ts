// COMMERCIAL-TRACE-3 — Zoho invoice dry-run client + normalizer + diff.
//
// Schema-aware read-only path. Mirrors the ZOHO-2A items/customers
// dry-run pattern verbatim:
//   - never writes products / customers / materials / finished lots
//   - never writes zoho_invoices / zoho_invoice_lines (preview-only;
//     candidate-table writes defer to a future COMMERCIAL-TRACE-3B
//     phase, matching how ZOHO-2A defers item upserts to ZOHO-3)
//   - never refreshes Zoho tokens, never calls POST/PUT/PATCH/DELETE
//   - blocks honestly when readiness != READY_FOR_DRY_RUN
//
// Gateway routes audited against /opt/zoho-integration-service on
// LXC 9503 (API_ROUTES.md + app/api/zoho_proxy.py):
//   invoices/list — GET /zoho/invoices/list — Zoho Books, generic
//     proxy through app/api/zoho_proxy.py. Pagination via per_page /
//     page query params, mirrors items/list.
//   invoices/get  — GET /zoho/invoices/get/{id} — returns the full
//     invoice including line_items[] for a single invoice id.
//   Both require headers X-Internal-Token + X-Brand=haute_brands.
//   The gateway has NO bespoke invoice transformer
//   (app/clients/transformers.py only has _transform_books_invoices_create
//   for the unused POST path); GET responses pass through verbatim
//   from Zoho Books.

import {
  buildZohoGatewayHeaders,
  mapZohoGatewayError,
  validateZohoGatewayConfig,
  type ZohoGatewayHealthStatus,
} from "./gateway";
import { extractCollection } from "./items";

export const ZOHO_INVOICES_LIST_PATH = "/zoho/invoices/list";
export const ZOHO_INVOICES_GET_PATH_PREFIX = "/zoho/invoices/get/";

// ─── Normalized model ────────────────────────────────────────────────────

/** Stable shape Luma callers consume for a Zoho invoice header. Mirrors
 *  the COMMERCIAL-TRACE-3 spec field-for-field; Zoho's many variant
 *  field names collapse here. */
export type NormalizedZohoInvoice = {
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  invoiceDate: string | null;
  status: string | null;
  currency: string | null;
  subtotal: number | null;
  total: number | null;
  balance: number | null;
  raw: Record<string, unknown>;
};

/** Stable shape Luma callers consume for a Zoho invoice line. */
export type NormalizedZohoInvoiceLine = {
  zohoInvoiceLineId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  itemName: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  amount: number | null;
  raw: Record<string, unknown>;
};

// ─── Fetch result types ──────────────────────────────────────────────────

export type FetchZohoInvoicesDryRunResult =
  | {
      kind: "OK";
      invoices: readonly NormalizedZohoInvoice[];
      raw: { count: number };
    }
  | { kind: "NOT_CONFIGURED"; message: string }
  | { kind: "UNREACHABLE" | "ERROR"; message: string }
  | { kind: "UNAUTHORIZED"; httpStatus: number; message: string };

export type FetchZohoInvoiceByIdDryRunResult =
  | {
      kind: "OK";
      invoice: NormalizedZohoInvoice;
      lines: readonly NormalizedZohoInvoiceLine[];
    }
  | { kind: "NOT_CONFIGURED"; message: string }
  | { kind: "UNREACHABLE" | "ERROR"; message: string }
  | { kind: "UNAUTHORIZED"; httpStatus: number; message: string }
  | { kind: "NOT_FOUND"; message: string };

type FetchLike = typeof fetch;

// ─── Pure normalizers ────────────────────────────────────────────────────

/** Pure: collapse one Zoho invoice payload into the Luma-normalized
 *  header shape. Accepts the verbatim Zoho Books invoice JSON. Tolerates
 *  partials — anything missing becomes null. Returns null only when
 *  the row has no usable Zoho invoice id (the one required identity
 *  field for idempotent upsert). */
export function normalizeZohoInvoice(input: unknown): NormalizedZohoInvoice | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const zohoInvoiceId =
    pickString(row, "invoice_id") ??
    pickString(row, "invoiceId");
  if (!zohoInvoiceId) return null;
  return {
    zohoInvoiceId,
    invoiceNumber:
      pickString(row, "invoice_number") ??
      pickString(row, "invoiceNumber") ??
      pickString(row, "number"),
    zohoCustomerId:
      pickString(row, "customer_id") ?? pickString(row, "customerId"),
    customerName:
      pickString(row, "customer_name") ?? pickString(row, "customerName"),
    invoiceDate:
      pickString(row, "date") ??
      pickString(row, "invoice_date") ??
      pickString(row, "invoiceDate"),
    status: pickString(row, "status"),
    currency:
      pickString(row, "currency_code") ?? pickString(row, "currencyCode"),
    subtotal: pickNumber(row, "sub_total") ?? pickNumber(row, "subtotal"),
    total: pickNumber(row, "total"),
    balance: pickNumber(row, "balance"),
    raw: row,
  };
}

/** Pure: collapse one Zoho invoice line payload into the Luma-normalized
 *  line shape. Returns null only if the row has neither an item id nor
 *  a name (i.e. absolutely no identity to surface). */
export function normalizeZohoInvoiceLine(
  input: unknown,
): NormalizedZohoInvoiceLine | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const itemName =
    pickString(row, "name") ??
    pickString(row, "item_name") ??
    pickString(row, "itemName");
  const zohoItemId =
    pickString(row, "item_id") ?? pickString(row, "itemId");
  if (!itemName && !zohoItemId) return null;
  return {
    zohoInvoiceLineId:
      pickString(row, "line_item_id") ??
      pickString(row, "lineItemId") ??
      pickString(row, "id"),
    zohoItemId,
    sku: pickString(row, "sku"),
    itemName: itemName ?? "(unnamed line)",
    description: pickString(row, "description"),
    quantity:
      pickNumber(row, "quantity") ?? pickNumber(row, "qty"),
    unit: pickString(row, "unit"),
    rate: pickNumber(row, "rate"),
    amount: pickNumber(row, "item_total") ?? pickNumber(row, "amount"),
    raw: row,
  };
}

// ─── Live fetchers ────────────────────────────────────────────────────────

/** Live: fetch one page of Zoho invoices via the gateway. Headers
 *  built by buildZohoGatewayHeaders (X-Internal-Token + X-Brand). Never
 *  throws for transport errors; returns a discriminated result. */
export async function fetchZohoInvoicesDryRun(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  path?: string;
  perPage?: number;
  page?: number;
  /** Optional date filter passed through to the gateway. Zoho Books
   *  accepts `date_start` / `date_end` (YYYY-MM-DD). Not required for
   *  the COMMERCIAL-TRACE-3 dry-run; reserved for future scoped runs. */
  dateStart?: string;
  dateEnd?: string;
}): Promise<FetchZohoInvoicesDryRunResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return { kind: "NOT_CONFIGURED", message: cfg.issues[0] ?? "Gateway not configured." };
  }
  const headers = buildZohoGatewayHeaders(env);
  const params = new URLSearchParams();
  params.set("per_page", String(opts?.perPage ?? 200));
  params.set("page", String(opts?.page ?? 1));
  if (opts?.dateStart) params.set("date_start", opts.dateStart);
  if (opts?.dateEnd) params.set("date_end", opts.dateEnd);
  const url = `${cfg.url}${opts?.path ?? ZOHO_INVOICES_LIST_PATH}?${params.toString()}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
    clearTimeout(tid);
    if (r.status === 401 || r.status === 403) {
      return {
        kind: "UNAUTHORIZED",
        httpStatus: r.status,
        message: `Gateway rejected request with HTTP ${r.status}.`,
      };
    }
    if (r.status < 200 || r.status >= 300) {
      return {
        kind: "ERROR",
        message: `Gateway returned HTTP ${r.status} on /zoho/invoices/list.`,
      };
    }
    const body = (await r.json().catch(() => null)) as unknown;
    const rows = extractCollection(body, "invoices");
    const invoices = rows
      .map((row) => normalizeZohoInvoice(row))
      .filter((x): x is NormalizedZohoInvoice => x != null);
    return { kind: "OK", invoices, raw: { count: rows.length } };
  } catch (err) {
    clearTimeout(tid);
    const mapped = mapZohoInvoiceGatewayError({ thrown: err });
    return {
      kind: mapped.status === "UNREACHABLE" ? "UNREACHABLE" : "ERROR",
      message: mapped.message,
    };
  }
}

/** Live: fetch a single Zoho invoice + its line items by Zoho invoice
 *  id. Used to backfill `lines[]` for invoices the list endpoint
 *  returns without them. Read-only. */
export async function fetchZohoInvoiceByNumberDryRun(opts: {
  zohoInvoiceId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<FetchZohoInvoiceByIdDryRunResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  if (!opts.zohoInvoiceId || opts.zohoInvoiceId.trim().length === 0) {
    return { kind: "ERROR", message: "Empty zoho_invoice_id." };
  }
  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return { kind: "NOT_CONFIGURED", message: cfg.issues[0] ?? "Gateway not configured." };
  }
  const headers = buildZohoGatewayHeaders(env);
  const url = `${cfg.url}${ZOHO_INVOICES_GET_PATH_PREFIX}${encodeURIComponent(opts.zohoInvoiceId.trim())}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
    clearTimeout(tid);
    if (r.status === 401 || r.status === 403) {
      return {
        kind: "UNAUTHORIZED",
        httpStatus: r.status,
        message: `Gateway rejected request with HTTP ${r.status}.`,
      };
    }
    if (r.status === 404) {
      return { kind: "NOT_FOUND", message: `Zoho invoice ${opts.zohoInvoiceId} not found.` };
    }
    if (r.status < 200 || r.status >= 300) {
      return {
        kind: "ERROR",
        message: `Gateway returned HTTP ${r.status} on /zoho/invoices/get.`,
      };
    }
    const body = (await r.json().catch(() => null)) as unknown;
    const invoiceRaw = unwrapInvoiceDetail(body);
    const invoice = normalizeZohoInvoice(invoiceRaw);
    if (!invoice) {
      return { kind: "ERROR", message: "Invoice response missing invoice_id." };
    }
    const linesRaw = Array.isArray(
      (invoiceRaw as Record<string, unknown>).line_items,
    )
      ? ((invoiceRaw as Record<string, unknown>).line_items as unknown[])
      : [];
    const lines = linesRaw
      .map((row) => normalizeZohoInvoiceLine(row))
      .filter((x): x is NormalizedZohoInvoiceLine => x != null);
    return { kind: "OK", invoice, lines };
  } catch (err) {
    clearTimeout(tid);
    const mapped = mapZohoInvoiceGatewayError({ thrown: err });
    return {
      kind: mapped.status === "UNREACHABLE" ? "UNREACHABLE" : "ERROR",
      message: mapped.message,
    };
  }
}

/** Pure: tolerate `{ invoice: {...} }` or `{ data: {...} }` or a bare
 *  invoice object. Mirrors Zoho's wrapping. */
function unwrapInvoiceDetail(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const obj = body as Record<string, unknown>;
  if (obj.invoice && typeof obj.invoice === "object") return obj.invoice;
  if (obj.data && typeof obj.data === "object") return obj.data;
  return obj;
}

// ─── Diff / preview ──────────────────────────────────────────────────────

export type InvoiceDryRunAction =
  | "CREATE_CANDIDATE"
  | "UPDATE_CANDIDATE"
  | "NO_CHANGE"
  | "NEEDS_REVIEW"
  | "CONFLICT";

export type InvoiceDryRunReason =
  | "missing_invoice_number"
  | "missing_zoho_invoice_id"
  | "duplicate_invoice_number_in_zoho"
  | "duplicate_zoho_invoice_id_in_zoho"
  | "invoice_number_collides_in_luma"
  | "missing_zoho_customer_id"
  | "customer_not_mapped_to_luma"
  | "invoice_has_no_lines"
  | "local_invoice_already_exists"
  | "local_invoice_changed_since_last_sync"
  | "line_missing_item_id"
  | "line_missing_sku"
  | "line_missing_quantity"
  | "line_quantity_invalid";

export type InvoiceLinePreviewRow = {
  action: InvoiceDryRunAction;
  reasons: readonly InvoiceDryRunReason[];
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  zohoInvoiceLineId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  itemName: string;
  quantity: number | null;
};

export type InvoiceHeaderPreviewRow = {
  action: InvoiceDryRunAction;
  reasons: readonly InvoiceDryRunReason[];
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  customerMatchedLumaId: string | null;
  matchedLumaInvoiceId: string | null;
  lineCount: number;
};

export type InvoiceDryRunCounts = {
  invoicesScanned: number;
  linesScanned: number;
  createCandidates: number;
  updateCandidates: number;
  noChange: number;
  needsReview: number;
  conflicts: number;
};

/** Luma-side snapshot the diff engine reads. Tests stub it directly;
 *  the action loads from the real DB. */
export type LumaInvoiceSnapshot = {
  customers: ReadonlyArray<{
    id: string;
    customerCode: string;
    name: string;
    zohoCustomerId: string | null;
  }>;
  invoices: ReadonlyArray<{
    id: string;
    zohoInvoiceId: string;
    invoiceNumber: string;
    lastSyncedAt: Date | null;
  }>;
};

/** Pure: diff a list of normalized Zoho invoices + their line-arrays
 *  against the current Luma snapshot. Never mutates either side.
 *  Idempotent. Returns header rows + line rows + warnings. */
export function deriveZohoInvoiceDiff(input: {
  invoices: ReadonlyArray<{
    invoice: NormalizedZohoInvoice;
    lines: readonly NormalizedZohoInvoiceLine[];
  }>;
  luma: LumaInvoiceSnapshot;
}): {
  headers: InvoiceHeaderPreviewRow[];
  lines: InvoiceLinePreviewRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const headers: InvoiceHeaderPreviewRow[] = [];
  const lines: InvoiceLinePreviewRow[] = [];

  // Indexes.
  const lumaCustomersByZohoId = new Map<
    string,
    { id: string; name: string }
  >();
  for (const c of input.luma.customers) {
    if (c.zohoCustomerId) {
      lumaCustomersByZohoId.set(c.zohoCustomerId, { id: c.id, name: c.name });
    }
  }
  const lumaInvoicesByZohoId = new Map<string, { id: string; lastSyncedAt: Date | null }>();
  const lumaInvoicesByNumber = new Map<string, { id: string; zohoInvoiceId: string }>();
  for (const i of input.luma.invoices) {
    lumaInvoicesByZohoId.set(i.zohoInvoiceId, { id: i.id, lastSyncedAt: i.lastSyncedAt });
    if (i.invoiceNumber) {
      lumaInvoicesByNumber.set(
        i.invoiceNumber.trim().toUpperCase(),
        { id: i.id, zohoInvoiceId: i.zohoInvoiceId },
      );
    }
  }

  // Zoho-side duplicate detection. invoice_id MUST be unique in Zoho;
  // invoice_number can collide via voids/replacements but should be
  // flagged.
  const zohoIdCounts = new Map<string, number>();
  const zohoNumberCounts = new Map<string, number>();
  for (const entry of input.invoices) {
    const id = entry.invoice.zohoInvoiceId;
    zohoIdCounts.set(id, (zohoIdCounts.get(id) ?? 0) + 1);
    const num = entry.invoice.invoiceNumber;
    if (num) {
      const k = num.trim().toUpperCase();
      zohoNumberCounts.set(k, (zohoNumberCounts.get(k) ?? 0) + 1);
    }
  }

  for (const entry of input.invoices) {
    const z = entry.invoice;
    const reasons: InvoiceDryRunReason[] = [];
    let action: InvoiceDryRunAction = "CREATE_CANDIDATE";

    // Zoho-side identity.
    if ((zohoIdCounts.get(z.zohoInvoiceId) ?? 0) > 1) {
      reasons.push("duplicate_zoho_invoice_id_in_zoho");
      action = "CONFLICT";
    }
    if (
      z.invoiceNumber &&
      (zohoNumberCounts.get(z.invoiceNumber.trim().toUpperCase()) ?? 0) > 1
    ) {
      reasons.push("duplicate_invoice_number_in_zoho");
      action = "CONFLICT";
    }
    if (!z.invoiceNumber) {
      reasons.push("missing_invoice_number");
      action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
    }

    // Cross-system identity collisions.
    const numUpper = z.invoiceNumber?.trim().toUpperCase() ?? null;
    const lumaByZoho = lumaInvoicesByZohoId.get(z.zohoInvoiceId) ?? null;
    const lumaByNumber = numUpper ? lumaInvoicesByNumber.get(numUpper) ?? null : null;
    if (
      lumaByNumber &&
      lumaByZoho == null &&
      lumaByNumber.zohoInvoiceId !== z.zohoInvoiceId
    ) {
      reasons.push("invoice_number_collides_in_luma");
      action = "CONFLICT";
    }

    // Customer mapping.
    let customerMatchedLumaId: string | null = null;
    if (!z.zohoCustomerId) {
      reasons.push("missing_zoho_customer_id");
      action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
    } else {
      const matched = lumaCustomersByZohoId.get(z.zohoCustomerId);
      if (matched) {
        customerMatchedLumaId = matched.id;
      } else {
        reasons.push("customer_not_mapped_to_luma");
        action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
    }

    // Local existence.
    if (lumaByZoho) {
      // Either NO_CHANGE or UPDATE_CANDIDATE. We don't yet diff field
      // values because dry-run does not write the candidate row; the
      // sole signal we expose today is "exists locally". COMMERCIAL-
      // TRACE-3B will compare source_hash.
      reasons.push("local_invoice_already_exists");
      action = action === "CONFLICT" ? "CONFLICT" : "NO_CHANGE";
    }

    // Line-level signals — bubble worst case up to the header.
    if (entry.lines.length === 0) {
      reasons.push("invoice_has_no_lines");
      action = action === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
    }

    let worstLineAction: InvoiceDryRunAction = action;
    for (const ln of entry.lines) {
      const lineReasons: InvoiceDryRunReason[] = [];
      let lineAction: InvoiceDryRunAction = action;
      if (!ln.zohoItemId) {
        lineReasons.push("line_missing_item_id");
        lineAction = lineAction === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }
      if (!ln.sku) {
        lineReasons.push("line_missing_sku");
        if (lineAction === "CREATE_CANDIDATE") lineAction = "NEEDS_REVIEW";
      }
      if (ln.quantity == null) {
        lineReasons.push("line_missing_quantity");
        lineAction = lineAction === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      } else if (
        !Number.isFinite(ln.quantity) ||
        ln.quantity <= 0
      ) {
        lineReasons.push("line_quantity_invalid");
        lineAction = lineAction === "CONFLICT" ? "CONFLICT" : "NEEDS_REVIEW";
      }

      if (
        lineAction === "NEEDS_REVIEW" &&
        worstLineAction === "CREATE_CANDIDATE"
      ) {
        worstLineAction = "NEEDS_REVIEW";
      }
      if (lineAction === "CONFLICT") worstLineAction = "CONFLICT";

      lines.push({
        action: lineAction,
        reasons: Object.freeze(lineReasons),
        zohoInvoiceId: z.zohoInvoiceId,
        invoiceNumber: z.invoiceNumber,
        zohoInvoiceLineId: ln.zohoInvoiceLineId,
        zohoItemId: ln.zohoItemId,
        sku: ln.sku,
        itemName: ln.itemName,
        quantity: ln.quantity,
      });
    }

    if (action === "CREATE_CANDIDATE" && worstLineAction === "NEEDS_REVIEW") {
      action = "NEEDS_REVIEW";
    }
    if (worstLineAction === "CONFLICT") action = "CONFLICT";

    headers.push({
      action,
      reasons: Object.freeze(reasons),
      zohoInvoiceId: z.zohoInvoiceId,
      invoiceNumber: z.invoiceNumber,
      zohoCustomerId: z.zohoCustomerId,
      customerName: z.customerName,
      customerMatchedLumaId,
      matchedLumaInvoiceId: lumaByZoho?.id ?? null,
      lineCount: entry.lines.length,
    });
  }

  // Warnings — surface anything an operator needs to see at a glance.
  for (const [num, count] of zohoNumberCounts) {
    if (count > 1) {
      warnings.push(`Zoho returned ${count} invoices sharing number "${num}".`);
    }
  }
  const orphanCount = headers.filter((h) =>
    h.reasons.includes("customer_not_mapped_to_luma"),
  ).length;
  if (orphanCount > 0) {
    warnings.push(
      `${orphanCount} invoice${orphanCount === 1 ? "" : "s"} reference a Zoho customer not yet mapped to a Luma customer.`,
    );
  }

  return { headers, lines, warnings };
}

/** Pure: roll up header + line counts. */
export function summarizeZohoInvoiceDryRun(input: {
  headers: ReadonlyArray<{ action: InvoiceDryRunAction }>;
  lines: ReadonlyArray<{ action: InvoiceDryRunAction }>;
}): InvoiceDryRunCounts {
  let createCandidates = 0;
  let updateCandidates = 0;
  let noChange = 0;
  let needsReview = 0;
  let conflicts = 0;
  for (const h of input.headers) {
    switch (h.action) {
      case "CREATE_CANDIDATE":
        createCandidates++;
        break;
      case "UPDATE_CANDIDATE":
        updateCandidates++;
        break;
      case "NO_CHANGE":
        noChange++;
        break;
      case "NEEDS_REVIEW":
        needsReview++;
        break;
      case "CONFLICT":
        conflicts++;
        break;
    }
  }
  return {
    invoicesScanned: input.headers.length,
    linesScanned: input.lines.length,
    createCandidates,
    updateCandidates,
    noChange,
    needsReview,
    conflicts,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────

import {
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  fetchZohoBrandStatus,
  type ZohoReadiness,
} from "./gateway";
import { readinessBlockedMessage } from "./sync-dry-run";

export type InvoiceDryRunResult =
  | {
      kind: "BLOCKED";
      readiness: ZohoReadiness;
      reason: string;
      runId: string | null;
    }
  | {
      kind: "OK";
      readiness: ZohoReadiness;
      runId: string;
      counts: InvoiceDryRunCounts;
      headers: readonly InvoiceHeaderPreviewRow[];
      lines: readonly InvoiceLinePreviewRow[];
      warnings: readonly string[];
    }
  | {
      kind: "ERROR";
      readiness: ZohoReadiness;
      message: string;
    };

export type InvoicePersistRunInput = {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  source: string;
  summary: Record<string, unknown>;
  error: string | null;
  actorUserId: string | null;
};

export type RunZohoInvoiceDryRunOpts = {
  loadLumaSnapshot?: () => Promise<LumaInvoiceSnapshot>;
  fetchInvoices?: typeof fetchZohoInvoicesDryRun;
  fetchInvoiceById?: typeof fetchZohoInvoiceByNumberDryRun;
  /** Override readiness probes (test seam). */
  probeReadiness?: () => Promise<ZohoReadiness>;
  /** Override the audit-row persister (test seam). */
  persistRun?: (input: InvoicePersistRunInput) => Promise<string>;
  actorUserId?: string | null;
  source?: string;
  /** Hard cap on per-invoice detail fetches per run. The list endpoint
   *  may return invoices without `line_items[]`; we backfill via
   *  /invoices/get up to this many. */
  maxDetailFetches?: number;
};

/** Orchestrator. Probes readiness; if not READY, writes one PARTIAL
 *  INVOICES audit row and returns BLOCKED — never calls the invoice
 *  endpoint. If READY, fetches the invoice list (and, when needed, the
 *  per-invoice detail for line items), normalizes, diffs against the
 *  current Luma snapshot, writes one INVOICES audit row with
 *  dry_run=true, and returns the preview. Never writes zoho_invoices /
 *  zoho_invoice_lines / finished_lot_invoice_allocations / customers /
 *  products / shipment_finished_lots. Never calls Nexus. */
export async function runZohoInvoiceDryRun(
  opts: RunZohoInvoiceDryRunOpts = {},
): Promise<InvoiceDryRunResult> {
  const probeReadiness =
    opts.probeReadiness ??
    (async () => {
      const health = await checkZohoGatewayHealth();
      const brand =
        health.status === "CONNECTED" ? await fetchZohoBrandStatus() : null;
      return deriveZohoReadiness({ health, brand }).readiness;
    });
  const persistRun = opts.persistRun ?? defaultPersistInvoiceRun;
  const source = opts.source ?? "manual";
  const actorUserId = opts.actorUserId ?? null;
  const maxDetail = opts.maxDetailFetches ?? 25;

  const readiness = await probeReadiness();

  if (readiness !== "READY_FOR_DRY_RUN") {
    const reason = readinessBlockedMessage(readiness);
    const runId = await persistRun({
      status: "PARTIAL",
      source,
      summary: {
        readiness,
        blocked: true,
        message: reason,
        note: "COMMERCIAL-TRACE-3 invoice dry-run blocked. No /invoices/list or /invoices/get call attempted.",
      },
      error: reason,
      actorUserId,
    });
    return { kind: "BLOCKED", readiness, reason, runId };
  }

  // Ready — fetch + diff.
  const fetchInvoices = opts.fetchInvoices ?? fetchZohoInvoicesDryRun;
  const fetchInvoiceById = opts.fetchInvoiceById ?? fetchZohoInvoiceByNumberDryRun;
  const loadLumaSnapshot = opts.loadLumaSnapshot ?? defaultLoadLumaInvoiceSnapshot;

  const [listResp, luma] = await Promise.all([
    fetchInvoices(),
    loadLumaSnapshot(),
  ]);

  if (listResp.kind !== "OK") {
    return {
      kind: "ERROR",
      readiness,
      message:
        listResp.kind === "UNAUTHORIZED"
          ? listResp.message
          : "message" in listResp
            ? (listResp as { message: string }).message
            : "Unknown gateway response.",
    };
  }

  // Some invoices arrive with `line_items` already populated in the
  // list response; for the rest, backfill via /invoices/get up to
  // maxDetail. Beyond the cap, we keep `lines: []` (the header row
  // will flag invoice_has_no_lines).
  const entries: Array<{
    invoice: NormalizedZohoInvoice;
    lines: NormalizedZohoInvoiceLine[];
  }> = [];
  let detailFetchesUsed = 0;
  for (const invoice of listResp.invoices) {
    const inlineRaw = (invoice.raw as { line_items?: unknown[] }).line_items;
    const inline = Array.isArray(inlineRaw)
      ? inlineRaw
          .map((row) => normalizeZohoInvoiceLine(row))
          .filter((x): x is NormalizedZohoInvoiceLine => x != null)
      : null;
    if (inline && inline.length > 0) {
      entries.push({ invoice, lines: inline });
      continue;
    }
    if (detailFetchesUsed >= maxDetail) {
      entries.push({ invoice, lines: [] });
      continue;
    }
    const detail = await fetchInvoiceById({ zohoInvoiceId: invoice.zohoInvoiceId });
    detailFetchesUsed++;
    if (detail.kind === "OK") {
      entries.push({ invoice: detail.invoice, lines: [...detail.lines] });
    } else {
      entries.push({ invoice, lines: [] });
    }
  }

  const diff = deriveZohoInvoiceDiff({ invoices: entries, luma });
  const counts = summarizeZohoInvoiceDryRun({
    headers: diff.headers,
    lines: diff.lines,
  });

  const runId = await persistRun({
    status: counts.conflicts > 0 ? "PARTIAL" : "SUCCESS",
    source,
    summary: {
      readiness,
      blocked: false,
      counts,
      warnings: diff.warnings,
      headerPreview: diff.headers.slice(0, 50),
      linePreview: diff.lines.slice(0, 100),
      detailFetchesUsed,
    },
    error: counts.conflicts > 0 ? `${counts.conflicts} invoice conflict(s) need review.` : null,
    actorUserId,
  });

  return {
    kind: "OK",
    readiness,
    runId,
    counts,
    headers: diff.headers,
    lines: diff.lines,
    warnings: diff.warnings,
  };
}

// ─── Defaults that talk to the real DB ───────────────────────────────────

async function defaultLoadLumaInvoiceSnapshot(): Promise<LumaInvoiceSnapshot> {
  const { db } = await import("@/lib/db");
  const { customers, zohoInvoices } = await import("@/lib/db/schema");
  const [c, i] = await Promise.all([
    db
      .select({
        id: customers.id,
        customerCode: customers.customerCode,
        name: customers.name,
        zohoCustomerId: customers.zohoCustomerId,
      })
      .from(customers),
    db
      .select({
        id: zohoInvoices.id,
        zohoInvoiceId: zohoInvoices.zohoInvoiceId,
        invoiceNumber: zohoInvoices.invoiceNumber,
        lastSyncedAt: zohoInvoices.lastSyncedAt,
      })
      .from(zohoInvoices),
  ]);
  return { customers: c, invoices: i };
}

async function defaultPersistInvoiceRun(
  input: InvoicePersistRunInput,
): Promise<string> {
  const { db } = await import("@/lib/db");
  const { zohoSyncRuns } = await import("@/lib/db/schema");
  const inserted = await db
    .insert(zohoSyncRuns)
    .values({
      syncType: "INVOICES",
      status: input.status,
      finishedAt: new Date(),
      source: input.source,
      dryRun: true,
      summary: input.summary,
      error: input.error,
      createdByUserId: input.actorUserId,
    })
    .returning({ id: zohoSyncRuns.id });
  return inserted[0]?.id ?? "";
}

// ─── Error mapper ────────────────────────────────────────────────────────

/** Pure: re-export of the gateway error mapper, scoped to invoice-side
 *  error messages. Distinct symbol so callers can stub one without
 *  affecting items/customers. */
export function mapZohoInvoiceGatewayError(input: {
  thrown?: unknown;
  httpStatus?: number | null;
}): { status: ZohoGatewayHealthStatus; message: string } {
  return mapZohoGatewayError(input);
}

// ─── Tiny pure helpers ───────────────────────────────────────────────────

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

function pickNumber(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
