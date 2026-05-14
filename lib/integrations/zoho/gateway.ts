// ZOHO-1 — Luma-side client for the Zoho integration gateway on the
// dedicated LXC service (env: ZOHO_INTEGRATION_URL, default
// http://192.168.1.190:9503).
//
// Contract: Luma NEVER holds Zoho OAuth refresh/access tokens. The
// gateway owns Zoho creds. This module only:
//   - validates the gateway URL + optional shared secret are configured
//   - probes /health (or equivalent) for connectivity status
//   - asks the gateway for available organizations (single-org → use it;
//     multi-org → return NEEDS_SELECTION; gateway-doesn't-support → document)
//   - never refreshes tokens, never POSTs Zoho writes, never logs secrets
//
// ZOHO-1 wires this client into a settings page + a "Test connection"
// button that writes a zoho_sync_runs row with sync_type =
// CONNECTIVITY_CHECK. ZOHO-2..5 layer items / customers / SO / PO / push
// on top of this same client.

export const ZOHO_GATEWAY_URL_ENV = "ZOHO_INTEGRATION_URL";
export const ZOHO_GATEWAY_SECRET_ENV = "ZOHO_INTEGRATION_SECRET";

/** Default health probe path. The actual gateway exposed today (2026-05-14
 *  audit: not running on :9503 from any LXC; documented as a missing
 *  service) is unknown. We probe a small set of conventional paths in
 *  order and accept the first 2xx. If/when the gateway lands, this list
 *  can be tightened to the real path. */
export const ZOHO_GATEWAY_HEALTH_PATHS = [
  "/health",
  "/status",
  "/api/health",
  "/api/status",
] as const;

/** Where the gateway should expose its known Zoho organizations. Same
 *  audit caveat as above — probe-then-use. */
export const ZOHO_GATEWAY_ORG_PATHS = [
  "/organizations",
  "/api/organizations",
  "/zoho/organizations",
] as const;

export type ZohoGatewayStatus =
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "ERROR"
  | "CONNECTED";

export type ZohoGatewayConfigValidation =
  | {
      configured: true;
      url: string;
      hasSecret: boolean;
      issues: readonly string[];
    }
  | {
      configured: false;
      url: null;
      hasSecret: boolean;
      issues: readonly string[];
    };

export type ZohoGatewayHealthResult = {
  status: ZohoGatewayStatus;
  url: string | null;
  probedPath: string | null;
  httpStatus: number | null;
  /** Plain summary safe to log + show in UI. Never includes the secret. */
  message: string;
  elapsedMs: number | null;
};

export type ZohoGatewayOrganization = {
  organizationId: string;
  organizationName: string;
  /** Free-text from the gateway. May be 'active' / 'inactive' / 'trial'
   *  / anything; we don't try to canonicalise. */
  state: string | null;
  /** Verbatim payload preserved for the future mapping UI. */
  raw: Record<string, unknown>;
};

export type ZohoGatewayOrganizationsResult =
  | {
      kind: "OK";
      organizations: readonly ZohoGatewayOrganization[];
    }
  | {
      kind: "NEEDS_SELECTION";
      organizations: readonly ZohoGatewayOrganization[];
    }
  | {
      kind: "NONE_RETURNED";
      organizations: readonly [];
    }
  | {
      kind: "GATEWAY_LACKS_ENDPOINT";
      probedPaths: readonly string[];
    }
  | {
      kind: "UNREACHABLE" | "ERROR" | "NOT_CONFIGURED";
      message: string;
    };

/** Pure helper. Returns false for null / undefined / empty / whitespace.
 *  Used as the canonical "is this env var meaningfully set?" check. */
export function isNonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Pure: validate the gateway URL + optional shared secret. Does NOT
 *  call the network. */
export function validateZohoGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): ZohoGatewayConfigValidation {
  const rawUrl = env[ZOHO_GATEWAY_URL_ENV];
  const rawSecret = env[ZOHO_GATEWAY_SECRET_ENV];
  const issues: string[] = [];

  if (!isNonBlank(rawUrl)) {
    issues.push(`Missing ${ZOHO_GATEWAY_URL_ENV}.`);
    return {
      configured: false,
      url: null,
      hasSecret: isNonBlank(rawSecret),
      issues: Object.freeze(issues),
    };
  }
  const trimmed = (rawUrl as string).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    issues.push(`${ZOHO_GATEWAY_URL_ENV} is not a valid URL.`);
    return {
      configured: false,
      url: null,
      hasSecret: isNonBlank(rawSecret),
      issues: Object.freeze(issues),
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push(
      `${ZOHO_GATEWAY_URL_ENV} must use http: or https: (got ${parsed.protocol}).`,
    );
    return {
      configured: false,
      url: null,
      hasSecret: isNonBlank(rawSecret),
      issues: Object.freeze(issues),
    };
  }

  return {
    configured: true,
    url: trimmed,
    hasSecret: isNonBlank(rawSecret),
    issues: Object.freeze(issues),
  };
}

