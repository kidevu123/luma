// ZOHO-INV-CLIENT — Thin HTTP client for Zoho Integration Service read endpoints.
// Covers: /zoho/purchaseorders_inv/list, /zoho/purchaseorders_inv/get/:id,
//         /zoho/items/search, /zoho/warehouses/list.
//
// Auth model (same as assembly client):
//   Authorization: Bearer ${ZOHO_SERVICE_BEARER_SECRET}
//   X-Brand:       ${ZOHO_BRAND}
//
// No Idempotency-Key, no Content-Type — these are read-only GET endpoints.
// No dry-run guard — reads are always safe.
//
// Config re-uses validateAssemblyServiceConfig from assembly-service-client.
// Never log the bearer secret. Use redactInventoryServiceHeaders for safe logging.

import { validateAssemblyServiceConfig } from "./assembly-service-client";

// ─── Domain types ─────────────────────────────────────────────────────────────

/** PO summary from GET /zoho/purchaseorders_inv/list */
export type ZohoPurchaseOrderSummary = {
  purchaseorder_id: string;
  purchaseorder_number: string;
  vendor_name: string;
  status: string; // "issued" | "received" | "partially_received" | "draft" | "cancelled"
  date: string;   // ISO date string e.g. "2026-05-20"
  total: number;
  received_status: string; // "to_be_received" | "received" | "partially_received"
  quantity_yet_to_receive: number;
  app_flags?: ZohoLumaAppFlags;
};

/** Line item within a PO detail response */
export type ZohoPoLineItem = {
  line_item_id: string;
  item_id: string;
  name: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_remaining: number;
  unit: string;
  status: string; // "received" | "to_be_received" | "partially_received" | "not_receivable"
};

/** PO detail from GET /zoho/purchaseorders_inv/get/:id */
export type ZohoPurchaseOrderDetail = {
  purchaseorder_id: string;
  purchaseorder_number: string;
  vendor_name: string;
  status: string;
  date: string;
  received_status: string;
  line_items: ZohoPoLineItem[];
  app_flags?: ZohoLumaAppFlags;
};

/** Item from GET /zoho/items/search */
export type ZohoItemSummary = {
  item_id: string;
  name: string;
  sku: string;
  status: string;        // "active" | "inactive"
  item_type: string;     // "inventory" | "service" | "non_inventory"
  is_combo_product: boolean;
};

/** Warehouse from GET /zoho/warehouses/list */
export type ZohoWarehouse = {
  warehouse_id: string;
  warehouse_name: string;
};

/** Meta block present on every response */
export type ZohoResponseMeta = {
  request_id: string;
  brand: string;
  service: string;
  action: string;
  page?: number;
  per_page?: number;
  has_more?: boolean;
};

/** Normalized Luma-specific flags injected by Zoho Integration Service. */
export type ZohoLumaAppFlags = {
  luma?: {
    is_tablet_po?: boolean;
  };
};

/**
 * Pure: return true iff app_flags.luma.is_tablet_po === true.
 * Treats missing/null/false as not eligible for raw bag intake.
 */
