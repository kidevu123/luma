// ZOHO-GW-2 — Luma-side client for the Zoho integration gateway.
//
// Contract: Luma NEVER holds Zoho OAuth refresh/access tokens. The
// gateway owns Zoho creds. This module only:
//   - validates the gateway URL + shared internal-token + brand are configured
//   - probes /health (open) for transport-level connectivity
//   - probes /status (auth-required) to discover available brands +
//     their per-product token status, returning a structured
//     `ZohoBrandStatus` result the settings page consumes
//   - never refreshes tokens, never POSTs Zoho writes, never logs secrets
//
// Header model (set by buildZohoGatewayHeaders):
//   - X-Internal-Token: ZOHO_INTEGRATION_SECRET (gateway secret)
//   - X-Brand:          ZOHO_BRAND             (selects which brand's
//                                              Zoho creds the gateway uses)
//
// The previous (ZOHO-1) header name `x-luma-zoho-secret` was a Luma-side
// naming convention; the real gateway expects `X-Internal-Token`. We
// switch to the gateway's name. There is no production traffic that
// relied on the old name (ZOHO-1 only wrote CONNECTIVITY_CHECK rows
// against /health which is open).

export const ZOHO_GATEWAY_URL_ENV = "ZOHO_INTEGRATION_URL";
export const ZOHO_GATEWAY_SECRET_ENV = "ZOHO_INTEGRATION_SECRET";
export const ZOHO_GATEWAY_BRAND_ENV = "ZOHO_BRAND";

/** Health probe path. The real gateway exposes /health open (no auth).
 *  We keep the list configurable so future deployments can override. */
export const ZOHO_GATEWAY_HEALTH_PATHS = ["/health"] as const;

/** Status probe path. The real gateway exposes /status with
 *  X-Internal-Token auth. /status returns a `brands[]` array with each
 *  brand's per-product (books / inventory / crm / expense) token
 *  status. */
export const ZOHO_GATEWAY_STATUS_PATHS = ["/status", "/api/status"] as const;

// ─── Status enums ──────────────────────────────────────────────────────────

export type ZohoGatewayHealthStatus =
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "ERROR"
  | "CONNECTED";

/** Overall ZOHO readiness composing health + brand selection + token
 *  status. The settings page renders this directly. */
export type ZohoReadiness =
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "ERROR"
  | "CONNECTED_HEALTH_ONLY"
  | "NEEDS_SELECTION"
  | "NEEDS_REAUTH"
  | "READY_FOR_DRY_RUN";

// ─── Config validation ────────────────────────────────────────────────────

export type ZohoGatewayConfigValidation =
  | {
      configured: true;
      url: string;
      hasSecret: boolean;
      brand: string | null;
      hasBrand: boolean;
      issues: readonly string[];
    }
  | {
      configured: false;
      url: null;
      hasSecret: boolean;
      brand: string | null;
      hasBrand: boolean;
      issues: readonly string[];
    };

export type ZohoGatewayHealthResult = {
  status: ZohoGatewayHealthStatus;
  url: string | null;
  probedPath: string | null;
  httpStatus: number | null;
  message: string;
  elapsedMs: number | null;
};

// ─── Brand + token-status result types ────────────────────────────────────

export type ZohoBrandProductTokenStatus = "valid" | "expired" | "missing" | "unknown";

export type ZohoBrandProduct = {
  product: string;
  enabled: boolean;
  tokenStatus: ZohoBrandProductTokenStatus;
  expiresAt: string | null;
};

export type ZohoBrand = {
  brandKey: string;
  organizationId: string | null;
  region: string | null;
  status: string | null;
  products: readonly ZohoBrandProduct[];
  raw: Record<string, unknown>;
};

export type ZohoBrandStatusResult =
  | {
      kind: "OK";
      brand: ZohoBrand;
      brands: readonly ZohoBrand[];
      message: string;
    }
  | {
      kind: "NEEDS_REAUTH";
      brand: ZohoBrand;
      brands: readonly ZohoBrand[];
      expiredProducts: readonly ZohoBrandProduct[];
      message: string;
    }
  | {
      kind: "NEEDS_SELECTION";
      brands: readonly ZohoBrand[];
      message: string;
    }
  | {
      kind: "BRAND_NOT_FOUND";
      configuredBrand: string;
      brands: readonly ZohoBrand[];
      message: string;
    }
  | {
      kind: "NONE_RETURNED";
      message: string;
    }
  | {
      kind: "GATEWAY_LACKS_ENDPOINT";
      probedPaths: readonly string[];
      message: string;
    }
  | {
      kind: "UNAUTHORIZED";
      httpStatus: number;
      message: string;
    }
  | {
      kind: "UNREACHABLE" | "ERROR" | "NOT_CONFIGURED";
      message: string;
    };

