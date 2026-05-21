// ZOHO-2A — Zoho Inventory items: dry-run client + normalizer.
//
// Replaces the H.x0.5 stubs with a real read-only client that routes
// through the LXC gateway (lib/integrations/zoho/gateway.ts). Strictly
// dry-run: this module never writes back to Zoho and never mutates
// Luma master tables. The diff engine in sync-dry-run.ts consumes the
// normalized output of this module.
//
// Gateway route (audited 2026-05-14 against zoho_api_routes on LXC
// 9504): service=items, action=list, method=GET, endpoint_template
// /inventory/v1/items, product=inventory.

import {
  buildZohoGatewayHeaders,
  mapZohoGatewayError,
  validateZohoGatewayConfig,
  type ZohoGatewayHealthStatus,
} from "./gateway";

export const ZOHO_ITEMS_LIST_PATH = "/zoho/items/list";

/** Stable shape Luma callers consume. Mirrors the spec in the
 *  ZOHO-2A prompt — every Zoho-side variant must collapse here. */
export type NormalizedZohoItem = {
  zohoItemId: string;
  name: string;
  sku: string | null;
  itemType: string | null;
  active: boolean;
  unit: string | null;
  category: string | null;
  rate: number | null;
  purchaseRate: number | null;
  inventoryAccount: string | null;
  raw: Record<string, unknown>;
};

/** Suggested Luma destination. The diff engine decides the actual
 *  diff Action; this is only a hint. UNKNOWN forces NEEDS_REVIEW. */
export type LumaItemTarget =
  | "PRODUCT"
  | "TABLET_TYPE"
  | "PACKAGING_MATERIAL"
  | "UNKNOWN";

export type FetchZohoItemsDryRunResult =
  | {
      kind: "OK";
      items: readonly NormalizedZohoItem[];
      raw: { count: number };
    }
  | {
      kind: "NOT_CONFIGURED";
      message: string;
    }
  | {
      kind: "UNREACHABLE" | "ERROR";
      message: string;
    }
  | {
      kind: "UNAUTHORIZED";
      httpStatus: number;
      message: string;
    };

type FetchLike = typeof fetch;

/** Pure: collapse one Zoho item payload into the Luma-normalized shape.
 *  Accepts the verbatim Zoho Inventory item JSON
 *  ({ item_id, name, sku, item_type, status, unit, category_name,
 *     rate, purchase_rate, inventory_account_name, ... }). Tolerates
 *  partials — missing fields become null. Never invents values. */
export function normalizeZohoItem(input: unknown): NormalizedZohoItem | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const zohoItemId = pickString(row, "item_id") ?? pickString(row, "itemId");
  if (!zohoItemId) return null;
  const name =
    pickString(row, "name") ??
    pickString(row, "item_name") ??
    "(unnamed)";
  return {
    zohoItemId,
    name,
    sku: pickString(row, "sku"),
    itemType: pickString(row, "item_type") ?? pickString(row, "type"),
    active: parseActive(row),
    unit: pickString(row, "unit"),
    category:
      pickString(row, "category_name") ??
      pickString(row, "category") ??
      pickString(row, "group_name"),
    rate: pickNumber(row, "rate"),
    purchaseRate: pickNumber(row, "purchase_rate"),
    inventoryAccount: pickString(row, "inventory_account_name"),
    raw: row,
  };
}

/** Pure: pick a default Luma destination from the normalized item.
 *  Conservative — UNKNOWN unless the Zoho metadata is unambiguous.
 *  An admin will confirm before any write. Never decides from name
 *  alone when item_id / SKU exist. */
export function deriveZohoItemLumaTarget(
  item: NormalizedZohoItem,
): LumaItemTarget {
  const t = (item.itemType ?? "").toLowerCase();
  const cat = (item.category ?? "").toLowerCase();
  const account = (item.inventoryAccount ?? "").toLowerCase();
  // Packaging-material signal (Zoho-side conventions used by the
  // packaging team): "packaging", "packaging materials", "blister",
  // "foil", "pvc", etc. Inventory_account often reads "Packaging
  // Inventory" for these rows.
  if (
    cat.includes("packaging") ||
    cat.includes("blister") ||
    cat.includes("foil") ||
    cat.includes("pvc") ||
    cat.includes("shrink") ||
    account.includes("packaging")
  )
    return "PACKAGING_MATERIAL";
  // Raw-tablet signal: item_type marked "raw_material" or category
  // names matching the tablet master.
  if (t.includes("raw") || cat.includes("tablet") || cat.includes("bulk"))
    return "TABLET_TYPE";
  // Sales/finished-good signal: item_type marked sales/inventory_sales,
  // or category matching a known finished-product channel.
  if (t.includes("sales") || t === "inventory" || cat.includes("finished"))
    return "PRODUCT";
  return "UNKNOWN";
}