export function extractIsTabletPo(po: { app_flags?: ZohoLumaAppFlags }): boolean {
  return po.app_flags?.luma?.is_tablet_po === true;
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class ZohoInventoryServiceError extends Error {
  constructor(
    public readonly httpStatus: number | null,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ZohoInventoryServiceError";
  }
}

// ─── Result type ──────────────────────────────────────────────────────────────

export type InventoryServiceReadResult<T> =
  | { ok: true; data: T; meta: ZohoResponseMeta }
  | { ok: false; httpStatus: number | null; body: unknown; message: string };

// ─── Header builder ───────────────────────────────────────────────────────────

/**
 * Pure: build GET request headers for inventory read endpoints.
 * No Idempotency-Key and no Content-Type — reads only.
 * NEVER log the returned object verbatim — use redactInventoryServiceHeaders.
 */
export function buildInventoryServiceHeaders(opts: {
  bearerSecret: string;
  brand: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.bearerSecret}`,
    "X-Brand": opts.brand,
    Accept: "application/json",
  };
}

/**
 * Pure: return a copy of the headers object with the Authorization value
 * replaced by "Bearer [REDACTED]". Safe to pass to loggers.
 */
export function redactInventoryServiceHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "authorization") {
      out[key] = "Bearer [REDACTED]";
    }
  }
  return out;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** Parse response body as JSON; fall back to text on parse failure. */
async function parseResponseBody(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    try {
      return await r.text();
    } catch {
      return null;
    }
  }
}

/** Type guard: value is a plain object (not null, not array). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Type guard: value is an array. */
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * Extract the `meta` block from a raw response body.
 * Returns a ZohoResponseMeta if the shape is present, otherwise a stub.
 */
function extractMeta(body: unknown): ZohoResponseMeta {
  if (!isObject(body)) {
    return { request_id: "", brand: "", service: "", action: "" };
  }
  const m = body["meta"];
  if (!isObject(m)) {
    return { request_id: "", brand: "", service: "", action: "" };
  }
  const meta: ZohoResponseMeta = {
    request_id: typeof m["request_id"] === "string" ? m["request_id"] : "",
    brand: typeof m["brand"] === "string" ? m["brand"] : "",
    service: typeof m["service"] === "string" ? m["service"] : "",
    action: typeof m["action"] === "string" ? m["action"] : "",
  };
  if (typeof m["page"] === "number") meta.page = m["page"];
  if (typeof m["per_page"] === "number") meta.per_page = m["per_page"];
  if (typeof m["has_more"] === "boolean") meta.has_more = m["has_more"];
  return meta;
}

/**
 * Core GET dispatcher. Validates config, builds headers, executes fetch
 * with timeout, parses body, and returns the raw parsed body + meta on 2xx.
 */
async function getInventoryEndpoint(opts: {
  path: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<InventoryServiceReadResult<unknown>> {
  // Step 1: validate config
  const config = validateAssemblyServiceConfig(opts.env);
  if (!config.ok) {
    return { ok: false, httpStatus: null, body: null, message: config.reason };
  }

  // Step 2: build headers
  const headers = buildInventoryServiceHeaders({
    bearerSecret: config.bearerSecret,
    brand: config.brand,
  });

  // Step 3: GET with timeout
  const url = `${config.baseUrl}${opts.path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), opts.timeoutMs);

  let r: Response;
  try {
    r = await opts.fetchImpl(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
  } catch (err) {
    clearTimeout(tid);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: null, body: null, message: `Network error: ${message}` };
  }

  // Step 4: parse body
  const body = await parseResponseBody(r);

  // Step 5: 2xx success
  if (r.status >= 200 && r.status < 300) {
    const meta = extractMeta(body);
    return { ok: true, data: body, meta };
  }

  // Step 6: non-2xx error
  return {
    ok: false,
    httpStatus: r.status,
    body,
    message: `Zoho Integration Service returned HTTP ${r.status}`,
  };
}

// ─── Public API: listInventoryPurchaseOrders ──────────────────────────────────

/**
 * GET /zoho/purchaseorders_inv/list
 *
 * Returns all open purchase orders from Zoho Inventory.
 * Response shape: { data: { purchaseorders: ZohoPurchaseOrderSummary[] }, meta: {...} }
 */