// ─── Pure helpers ─────────────────────────────────────────────────────────

/** False for null / undefined / empty / whitespace; true otherwise. */
export function isNonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Pure: validate URL + optional secret + optional brand. */
export function validateZohoGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): ZohoGatewayConfigValidation {
  const rawUrl = env[ZOHO_GATEWAY_URL_ENV];
  const rawSecret = env[ZOHO_GATEWAY_SECRET_ENV];
  const rawBrand = env[ZOHO_GATEWAY_BRAND_ENV];
  const issues: string[] = [];
  const hasSecret = isNonBlank(rawSecret);
  const brandConfigured = isNonBlank(rawBrand);
  const brand = brandConfigured ? (rawBrand as string).trim() : null;

  if (!isNonBlank(rawUrl)) {
    issues.push(`Missing ${ZOHO_GATEWAY_URL_ENV}.`);
    return {
      configured: false,
      url: null,
      hasSecret,
      brand,
      hasBrand: brandConfigured,
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
      hasSecret,
      brand,
      hasBrand: brandConfigured,
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
      hasSecret,
      brand,
      hasBrand: brandConfigured,
      issues: Object.freeze(issues),
    };
  }

  return {
    configured: true,
    url: trimmed,
    hasSecret,
    brand,
    hasBrand: brandConfigured,
    issues: Object.freeze(issues),
  };
}

/** Pure: build the headers the gateway expects. NEVER log this object
 *  verbatim — use stripZohoSecret. */
export function buildZohoGatewayHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-luma-source": "luma",
  };
  const rawSecret = env[ZOHO_GATEWAY_SECRET_ENV];
  const rawBrand = env[ZOHO_GATEWAY_BRAND_ENV];
  if (isNonBlank(rawSecret)) {
    headers["x-internal-token"] = (rawSecret as string).trim();
  }
  if (isNonBlank(rawBrand)) {
    headers["x-brand"] = (rawBrand as string).trim();
  }
  return headers;
}

/** Pure: redact the auth header from a headers object for safe logging.
 *  Covers the current X-Internal-Token name + the deprecated ZOHO-1
 *  x-luma-zoho-secret naming. */
export function stripZohoSecret<T extends Record<string, unknown>>(headers: T): T {
  const out: Record<string, unknown> = { ...headers };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "x-internal-token") out[key] = "[REDACTED]";
    if (key.toLowerCase() === "x-luma-zoho-secret") out[key] = "[REDACTED]";
    if (key.toLowerCase() === "authorization") out[key] = "[REDACTED]";
  }
  return out as T;
}

