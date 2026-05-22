// ZOHO-ASM-CLIENT — Thin HTTP client for Zoho Integration Service v1.10.0
// write endpoints (/zoho/purchase_receives/create, /zoho/assemblies/create).
//
// Auth model (v1.10.0 endpoints):
//   Authorization: Bearer ${ZOHO_SERVICE_BEARER_SECRET}  — distinct from the
//                                                           shared X-Internal-Token
//   X-Brand:       ${ZOHO_BRAND}                         — brand selector
//   Idempotency-Key: <caller-provided>
//
// Feature flag: ZOHO_DRY_RUN_WRITES_ENABLED must be "true" or all calls are
// refused with guardBlocked: true. This prevents accidental writes in
// environments that have not explicitly opted in.
//
// Never log the bearer secret. Use redactAssemblyServiceHeaders for safe
// logging of the headers object.

// ─── Exported env-var name constants ─────────────────────────────────────────

export const ZOHO_BEARER_SECRET_ENV = "ZOHO_SERVICE_BEARER_SECRET";
export const ZOHO_DRY_RUN_ENABLED_ENV = "ZOHO_DRY_RUN_WRITES_ENABLED";
export const ZOHO_WAREHOUSE_ID_ENV = "ZOHO_WAREHOUSE_ID";

// ─── Error class ──────────────────────────────────────────────────────────────

export class ZohoAssemblyServiceError extends Error {
  constructor(
    public readonly httpStatus: number | null,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ZohoAssemblyServiceError";
  }
}

// ─── Config validation ────────────────────────────────────────────────────────

export type AssemblyServiceConfig =
  | { ok: true; baseUrl: string; bearerSecret: string; brand: string; dryRunEnabled: boolean; warehouseId: string | null }
  | { ok: false; reason: string };

/**
 * Pure: validate env vars required for the v1.10.0 assembly endpoints.
 * No side-effects — does not log, does not read process.env directly unless
 * the caller passes the default.
 */
export function validateAssemblyServiceConfig(
  env: Record<string, string | undefined> = process.env,
): AssemblyServiceConfig {
  // ZOHO_SERVICE_BASE_URL is the preferred name; ZOHO_INTEGRATION_URL is the
  // legacy alias kept for backward compatibility with existing .env files.
  const rawUrl = env["ZOHO_SERVICE_BASE_URL"] ?? env["ZOHO_INTEGRATION_URL"];
  const rawBearer = env[ZOHO_BEARER_SECRET_ENV];
  const rawBrand = env["ZOHO_BRAND"];
  const rawWarehouseId = env[ZOHO_WAREHOUSE_ID_ENV];
  const warehouseId = rawWarehouseId && rawWarehouseId.trim().length > 0
    ? rawWarehouseId.trim()
    : null;

  // URL must be present and valid (same service, different path)
  if (!rawUrl || rawUrl.trim().length === 0) {
    return { ok: false, reason: "ZOHO_SERVICE_BASE_URL (or ZOHO_INTEGRATION_URL) is not configured." };
  }
  const trimmedUrl = rawUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    return { ok: false, reason: "ZOHO_SERVICE_BASE_URL is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `ZOHO_SERVICE_BASE_URL must use http: or https: (got ${parsed.protocol}).`,
    };
  }

  // Bearer secret must be present and non-empty
  if (!rawBearer || rawBearer.trim().length === 0) {
    return { ok: false, reason: "ZOHO_SERVICE_BEARER_SECRET is not configured." };
  }

  // Brand: use configured value or default to "haute_brands"
  const brand =
    rawBrand && rawBrand.trim().length > 0 ? rawBrand.trim() : "haute_brands";

  const dryRunEnabled = env[ZOHO_DRY_RUN_ENABLED_ENV] === "true";

  return {
    ok: true,
    baseUrl: trimmedUrl,
    bearerSecret: rawBearer.trim(),
    brand,
    dryRunEnabled,
    warehouseId,
  };
}

// ─── Header builder ───────────────────────────────────────────────────────────

/**
 * Pure: build the request headers for v1.10.0 assembly write endpoints.
 * NEVER log the returned object verbatim — use redactAssemblyServiceHeaders.
 */
export function buildAssemblyServiceHeaders(opts: {
  bearerSecret: string;
  brand: string;
  idempotencyKey: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.bearerSecret}`,
    "X-Brand": opts.brand,
    "Idempotency-Key": opts.idempotencyKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Pure: return a copy of the headers object with the Authorization value
 * replaced by "Bearer [REDACTED]". Safe to pass to loggers.
 */
export function redactAssemblyServiceHeaders(
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

// ─── Main call function ───────────────────────────────────────────────────────

type FetchLike = typeof fetch;

export type AssemblyServiceCallResult =
  | { ok: true; httpStatus: number; body: unknown }
  | {
      ok: false;
      httpStatus: number | null;
      body: unknown;
      message: string;
      guardBlocked: boolean;
    };

/**
 * POST to a Zoho Integration Service v1.10.0 write endpoint.
 *
 * Returns a discriminated union — callers must check `result.ok` before
 * treating the response as success.
 *
 * The call is refused (guardBlocked: true) when ZOHO_DRY_RUN_WRITES_ENABLED
 * is not set to "true", preventing accidental production writes from
 * environments that have not opted in.
 */
export async function callZohoAssemblyService(opts: {
  path: "/zoho/purchase_receives/create" | "/zoho/assemblies/create";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<AssemblyServiceCallResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Step 1: validate config
  const config = validateAssemblyServiceConfig(env);
  if (!config.ok) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: config.reason,
      guardBlocked: false,
    };
  }

  // Step 2: check dry-run feature flag
  if (!config.dryRunEnabled) {
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message:
        "Dry-run writes are disabled. Set ZOHO_DRY_RUN_WRITES_ENABLED=true to enable.",
      guardBlocked: true,
    };
  }

  // Step 3: build headers
  const headers = buildAssemblyServiceHeaders({
    bearerSecret: config.bearerSecret,
    brand: config.brand,
    idempotencyKey: opts.idempotencyKey,
  });

  // Step 4 & 5: POST with timeout
  const url = `${config.baseUrl}${opts.path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);

  let r: Response;
  try {
    r = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.payload),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
  } catch (err) {
    clearTimeout(tid);
    // Step 6: network error
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: null,
      body: null,
      message: `Network error: ${message}`,
      guardBlocked: false,
    };
  }

  // Parse body (JSON preferred, fall back to text)
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    try {
      body = await r.text();
    } catch {
      body = null;
    }
  }

  // Step 7: 2xx success
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, httpStatus: r.status, body };
  }

  // Step 8: non-2xx error
  return {
    ok: false,
    httpStatus: r.status,
    body,
    message: `Zoho Integration Service returned HTTP ${r.status}`,
    guardBlocked: false,
  };
}

// ─── Convenience helper ───────────────────────────────────────────────────────

/**
 * Pure: returns true only when the dry-run feature flag is explicitly set to
 * "true". Safe to call from UI / settings pages without side-effects.
 */
export function isZohoAssemblyDryRunEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ZOHO_DRY_RUN_ENABLED_ENV] === "true";
}