export async function listInventoryPurchaseOrders(opts?: {
  tabletOnly?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InventoryServiceReadResult<ZohoPurchaseOrderSummary[]>> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const path = opts?.tabletOnly === true
    ? "/zoho/purchaseorders_inv/list?luma_tablet_only=true"
    : "/zoho/purchaseorders_inv/list";

  const result = await getInventoryEndpoint({
    path,
    env,
    fetchImpl,
    timeoutMs,
  });

  if (!result.ok) return result;

  // Extract data.purchaseorders array
  const raw = result.data;
  if (!isObject(raw)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: body is not an object" };
  }
  const dataBlock = raw["data"];
  if (!isObject(dataBlock)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data block missing" };
  }
  const purchaseorders = dataBlock["purchaseorders"];
  if (!isArray(purchaseorders)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data.purchaseorders is not an array" };
  }

  return {
    ok: true,
    data: purchaseorders as ZohoPurchaseOrderSummary[],
    meta: result.meta,
  };
}

// ─── Public API: getInventoryPurchaseOrder ────────────────────────────────────

/**
 * GET /zoho/purchaseorders_inv/get/:purchaseOrderId
 *
 * Returns a single PO with full line items.
 * Response shape: { data: { purchaseorder_id, ..., line_items: [] }, meta: {...} }
 */
export async function getInventoryPurchaseOrder(
  purchaseOrderId: string,
  opts?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<InventoryServiceReadResult<ZohoPurchaseOrderDetail>> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  const result = await getInventoryEndpoint({
    path: `/zoho/purchaseorders_inv/get/${encodeURIComponent(purchaseOrderId)}`,
    env,
    fetchImpl,
    timeoutMs,
  });

  if (!result.ok) return result;

  // Extract data directly (detail endpoint — no collection wrapper key)
  const raw = result.data;
  if (!isObject(raw)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: body is not an object" };
  }
  const dataBlock = raw["data"];
  if (!isObject(dataBlock)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data block missing" };
  }

  return {
    ok: true,
    data: dataBlock as unknown as ZohoPurchaseOrderDetail,
    meta: result.meta,
  };
}

// ─── Public API: searchZohoItems ──────────────────────────────────────────────

/**
 * GET /zoho/items/search?query=...&page=...&per_page=...
 *
 * Searches Zoho Inventory items. Pagination info is surfaced in meta.
 * Response shape: { data: { items: ZohoItemSummary[] }, meta: { has_more, page, per_page, ... } }
 */
export async function searchZohoItems(params?: {
  query?: string;
  page?: number;
  per_page?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InventoryServiceReadResult<ZohoItemSummary[]>> {
  const env = params?.env ?? process.env;
  const fetchImpl = params?.fetchImpl ?? fetch;
  const timeoutMs = params?.timeoutMs ?? 15_000;

  // Build query string
  const qs = new URLSearchParams();
  if (params?.query !== undefined && params.query.length > 0) {
    qs.set("query", params.query);
  }
  if (params?.page !== undefined) qs.set("page", String(params.page));
  if (params?.per_page !== undefined) qs.set("per_page", String(params.per_page));
  const qsPart = qs.toString();
  const path = `/zoho/items/search${qsPart.length > 0 ? `?${qsPart}` : ""}`;

  const result = await getInventoryEndpoint({ path, env, fetchImpl, timeoutMs });

  if (!result.ok) return result;

  // Extract data.items array
  const raw = result.data;
  if (!isObject(raw)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: body is not an object" };
  }
  const dataBlock = raw["data"];
  if (!isObject(dataBlock)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data block missing" };
  }
  const items = dataBlock["items"];
  if (!isArray(items)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data.items is not an array" };
  }

  return {
    ok: true,
    data: items as ZohoItemSummary[],
    meta: result.meta,
  };
}

// ─── Public API: listWarehouses ───────────────────────────────────────────────

/**
 * GET /zoho/warehouses/list
 *
 * Returns all warehouses configured in Zoho Inventory.
 * Response shape: { data: { warehouses: ZohoWarehouse[] }, meta: {...} }
 */
export async function listWarehouses(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<InventoryServiceReadResult<ZohoWarehouse[]>> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  const result = await getInventoryEndpoint({
    path: "/zoho/warehouses/list",
    env,
    fetchImpl,
    timeoutMs,
  });

  if (!result.ok) return result;

  // Extract data.warehouses array
  const raw = result.data;
  if (!isObject(raw)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: body is not an object" };
  }
  const dataBlock = raw["data"];
  if (!isObject(dataBlock)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data block missing" };
  }
  const warehouses = dataBlock["warehouses"];
  if (!isArray(warehouses)) {
    return { ok: false, httpStatus: null, body: raw, message: "Unexpected response shape: data.warehouses is not an array" };
  }

  return {
    ok: true,
    data: warehouses as ZohoWarehouse[],
    meta: result.meta,
  };
}
