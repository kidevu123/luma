// WAREHOUSE-CAPABILITY-v1.4.0 — Zoho gateway brand-capabilities client.
//
// Read-through call on every production-output preview attempt. We do
// NOT cache the response in Luma DB in this phase. DB caching is
// deferred and will be folded into the future cached-endpoints work.
//
// Endpoint (gateway v1.23.1):
//
//   GET /zoho/brand-capabilities/warehouse
//
// For brand `haute_brands`, the deployed v1.23.1 response shape is:
//
//   {
//     "data": {
//       "warehouse_required": false,
//       "warehouse_source": "none_configured",
//       "warehouse_count": 0,
//       "last_observed_at": "...",
//       "stale": false
//     },
//     "warnings": [],
//     "meta": {
//       "brand": "haute_brands",
//       "request_id": "<uuid>"
//     }
//   }
//
// Mapping rule (TOTAL — every input maps to exactly one state):
//
//   data.warehouse_required === true     -> REQUIRED
//   data.warehouse_required === false    -> OPTIONAL
//   data.warehouse_required === null     -> UNKNOWN
//   field missing entirely               -> UNKNOWN
//   HTTP non-2xx                          -> UNKNOWN
//   network/timeout                       -> UNKNOWN
//   JSON parse failure                    -> UNKNOWN
//
// UNKNOWN NEVER falls through to OPTIONAL. A combinator above this
// layer must block when state is UNKNOWN.
//
// Pure transport + pure mapping. No DB, no env reads except via the
// shared assembly-service config helper.

import { validateAssemblyServiceConfig } from "./assembly-service-client";

export const BRAND_CAPABILITY_WAREHOUSE_PATH =
  "/zoho/brand-capabilities/warehouse";

export type WarehouseCapability =
  | { state: "REQUIRED"; gatewayRequestId: string }
  | { state: "OPTIONAL"; gatewayRequestId: string }
  | { state: "UNKNOWN"; reason: string };

/**
 * Map a gateway response body (already parsed JSON) onto the total
 * capability state. Pure — no I/O.
 */
export function mapWarehouseCapabilityResponse(
  body: unknown,
): WarehouseCapability {
  if (body == null || typeof body !== "object") {
    return {
      state: "UNKNOWN",
      reason: "gateway response not parseable",
    };
  }
  const obj = body as Record<string, unknown>;
  const data =
    obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : null;
  const meta =
    obj.meta && typeof obj.meta === "object"
      ? (obj.meta as Record<string, unknown>)
      : null;

  if (!data || !("warehouse_required" in data)) {
    return {
      state: "UNKNOWN",
      reason: "gateway omitted warehouse_required field",
    };
  }

  const value = data.warehouse_required;
  if (value === null) {
    return { state: "UNKNOWN", reason: "gateway returned null" };
  }
  if (typeof value !== "boolean") {
    return {
      state: "UNKNOWN",
      reason: `gateway returned non-boolean (${typeof value})`,
    };
  }

  const rawRequestId = meta?.request_id;
  const gatewayRequestId =
    typeof rawRequestId === "string" && rawRequestId.length > 0
      ? rawRequestId
      : "unknown-request-id";

  return value === true
    ? { state: "REQUIRED", gatewayRequestId }
    : { state: "OPTIONAL", gatewayRequestId };
}

export type FetchWarehouseCapabilityOptions = {
  env?: Record<string, string | undefined>;
  /** Test seam — defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Request timeout in ms. Defaults to 5_000. */
  timeoutMs?: number;
};

/**
 * Fetch the warehouse capability from the gateway.
 *
 * Returns a total `WarehouseCapability` — never throws. Transport
 * errors, parse errors, and non-2xx all collapse to UNKNOWN with a
 * structured reason.
 */
export async function fetchWarehouseCapability(
  opts: FetchWarehouseCapabilityOptions = {},
): Promise<WarehouseCapability> {
  const env = opts.env ?? process.env;
  const config = validateAssemblyServiceConfig(env);
  if (!config.ok) {
    return { state: "UNKNOWN", reason: `gateway not configured: ${config.reason}` };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const url = `${config.baseUrl}${BRAND_CAPABILITY_WAREHOUSE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.bearerSecret}`,
        "X-Brand": config.brand,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "UNKNOWN", reason: `gateway unreachable: ${message}` };
  } finally {
    clearTimeout(timer);
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      state: "UNKNOWN",
      reason: `gateway returned HTTP ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      state: "UNKNOWN",
      reason: "gateway response not parseable",
    };
  }

  return mapWarehouseCapabilityResponse(body);
}