/** Pure: build the headers the gateway expects. Returns a plain object
 *  with the shared secret in `x-luma-zoho-secret` IFF the secret is set.
 *  Callers must NEVER log this object verbatim — use stripZohoSecret. */
export function buildZohoGatewayHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-luma-source": "luma",
  };
  const rawSecret = env[ZOHO_GATEWAY_SECRET_ENV];
  if (isNonBlank(rawSecret)) {
    headers["x-luma-zoho-secret"] = (rawSecret as string).trim();
  }
  return headers;
}

/** Pure: redact the shared-secret header from a headers object for safe
 *  logging. Never mutates the original. */
export function stripZohoSecret<T extends Record<string, unknown>>(headers: T): T {
  const out: Record<string, unknown> = { ...headers };
  if ("x-luma-zoho-secret" in out) out["x-luma-zoho-secret"] = "[REDACTED]";
  if ("X-Luma-Zoho-Secret" in out) out["X-Luma-Zoho-Secret"] = "[REDACTED]";
  return out as T;
}

/** Pure: map a fetch / HTTP error into a structured ZohoGatewayStatus. */
export function mapZohoGatewayError(input: {
  thrown?: unknown;
  httpStatus?: number | null;
}): { status: ZohoGatewayStatus; message: string } {
  if (input.thrown != null) {
    const msg = input.thrown instanceof Error ? input.thrown.message : String(input.thrown);
    // Node / undici signal connect failure / DNS failure / ECONNREFUSED
    // as a TypeError with cause.code in the ENOTFOUND/ECONNREFUSED/
    // EHOSTUNREACH family. Treat all of those as UNREACHABLE.
    const lower = msg.toLowerCase();
    const unreachable =
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("ehostunreach") ||
      lower.includes("etimedout") ||
      lower.includes("connect timeout") ||
      lower.includes("network") ||
      lower.includes("fetch failed");
    return {
      status: unreachable ? "UNREACHABLE" : "ERROR",
      message: unreachable
        ? "Gateway unreachable (connection refused / not found / timed out)."
        : `Gateway request failed: ${msg}`,
    };
  }
  if (input.httpStatus == null) {
    return { status: "ERROR", message: "Gateway request failed: unknown error." };
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) {
    return { status: "CONNECTED", message: `Gateway responded ${input.httpStatus}.` };
  }
  return {
    status: "ERROR",
    message: `Gateway responded HTTP ${input.httpStatus}.`,
  };
}

type FetchLike = typeof fetch;

/** Live: probe the gateway health/status endpoint. Tries each
 *  ZOHO_GATEWAY_HEALTH_PATHS path in order; returns the first 2xx as
 *  CONNECTED. If every probe returns 4xx/5xx the last one's status code
 *  is reported. Connection-level failure → UNREACHABLE. */
export async function checkZohoGatewayHealth(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  paths?: readonly string[];
}): Promise<ZohoGatewayHealthResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const paths = opts?.paths ?? ZOHO_GATEWAY_HEALTH_PATHS;

  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return {
      status: "NOT_CONFIGURED",
      url: null,
      probedPath: null,
      httpStatus: null,
      message: cfg.issues[0] ?? "Gateway not configured.",
      elapsedMs: null,
    };
  }

  const headers = buildZohoGatewayHeaders(env);
  const start = Date.now();
  let lastNon2xx: { status: number; path: string } | null = null;
  let lastThrown: unknown = null;

  for (const path of paths) {
    const url = `${cfg.url}${path}`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
      clearTimeout(tid);
      if (r.status >= 200 && r.status < 300) {
        return {
          status: "CONNECTED",
          url: cfg.url,
          probedPath: path,
          httpStatus: r.status,
          message: `Gateway healthy at ${path} (HTTP ${r.status}).`,
          elapsedMs: Date.now() - start,
        };
      }
      lastNon2xx = { status: r.status, path };
    } catch (err) {
      clearTimeout(tid);
      lastThrown = err;
    }
  }

  if (lastThrown != null) {
    const mapped = mapZohoGatewayError({ thrown: lastThrown });
    return {
      status: mapped.status,
      url: cfg.url,
      probedPath: null,
      httpStatus: null,
      message: mapped.message,
      elapsedMs: Date.now() - start,
    };
  }
  if (lastNon2xx) {
    return {
      status: "ERROR",
      url: cfg.url,
      probedPath: lastNon2xx.path,
      httpStatus: lastNon2xx.status,
      message: `Gateway returned HTTP ${lastNon2xx.status} on ${lastNon2xx.path}.`,
      elapsedMs: Date.now() - start,
    };
  }
  return {
    status: "ERROR",
    url: cfg.url,
    probedPath: null,
    httpStatus: null,
    message: "Gateway probe failed with no response and no error.",
    elapsedMs: Date.now() - start,
  };
}