/** Pure: map a fetch / HTTP error into a ZohoGatewayHealthStatus. */
export function mapZohoGatewayError(input: {
  thrown?: unknown;
  httpStatus?: number | null;
}): { status: ZohoGatewayHealthStatus; message: string } {
  if (input.thrown != null) {
    const msg = input.thrown instanceof Error ? input.thrown.message : String(input.thrown);
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
        : "Gateway request failed.",
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

// ─── Live probes ──────────────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** Live: probe /health (open endpoint). Returns the first 2xx as
 *  CONNECTED. */
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

/** Live: probe /status with X-Internal-Token + optional X-Brand. Parses
 *  the gateway's `brands[]` response and returns a structured result
 *  the settings page consumes. */
export async function fetchZohoBrandStatus(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  paths?: readonly string[];
}): Promise<ZohoBrandStatusResult> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const paths = opts?.paths ?? ZOHO_GATEWAY_STATUS_PATHS;

  const cfg = validateZohoGatewayConfig(env);
  if (!cfg.configured) {
    return { kind: "NOT_CONFIGURED", message: cfg.issues[0] ?? "Gateway not configured." };
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
      if (r.status === 401 || r.status === 403) {
        return {
          kind: "UNAUTHORIZED",
          httpStatus: r.status,
          message: `Gateway rejected the request with HTTP ${r.status}. Verify ${ZOHO_GATEWAY_SECRET_ENV}.`,
        };
      }
      if (r.status < 200 || r.status >= 300) {
        lastNon404Error = { status: r.status, path };
        continue;
      }
      const body = (await r.json().catch(() => null)) as unknown;
      const brands = extractBrands(body);
      if (brands.length === 0) {
        return {
          kind: "NONE_RETURNED",
          message: "Gateway responded but reported no brands.",
        };
      }
      return resolveBrandSelection(brands, cfg.brand);
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
  return {
    kind: "GATEWAY_LACKS_ENDPOINT",
    probedPaths: Object.freeze(triedPaths),
    message: `Gateway has no /status endpoint at any of: ${triedPaths.join(", ")}.`,
  };
}

/** Pure: pick the configured brand from the list, or report
 *  NEEDS_SELECTION when no brand is configured and multiple exist. */
export function resolveBrandSelection(
  brands: readonly ZohoBrand[],
  configuredBrand: string | null,
): ZohoBrandStatusResult {
  if (brands.length === 0) {
    return { kind: "NONE_RETURNED", message: "Gateway returned an empty brands list." };
  }
  if (configuredBrand) {
    const found = brands.find(
      (b) => b.brandKey.toLowerCase() === configuredBrand.toLowerCase(),
    );
    if (!found) {
      return {
        kind: "BRAND_NOT_FOUND",
        configuredBrand,
        brands,
        message: `Configured brand "${configuredBrand}" not present in gateway brand list.`,
      };
    }
    const expired = found.products.filter((p) => p.tokenStatus === "expired");
    if (expired.length > 0) {
      return {
        kind: "NEEDS_REAUTH",
        brand: found,
        brands,
        expiredProducts: Object.freeze(expired),
        message: `Brand "${found.brandKey}" found but ${expired.length} product token${expired.length === 1 ? "" : "s"} expired. Re-authorize on the gateway.`,
      };
    }
    return {
      kind: "OK",
      brand: found,
      brands,
      message: `Brand "${found.brandKey}" found; tokens are valid.`,
    };
  }
  if (brands.length === 1 && brands[0]) {
    const only = brands[0];
    const expired = only.products.filter((p) => p.tokenStatus === "expired");
    if (expired.length > 0) {
      return {
        kind: "NEEDS_REAUTH",
        brand: only,
        brands,
        expiredProducts: Object.freeze(expired),
        message: `Only brand "${only.brandKey}" found but ${expired.length} product token${expired.length === 1 ? "" : "s"} expired.`,
      };
    }
    return {
      kind: "OK",
      brand: only,
      brands,
      message: `One brand "${only.brandKey}" available; tokens valid.`,
    };
  }
  return {
    kind: "NEEDS_SELECTION",
    brands,
    message: `${brands.length} brands available; set ${ZOHO_GATEWAY_BRAND_ENV} on Luma to pick one.`,
  };
}

/** Pure: extract a brand list from the gateway's /status JSON. Tolerates
 *  the documented shapes: { brands: [...] }, { data: [...] }, or a
 *  bare array. Per-brand fields recognised:
 *    - name / brand / brandKey  → brandKey
 *    - zoho_org_id / org_id     → organizationId
 *    - region                   → region
 *    - status                   → status
 *    - products[].product       → product name
 *    - products[].enabled       → boolean
 *    - products[].token_status  → "valid"|"expired"|"missing"
 *    - products[].expires_at    → ISO timestamp
 */
export function extractBrands(body: unknown): ZohoBrand[] {
  let candidates: unknown[] = [];
  if (Array.isArray(body)) {
    candidates = body;
  } else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.brands)) candidates = obj.brands;
    else if (Array.isArray(obj.data)) candidates = obj.data;
    else if (Array.isArray(obj.organizations)) candidates = obj.organizations;
    else if (Array.isArray(obj.items)) candidates = obj.items;
  }
  const out: ZohoBrand[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    const brandKey =
      pickString(row, "name") ??
      pickString(row, "brand") ??
      pickString(row, "brandKey") ??
      pickString(row, "brand_key");
    if (!brandKey) continue;
    const organizationId =
      pickString(row, "zoho_org_id") ??
      pickString(row, "org_id") ??
      pickString(row, "organization_id") ??
      pickString(row, "organizationId");
    const region = pickString(row, "region");
    const status = pickString(row, "status");
    const productsRaw = Array.isArray(row.products) ? row.products : [];
    const products: ZohoBrandProduct[] = [];
    for (const p of productsRaw) {
      if (!p || typeof p !== "object") continue;
      const prow = p as Record<string, unknown>;
      const product = pickString(prow, "product") ?? pickString(prow, "name");
      if (!product) continue;
      const enabled = prow.enabled === true;
      const tokenStatusRaw =
        pickString(prow, "token_status") ?? pickString(prow, "tokenStatus") ?? "unknown";
      const tokenStatus = normalizeTokenStatus(tokenStatusRaw);
      const expiresAt = pickString(prow, "expires_at") ?? pickString(prow, "expiresAt");
      products.push({
        product,
        enabled,
        tokenStatus,
        expiresAt: expiresAt ?? null,
      });
    }
    out.push({
      brandKey,
      organizationId: organizationId ?? null,
      region: region ?? null,
      status: status ?? null,
      products: Object.freeze(products),
      raw: row,
    });
  }
  return out;
}

function normalizeTokenStatus(input: string): ZohoBrandProductTokenStatus {
  const v = input.trim().toLowerCase();
  if (v === "valid") return "valid";
  if (v === "expired") return "expired";
  if (v === "missing") return "missing";
  return "unknown";
}

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

// ─── Overall readiness derivation ─────────────────────────────────────────

