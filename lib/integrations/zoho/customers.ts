// ZOHO-2A — Zoho Inventory contacts (customers): dry-run client +
// normalizer.
//
// Customer master target: Zoho Inventory's "contacts" object (the
// gateway service key is `contacts_inv`). For Haute Nutrition that's
// where billing + shipping + customer_code live.
//
// Same protocol as items.ts: GET /zoho/contacts_inv/list?per_page=
// &page= with X-Internal-Token + X-Brand. Strictly dry-run; no
// writes to Zoho or to Luma's customers table.

import {
  buildZohoGatewayHeaders,
  mapZohoGatewayError,
  validateZohoGatewayConfig,
} from "./gateway";
import { extractCollection } from "./items";

export const ZOHO_CUSTOMERS_LIST_PATH = "/zoho/contacts_inv/list";

export type NormalizedZohoCustomer = {
  zohoCustomerId: string;
  customerName: string;
  /** A Luma-side suggestion derived from contact_number / company_name
   *  / cf_customer_code custom field. Always sanitised to A-Z0-9 +
   *  dash. Operators confirm before any write. */
  customerCodeSuggestion: string | null;
  email: string | null;
  phone: string | null;
  billingAddress: ZohoCustomerAddress | null;
  shippingAddress: ZohoCustomerAddress | null;
  active: boolean;
  raw: Record<string, unknown>;
};

export type ZohoCustomerAddress = {
  attention: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

export type FetchZohoCustomersDryRunResult =
  | {
      kind: "OK";
      customers: readonly NormalizedZohoCustomer[];
      raw: { count: number };
    }
  | { kind: "NOT_CONFIGURED"; message: string }
  | { kind: "UNREACHABLE" | "ERROR"; message: string }
  | { kind: "UNAUTHORIZED"; httpStatus: number; message: string };

type FetchLike = typeof fetch;

/** Pure: collapse a Zoho Inventory contact payload into Luma's
 *  normalized customer shape. Drops contacts that don't have a
 *  contact_id. Never invents fields. */
export function normalizeZohoCustomer(input: unknown): NormalizedZohoCustomer | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  const zohoCustomerId =
    pickString(row, "contact_id") ??
    pickString(row, "customer_id") ??
    pickString(row, "id");
  if (!zohoCustomerId) return null;
  const customerName =
    pickString(row, "contact_name") ??
    pickString(row, "company_name") ??
    pickString(row, "display_name") ??
    "(unnamed)";
  return {
    zohoCustomerId,
    customerName,
    customerCodeSuggestion: deriveCustomerCodeSuggestion(row),
    email: pickString(row, "email") ?? pickString(row, "primary_email"),
    phone:
      pickString(row, "phone") ??
      pickString(row, "mobile") ??
      pickString(row, "primary_phone"),
    billingAddress: pickAddress(row.billing_address),
    shippingAddress: pickAddress(row.shipping_address),
    active: parseActiveContact(row),
    raw: row,
  };
}

/** Pure: pick a default Luma destination. For customers there's only
 *  one master table, so the suggestion is binary: CUSTOMER (proceed
 *  to diff) or UNKNOWN (force NEEDS_REVIEW because we can't even
 *  produce a customer_code suggestion). */
export function deriveZohoCustomerLumaTarget(
  customer: NormalizedZohoCustomer,
): "CUSTOMER" | "UNKNOWN" {
  if (!customer.customerCodeSuggestion) return "UNKNOWN";
  if (customer.customerName === "(unnamed)") return "UNKNOWN";
  return "CUSTOMER";
}

export async function fetchZohoCustomersDryRun(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  path?: string;
  perPage?: number;
  page?: number;
}): Promise<FetchZohoCustomersDryRunResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const path = opts?.path ?? ZOHO_CUSTOMERS_LIST_PATH;
  const perPage = opts?.perPage ?? 200;
  const page = opts?.page ?? 1;

  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return { kind: "NOT_CONFIGURED", message: cfg.issues[0] ?? "Gateway not configured." };
  }
  const headers = buildZohoGatewayHeaders(env);
  const url = `${cfg.url}${path}?per_page=${perPage}&page=${page}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
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
      return { kind: "ERROR", message: `Gateway returned HTTP ${r.status} on ${path}.` };
    }
    const body = (await r.json().catch(() => null)) as unknown;
    const list = extractCollection(body, "contacts");
    const normalized = list
      .map((c) => normalizeZohoCustomer(c))
      .filter((c): c is NormalizedZohoCustomer => c != null);
    return { kind: "OK", customers: normalized, raw: { count: list.length } };
  } catch (err) {
    clearTimeout(tid);
    const mapped = mapZohoGatewayError({ thrown: err });
    return {
      kind: mapped.status === "UNREACHABLE" ? "UNREACHABLE" : "ERROR",
      message: mapped.message,
    };
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

/** Pure: pull a Luma-suitable `customer_code` suggestion. Priority:
 *  the most likely Zoho-side custom field (`cf_customer_code` /
 *  `customer_code` / `contact_number`), falling back to the company
 *  name sanitised. Always upper-cased and stripped to [A-Z0-9-] so
 *  the operator can paste it directly into Luma. */
export function deriveCustomerCodeSuggestion(row: Record<string, unknown>): string | null {
  const candidate =
    pickString(row, "cf_customer_code") ??
    pickString(row, "customer_code") ??
    pickString(row, "contact_number") ??
    pickString(row, "customer_number");
  if (candidate) return sanitiseCode(candidate);
  // Fallback: derive from the company / display name. Only when both
  // fields are absent.
  const name = pickString(row, "company_name") ?? pickString(row, "display_name");
  if (!name) return null;
  return sanitiseCode(name);
}

function sanitiseCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function pickAddress(input: unknown): ZohoCustomerAddress | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  return {
    attention: pickString(row, "attention"),
    address: pickString(row, "address"),
    city: pickString(row, "city"),
    state: pickString(row, "state"),
    zip: pickString(row, "zip"),
    country: pickString(row, "country"),
  };
}

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

function parseActiveContact(row: Record<string, unknown>): boolean {
  const raw = row.status ?? row.is_active ?? row.active;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "active" || v === "true" || v === "yes" || v === "1") return true;
    if (v === "inactive" || v === "false" || v === "no" || v === "0") return false;
  }
  return true;
}