/** Live: ask the gateway for the available Zoho organizations. Probes a
 *  small set of conventional paths in order. Returns:
 *    - OK if exactly one org is returned (caller uses it).
 *    - NEEDS_SELECTION if 2+ orgs returned.
 *    - NONE_RETURNED if the endpoint exists but is empty.
 *    - GATEWAY_LACKS_ENDPOINT if every probed path returned 404.
 *    - NOT_CONFIGURED / UNREACHABLE / ERROR for transport-level issues.
 *
 *  Accepts gateway response shapes:
 *    [{ organization_id, organization_name, state? }, ...]
 *    { organizations: [...] }
 *    { data: [...] }
 *
 *  Anything else gets logged (without secrets) and reported as
 *  GATEWAY_LACKS_ENDPOINT. */
export async function fetchZohoOrganizations(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  paths?: readonly string[];
}): Promise<ZohoGatewayOrganizationsResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const paths = opts?.paths ?? ZOHO_GATEWAY_ORG_PATHS;

  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return {
      kind: "NOT_CONFIGURED",
      message: cfg.issues[0] ?? "Gateway not configured.",
    };
  }

  const headers = buildZohoGatewayHeaders(env);
  const triedPaths: string[] = [];
  let lastThrown: unknown = null;
  let lastNon404Error: { status: number; path: string } | null = null;

  for (const path of paths) {
    const url = `${cfg.url}${path}`;
    triedPaths.push(path);
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
      clearTimeout(tid);
      if (r.status === 404) continue;
      if (r.status < 200 || r.status >= 300) {
        lastNon404Error = { status: r.status, path };
        continue;
      }
      const body = (await r.json().catch(() => null)) as unknown;
      const orgs = extractOrganizations(body);
      if (orgs.length === 0) return { kind: "NONE_RETURNED", organizations: [] };
      if (orgs.length === 1)
        return { kind: "OK", organizations: Object.freeze(orgs) };
      return { kind: "NEEDS_SELECTION", organizations: Object.freeze(orgs) };
    } catch (err) {
      clearTimeout(tid);
      lastThrown = err;
    }
  }

  if (lastThrown != null) {
    const mapped = mapZohoGatewayError({ thrown: lastThrown });
    return {
      kind: mapped.status === "UNREACHABLE" ? "UNREACHABLE" : "ERROR",
      message: mapped.message,
    };
  }
  if (lastNon404Error) {
    return {
      kind: "ERROR",
      message: `Gateway returned HTTP ${lastNon404Error.status} on ${lastNon404Error.path}.`,
    };
  }
  return { kind: "GATEWAY_LACKS_ENDPOINT", probedPaths: Object.freeze(triedPaths) };
}

/** Pure: pull a normalized organization list out of whatever shape the
 *  gateway returned. Tolerates [...], { organizations: [...] }, and
 *  { data: [...] }. Drops entries without an id. */
export function extractOrganizations(body: unknown): ZohoGatewayOrganization[] {
  let candidates: unknown[] = [];
  if (Array.isArray(body)) {
    candidates = body;
  } else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.organizations)) candidates = obj.organizations;
    else if (Array.isArray(obj.data)) candidates = obj.data;
    else if (Array.isArray(obj.items)) candidates = obj.items;
  }
  const out: ZohoGatewayOrganization[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    const id =
      pickString(row, "organization_id") ??
      pickString(row, "organizationId") ??
      pickString(row, "id");
    if (!id) continue;
    const name =
      pickString(row, "organization_name") ??
      pickString(row, "organizationName") ??
      pickString(row, "name") ??
      "(unnamed)";
    const state =
      pickString(row, "state") ??
      pickString(row, "status") ??
      null;
    out.push({
      organizationId: id,
      organizationName: name,
      state,
      raw: row,
    });
  }
  return out;
}

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}