/** Pure: combine the health + brand-status results into a single
 *  ZohoReadiness label the settings page renders. */
export function deriveZohoReadiness(input: {
  health: ZohoGatewayHealthResult;
  brand: ZohoBrandStatusResult | null;
}): { readiness: ZohoReadiness; message: string } {
  const { health, brand } = input;
  if (health.status === "NOT_CONFIGURED")
    return { readiness: "NOT_CONFIGURED", message: health.message };
  if (health.status === "UNREACHABLE")
    return { readiness: "UNREACHABLE", message: health.message };
  if (health.status === "ERROR")
    return { readiness: "ERROR", message: health.message };
  // health.status === "CONNECTED" from here on.
  if (!brand) {
    return {
      readiness: "CONNECTED_HEALTH_ONLY",
      message: "Gateway /health is reachable; brand status not probed.",
    };
  }
  switch (brand.kind) {
    case "OK":
      return {
        readiness: "READY_FOR_DRY_RUN",
        message: brand.message,
      };
    case "NEEDS_REAUTH":
      return { readiness: "NEEDS_REAUTH", message: brand.message };
    case "NEEDS_SELECTION":
      return { readiness: "NEEDS_SELECTION", message: brand.message };
    case "BRAND_NOT_FOUND":
      return { readiness: "NEEDS_SELECTION", message: brand.message };
    case "NONE_RETURNED":
    case "GATEWAY_LACKS_ENDPOINT":
      return {
        readiness: "CONNECTED_HEALTH_ONLY",
        message: brand.message,
      };
    case "UNAUTHORIZED":
      return { readiness: "ERROR", message: brand.message };
    case "UNREACHABLE":
      return { readiness: "UNREACHABLE", message: brand.message };
    case "NOT_CONFIGURED":
      return { readiness: "NOT_CONFIGURED", message: brand.message };
    case "ERROR":
    default:
      return { readiness: "ERROR", message: brand.message };
  }
}

// ─── Backward-compat shim for ZOHO-1 callers ──────────────────────────────
//
// The verify script + the settings action originally consumed a
// `fetchZohoOrganizations` returning OK / NEEDS_SELECTION /
// NONE_RETURNED / GATEWAY_LACKS_ENDPOINT / UNREACHABLE / ERROR /
// NOT_CONFIGURED. The new gateway contract is brand-based, not
// org-based; this shim maps the new result onto the old shape so the
// verify script keeps working. Pages + actions now read
// fetchZohoBrandStatus directly.

export type ZohoGatewayOrganization = {
  organizationId: string;
  organizationName: string;
  state: string | null;
  raw: Record<string, unknown>;
};

export type ZohoGatewayOrganizationsResult =
  | { kind: "OK"; organizations: readonly ZohoGatewayOrganization[] }
  | { kind: "NEEDS_SELECTION"; organizations: readonly ZohoGatewayOrganization[] }
  | { kind: "NONE_RETURNED"; organizations: readonly [] }
  | { kind: "GATEWAY_LACKS_ENDPOINT"; probedPaths: readonly string[] }
  | { kind: "UNREACHABLE" | "ERROR" | "NOT_CONFIGURED"; message: string };

export async function fetchZohoOrganizations(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  paths?: readonly string[];
}): Promise<ZohoGatewayOrganizationsResult> {
  const result = await fetchZohoBrandStatus(opts);
  switch (result.kind) {
    case "OK":
      return {
        kind: "OK",
        organizations: [brandToOrg(result.brand)],
      };
    case "NEEDS_REAUTH":
      return {
        kind: "OK",
        organizations: [brandToOrg(result.brand)],
      };
    case "NEEDS_SELECTION":
    case "BRAND_NOT_FOUND":
      return {
        kind: "NEEDS_SELECTION",
        organizations: result.brands.map(brandToOrg),
      };
    case "NONE_RETURNED":
      return { kind: "NONE_RETURNED", organizations: [] };
    case "GATEWAY_LACKS_ENDPOINT":
      return { kind: "GATEWAY_LACKS_ENDPOINT", probedPaths: result.probedPaths };
    case "UNAUTHORIZED":
      return { kind: "ERROR", message: result.message };
    case "UNREACHABLE":
    case "ERROR":
    case "NOT_CONFIGURED":
      return { kind: result.kind, message: result.message };
  }
}

function brandToOrg(b: ZohoBrand): ZohoGatewayOrganization {
  return {
    organizationId: b.organizationId ?? b.brandKey,
    organizationName: b.brandKey,
    state: b.status,
    raw: b.raw,
  };
}

/** Pure alias kept for callers that still import `extractOrganizations`
 *  from the ZOHO-1 surface. Maps brands → orgs via brandToOrg. */
export function extractOrganizations(body: unknown): ZohoGatewayOrganization[] {
  return extractBrands(body).map(brandToOrg);
}