/** Live: fetch one page of Zoho Inventory items via the gateway. ZOHO-
 *  2A only ever uses page=1 (small per-page cap) — full pagination
 *  lands in ZOHO-3 when the apply-phase needs the whole set. Returns
 *  a discriminated result the dry-run engine consumes; never throws
 *  for transport-level failures. */
export async function fetchZohoItemsDryRun(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  path?: string;
  perPage?: number;
  page?: number;
}): Promise<FetchZohoItemsDryRunResult> {
  return fetchListViaGateway({
    env: opts?.env ?? process.env,
    fetchImpl: opts?.fetchImpl ?? fetch,
    timeoutMs: opts?.timeoutMs ?? 12_000,
    path: opts?.path ?? ZOHO_ITEMS_LIST_PATH,
    perPage: opts?.perPage ?? 200,
    page: opts?.page ?? 1,
    collectionKey: "items",
    normalizer: normalizeZohoItem,
  });
}

// ─── Shared list-fetch helper ─────────────────────────────────────────────
//
// Items + customers share the same gateway protocol: GET /zoho/{service}/
// {action}?per_page=N&page=K, response is either a bare array or
// { <collection>: [...], page_context: {...} }. We keep the helper
// generic and use it from both modules; living here keeps the import
// graph clean (items.ts is loaded before customers.ts in dry-run).

type ListFetchOpts<T> = {
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  path: string;
  perPage: number;
  page: number;
  collectionKey: string;
  normalizer: (input: unknown) => T | null;
};

async function fetchListViaGateway<T>(
  opts: ListFetchOpts<T>,
): Promise<
  | { kind: "OK"; items: T[]; raw: { count: number } }
  | { kind: "NOT_CONFIGURED"; message: string }
  | { kind: "UNREACHABLE" | "ERROR"; message: string }
  | { kind: "UNAUTHORIZED"; httpStatus: number; message: string }
> {
  const cfg = validateZohoGatewayConfig(opts.env);
  if (!cfg.configured) {
    return { kind: "NOT_CONFIGURED", message: cfg.issues[0] ?? "Gateway not configured." };
  }
  const headers = buildZohoGatewayHeaders(opts.env);
  const url = `${cfg.url}${opts.path}?per_page=${opts.perPage}&page=${opts.page}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await opts.fetchImpl(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
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
        message: `Gateway returned HTTP ${r.status} on ${opts.path}.`,
      };
    }
    const body = (await r.json().catch(() => null)) as unknown;
    const list = extractCollection(body, opts.collectionKey);
    const normalized = list
      .map((row) => opts.normalizer(row))
      .filter((x): x is T => x != null);
    return { kind: "OK", items: normalized, raw: { count: list.length } };
  } catch (err) {
    clearTimeout(tid);
    const mapped = mapZohoGatewayError({ thrown: err });
    const kind: ZohoGatewayHealthStatus = mapped.status;
    return {
      kind: kind === "UNREACHABLE" ? "UNREACHABLE" : "ERROR",
      message: mapped.message,
    };
  }
}

/** Pure: pluck the array of rows out of whatever shape the gateway
 *  returns. Tolerates a bare array, { <key>: [...] }, { data: [...] },
 *  and { <key>: [...], page_context: {...} } (Zoho's native shape). */
export function extractCollection(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
    if (Array.isArray(obj.data)) return obj.data as unknown[];
    if (Array.isArray(obj.items) && key !== "items") return obj.items as unknown[];
  }
  return [];
}

// ─── Tiny pure helpers ────────────────────────────────────────────────────

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

function parseActive(row: Record<string, unknown>): boolean {
  const raw =
    row.status ??
    row.is_active ??
    row.active ??
    row.isActive ??
    null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "active" || v === "true" || v === "yes" || v === "1") return true;
    if (v === "inactive" || v === "false" || v === "no" || v === "0") return false;
  }
  // Default to active when Zoho doesn't say otherwise. Inactive must be
  // explicit — operators rarely flip the flag both ways, so optimistic
  // active is safer than silently dropping a real item.
  return true;
}
