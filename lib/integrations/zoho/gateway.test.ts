// ZOHO-GW-2 — gateway client tests. All tests use fetch mocks; no live
// network calls. Validates: config validation, header construction
// (X-Internal-Token + X-Brand), error mapping, health probe, /status
// brand parsing, brand selection + token-expiry → readiness derivation,
// secret redaction. Static guards forbid Zoho write methods and any
// import of the legacy direct-OAuth client.

import { describe, expect, it } from "vitest";
import {
  buildZohoGatewayHeaders,
  checkZohoGatewayHealth,
  deriveZohoReadiness,
  extractBrands,
  extractOrganizations,
  fetchZohoBrandStatus,
  fetchZohoOrganizations,
  isNonBlank,
  mapZohoGatewayError,
  resolveBrandSelection,
  stripZohoSecret,
  validateZohoGatewayConfig,
  type ZohoBrand,
  ZOHO_GATEWAY_BRAND_ENV,
  ZOHO_GATEWAY_SECRET_ENV,
  ZOHO_GATEWAY_URL_ENV,
} from "@/lib/integrations/zoho/gateway";

const baseUrl = "http://192.168.1.205:8000";

function envWith(
  url: string | undefined,
  secret?: string,
  brand?: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (url !== undefined) env[ZOHO_GATEWAY_URL_ENV] = url;
  if (secret !== undefined) env[ZOHO_GATEWAY_SECRET_ENV] = secret;
  if (brand !== undefined) env[ZOHO_GATEWAY_BRAND_ENV] = brand;
  return env;
}

// ─── Config validation ────────────────────────────────────────────────────

describe("ZOHO-GW-2 · validateZohoGatewayConfig", () => {
  it("missing URL → not configured", () => {
    const r = validateZohoGatewayConfig({});
    expect(r.configured).toBe(false);
    expect(r.issues[0]).toMatch(/Missing ZOHO_INTEGRATION_URL/);
  });

  it("whitespace URL → not configured", () => {
    const r = validateZohoGatewayConfig(envWith("   "));
    expect(r.configured).toBe(false);
  });

  it("non-URL → not configured", () => {
    const r = validateZohoGatewayConfig(envWith("not a url"));
    expect(r.configured).toBe(false);
  });

  it("unsupported protocol → not configured", () => {
    const r = validateZohoGatewayConfig(envWith("ftp://example.com"));
    expect(r.configured).toBe(false);
  });

  it("well-formed URL → configured", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl));
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.url).toBe(baseUrl);
  });

  it("trims trailing slashes", () => {
    const r = validateZohoGatewayConfig(envWith(`${baseUrl}///`));
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.url).toBe(baseUrl);
  });

  it("missing secret allowed; hasSecret=false", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl));
    expect(r.hasSecret).toBe(false);
  });

  it("whitespace secret reads as missing", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "  "));
    expect(r.hasSecret).toBe(false);
  });

  it("non-blank secret → hasSecret=true", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "s3cr3t"));
    expect(r.hasSecret).toBe(true);
  });

  it("missing brand allowed; hasBrand=false; brand=null", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "s3cr3t"));
    expect(r.hasBrand).toBe(false);
    expect(r.brand).toBeNull();
  });

  it("whitespace brand reads as missing", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "s3cr3t", "  "));
    expect(r.hasBrand).toBe(false);
    expect(r.brand).toBeNull();
  });

  it("brand trimmed when present", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "s3cr3t", "  haute_brands "));
    expect(r.hasBrand).toBe(true);
    expect(r.brand).toBe("haute_brands");
  });
});

// ─── isNonBlank ───────────────────────────────────────────────────────────

describe("ZOHO-GW-2 · isNonBlank", () => {
  it("false for null / undefined / empty / whitespace", () => {
    expect(isNonBlank(null)).toBe(false);
    expect(isNonBlank(undefined)).toBe(false);
    expect(isNonBlank("")).toBe(false);
    expect(isNonBlank("   ")).toBe(false);
  });
  it("true for any non-whitespace content", () => {
    expect(isNonBlank("x")).toBe(true);
  });
});

// ─── Header construction ──────────────────────────────────────────────────

describe("ZOHO-GW-2 · buildZohoGatewayHeaders", () => {
  it("includes X-Internal-Token when secret configured", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "s3cr3t"));
    expect(h["x-internal-token"]).toBe("s3cr3t");
  });

  it("includes X-Brand when brand configured", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "s3cr3t", "haute_brands"));
    expect(h["x-brand"]).toBe("haute_brands");
  });

  it("omits X-Internal-Token when no secret", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl));
    expect(h["x-internal-token"]).toBeUndefined();
  });

  it("omits X-Brand when no brand", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "s3cr3t"));
    expect(h["x-brand"]).toBeUndefined();
  });

  it("trims both secret and brand values", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "  abc  ", "  haute_brands  "));
    expect(h["x-internal-token"]).toBe("abc");
    expect(h["x-brand"]).toBe("haute_brands");
  });

  it("never leaks the secret into another header", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "MY-HIGH-ENTROPY-SECRET-12345", "haute_brands"));
    for (const [k, v] of Object.entries(h)) {
      if (k === "x-internal-token") continue;
      expect(v).not.toContain("MY-HIGH-ENTROPY-SECRET-12345");
    }
  });

  it("no longer sends the legacy x-luma-zoho-secret header", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "s3cr3t", "haute_brands"));
    expect(h["x-luma-zoho-secret"]).toBeUndefined();
  });
});

// ─── Secret redaction ─────────────────────────────────────────────────────

describe("ZOHO-GW-2 · stripZohoSecret", () => {
  it("redacts x-internal-token (lowercase)", () => {
    const out = stripZohoSecret({ "x-internal-token": "supersecret", other: "ok" });
    expect(out["x-internal-token"]).toBe("[REDACTED]");
    expect(out.other).toBe("ok");
  });

  it("redacts X-Internal-Token (capitalised)", () => {
    const out = stripZohoSecret({ "X-Internal-Token": "supersecret" });
    expect(out["X-Internal-Token"]).toBe("[REDACTED]");
  });

  it("still redacts the legacy x-luma-zoho-secret header", () => {
    const out = stripZohoSecret({ "x-luma-zoho-secret": "old-secret" });
    expect(out["x-luma-zoho-secret"]).toBe("[REDACTED]");
  });

  it("redacts Authorization header", () => {
    const out = stripZohoSecret({ Authorization: "Bearer xyz" });
    expect(out.Authorization).toBe("[REDACTED]");
  });

  it("does not mutate the input", () => {
    const src = { "x-internal-token": "supersecret" };
    const out = stripZohoSecret(src);
    expect(src["x-internal-token"]).toBe("supersecret");
    expect(out).not.toBe(src);
  });
});

// ─── Error mapping ────────────────────────────────────────────────────────

describe("ZOHO-GW-2 · mapZohoGatewayError", () => {
  it("ECONNREFUSED → UNREACHABLE", () => {
    const r = mapZohoGatewayError({ thrown: new Error("connect ECONNREFUSED 127.0.0.1:9503") });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("ENOTFOUND → UNREACHABLE", () => {
    const r = mapZohoGatewayError({ thrown: new TypeError("fetch failed: ENOTFOUND") });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("HTTP 2xx → CONNECTED", () => {
    expect(mapZohoGatewayError({ httpStatus: 204 }).status).toBe("CONNECTED");
  });

  it("HTTP 500 → ERROR", () => {
    expect(mapZohoGatewayError({ httpStatus: 500 }).status).toBe("ERROR");
  });

  it("never includes the secret in the error message", () => {
    const r = mapZohoGatewayError({
      thrown: new Error("connect ECONNREFUSED with secret=abcdef"),
    });
    expect(r.message).not.toContain("abcdef");
  });
});

// ─── Health probe ─────────────────────────────────────────────────────────

describe("ZOHO-GW-2 · checkZohoGatewayHealth", () => {
  it("NOT_CONFIGURED with no URL", async () => {
    const r = await checkZohoGatewayHealth({ env: {} });
    expect(r.status).toBe("NOT_CONFIGURED");
  });

  it("CONNECTED on first 200", async () => {
    const fetchImpl = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health"],
    });
    expect(r.status).toBe("CONNECTED");
    expect(r.httpStatus).toBe(200);
    expect(r.probedPath).toBe("/health");
  });

  it("UNREACHABLE on ECONNREFUSED", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.205:8000");
    }) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health"],
    });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("ERROR on HTTP 500", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health"],
    });
    expect(r.status).toBe("ERROR");
    expect(r.httpStatus).toBe(500);
  });
});

// ─── /status brand parsing (extractBrands) ────────────────────────────────

const HAUTE_STATUS_PAYLOAD = {
  version: "1.3.2",
  brands: [
    {
      name: "boomin_brands",
      status: "active",
      zoho_org_id: "842972986",
      region: "us",
      products: [
        { product: "books", enabled: true, token_status: "expired", expires_at: "2026-04-27T20:40:25Z" },
        { product: "inventory", enabled: true, token_status: "expired", expires_at: "2026-03-27T17:40:35Z" },
      ],
    },
    {
      name: "haute_brands",
      status: "active",
      zoho_org_id: "883647111",
      region: "us",
      products: [
        { product: "books", enabled: true, token_status: "expired", expires_at: "2026-05-09T01:35:36Z" },
        { product: "crm", enabled: true, token_status: "expired", expires_at: "2026-05-09T01:35:44Z" },
        { product: "expense", enabled: true, token_status: "expired", expires_at: "2026-05-09T01:35:47Z" },
        { product: "inventory", enabled: true, token_status: "expired", expires_at: "2026-05-14T16:03:58Z" },
      ],
    },
    {
      name: "nirvana_kulture",
      status: "active",
      zoho_org_id: "710610434",
      region: "us",
      products: [
        { product: "books", enabled: true, token_status: "valid", expires_at: "2026-05-14T21:19:52Z" },
      ],
    },
  ],
};

describe("ZOHO-GW-2 · extractBrands", () => {
  it("parses haute_brands org id from a realistic /status payload", () => {
    const brands = extractBrands(HAUTE_STATUS_PAYLOAD);
    expect(brands.map((b) => b.brandKey)).toEqual([
      "boomin_brands",
      "haute_brands",
      "nirvana_kulture",
    ]);
    const haute = brands.find((b) => b.brandKey === "haute_brands");
    expect(haute?.organizationId).toBe("883647111");
    expect(haute?.region).toBe("us");
    expect(haute?.products.map((p) => p.product)).toEqual([
      "books",
      "crm",
      "expense",
      "inventory",
    ]);
    expect(haute?.products.every((p) => p.tokenStatus === "expired")).toBe(true);
  });

  it("tolerates a bare array shape", () => {
    const out = extractBrands([
      { name: "x", zoho_org_id: "1", products: [] },
    ]);
    expect(out[0]?.brandKey).toBe("x");
    expect(out[0]?.organizationId).toBe("1");
  });

  it("tolerates a { data: [...] } shape", () => {
    const out = extractBrands({ data: [{ name: "y", products: [] }] });
    expect(out[0]?.brandKey).toBe("y");
    expect(out[0]?.organizationId).toBeNull();
  });

  it("drops entries with no brand key", () => {
    const out = extractBrands([{ zoho_org_id: "headless", products: [] }]);
    expect(out).toEqual([]);
  });

  it("normalizes unknown token_status to 'unknown'", () => {
    const out = extractBrands([
      {
        name: "x",
        products: [{ product: "books", enabled: true, token_status: "weird" }],
      },
    ]);
    expect(out[0]?.products[0]?.tokenStatus).toBe("unknown");
  });
});

// ─── Brand selection logic ────────────────────────────────────────────────

const HAUTE_BRAND: ZohoBrand = {
  brandKey: "haute_brands",
  organizationId: "883647111",
  region: "us",
  status: "active",
  products: [
    { product: "books", enabled: true, tokenStatus: "expired", expiresAt: null },
    { product: "inventory", enabled: true, tokenStatus: "expired", expiresAt: null },
  ],
  raw: {},
};
const NIRVANA_BRAND: ZohoBrand = {
  brandKey: "nirvana_kulture",
  organizationId: "710610434",
  region: "us",
  status: "active",
  products: [{ product: "books", enabled: true, tokenStatus: "valid", expiresAt: null }],
  raw: {},
};
const HEALTHY_HAUTE: ZohoBrand = {
  ...HAUTE_BRAND,
  products: HAUTE_BRAND.products.map((p) => ({ ...p, tokenStatus: "valid" as const })),
};

describe("ZOHO-GW-2 · resolveBrandSelection", () => {
  it("OK when configured brand exists and all tokens valid", () => {
    const r = resolveBrandSelection([HEALTHY_HAUTE, NIRVANA_BRAND], "haute_brands");
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") expect(r.brand.organizationId).toBe("883647111");
  });

  it("NEEDS_REAUTH when configured brand exists but any token expired", () => {
    const r = resolveBrandSelection([HAUTE_BRAND, NIRVANA_BRAND], "haute_brands");
    expect(r.kind).toBe("NEEDS_REAUTH");
    if (r.kind === "NEEDS_REAUTH") {
      expect(r.brand.brandKey).toBe("haute_brands");
      expect(r.expiredProducts.length).toBe(2);
    }
  });

  it("matches configured brand case-insensitively", () => {
    const r = resolveBrandSelection([HEALTHY_HAUTE, NIRVANA_BRAND], "HAUTE_BRANDS");
    expect(r.kind).toBe("OK");
  });

  it("BRAND_NOT_FOUND when configured brand not present", () => {
    const r = resolveBrandSelection([NIRVANA_BRAND], "haute_brands");
    expect(r.kind).toBe("BRAND_NOT_FOUND");
  });

  it("NEEDS_SELECTION when no brand configured and multiple available", () => {
    const r = resolveBrandSelection([HAUTE_BRAND, NIRVANA_BRAND], null);
    expect(r.kind).toBe("NEEDS_SELECTION");
  });

  it("OK when single brand + valid tokens + no brand configured", () => {
    const r = resolveBrandSelection([HEALTHY_HAUTE], null);
    expect(r.kind).toBe("OK");
  });

  it("NEEDS_REAUTH when single brand + expired tokens + no brand configured", () => {
    const r = resolveBrandSelection([HAUTE_BRAND], null);
    expect(r.kind).toBe("NEEDS_REAUTH");
  });

  it("NONE_RETURNED for empty input", () => {
    const r = resolveBrandSelection([], null);
    expect(r.kind).toBe("NONE_RETURNED");
  });
});

// ─── fetchZohoBrandStatus integration ─────────────────────────────────────

describe("ZOHO-GW-2 · fetchZohoBrandStatus", () => {
  it("returns NEEDS_REAUTH against the real /status payload with brand=haute_brands", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(HAUTE_STATUS_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("NEEDS_REAUTH");
    if (r.kind === "NEEDS_REAUTH") {
      expect(r.brand.organizationId).toBe("883647111");
      expect(r.expiredProducts.length).toBe(4);
    }
  });

  it("returns NEEDS_SELECTION when no brand configured", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(HAUTE_STATUS_PAYLOAD), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("NEEDS_SELECTION");
  });

  it("sends X-Internal-Token + X-Brand headers", async () => {
    let captured: Headers | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ brands: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(captured).not.toBeNull();
    expect(captured!.get("x-internal-token")).toBe("s3cr3t");
    expect(captured!.get("x-brand")).toBe("haute_brands");
  });

  it("UNAUTHORIZED on 401 from /status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "missing token" }), { status: 401 })) as unknown as typeof fetch;
    const r = await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("UNAUTHORIZED");
  });

  it("GATEWAY_LACKS_ENDPOINT when every probed path 404s", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status", "/api/status"],
    });
    expect(r.kind).toBe("GATEWAY_LACKS_ENDPOINT");
  });

  it("UNREACHABLE on ECONNREFUSED", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.205:8000");
    }) as unknown as typeof fetch;
    const r = await fetchZohoBrandStatus({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("UNREACHABLE");
  });

  it("NOT_CONFIGURED when env empty", async () => {
    const r = await fetchZohoBrandStatus({ env: {} });
    expect(r.kind).toBe("NOT_CONFIGURED");
  });
});

// ─── deriveZohoReadiness ──────────────────────────────────────────────────

describe("ZOHO-GW-2 · deriveZohoReadiness", () => {
  it("NOT_CONFIGURED bubbles up from health", () => {
    const r = deriveZohoReadiness({
      health: { status: "NOT_CONFIGURED", url: null, probedPath: null, httpStatus: null, message: "x", elapsedMs: null },
      brand: null,
    });
    expect(r.readiness).toBe("NOT_CONFIGURED");
  });

  it("UNREACHABLE bubbles up from health", () => {
    const r = deriveZohoReadiness({
      health: { status: "UNREACHABLE", url: null, probedPath: null, httpStatus: null, message: "x", elapsedMs: null },
      brand: null,
    });
    expect(r.readiness).toBe("UNREACHABLE");
  });

  it("CONNECTED_HEALTH_ONLY when brand not probed", () => {
    const r = deriveZohoReadiness({
      health: { status: "CONNECTED", url: baseUrl, probedPath: "/health", httpStatus: 200, message: "ok", elapsedMs: 50 },
      brand: null,
    });
    expect(r.readiness).toBe("CONNECTED_HEALTH_ONLY");
  });

  it("READY_FOR_DRY_RUN when brand OK", () => {
    const r = deriveZohoReadiness({
      health: { status: "CONNECTED", url: baseUrl, probedPath: "/health", httpStatus: 200, message: "ok", elapsedMs: 50 },
      brand: { kind: "OK", brand: HEALTHY_HAUTE, brands: [HEALTHY_HAUTE], message: "ok" },
    });
    expect(r.readiness).toBe("READY_FOR_DRY_RUN");
  });

  it("NEEDS_REAUTH when health is CONNECTED but tokens expired", () => {
    const r = deriveZohoReadiness({
      health: { status: "CONNECTED", url: baseUrl, probedPath: "/health", httpStatus: 200, message: "ok", elapsedMs: 50 },
      brand: {
        kind: "NEEDS_REAUTH",
        brand: HAUTE_BRAND,
        brands: [HAUTE_BRAND],
        expiredProducts: HAUTE_BRAND.products,
        message: "expired",
      },
    });
    expect(r.readiness).toBe("NEEDS_REAUTH");
  });

  it("NEEDS_SELECTION when multi-brand and no brand env", () => {
    const r = deriveZohoReadiness({
      health: { status: "CONNECTED", url: baseUrl, probedPath: "/health", httpStatus: 200, message: "ok", elapsedMs: 50 },
      brand: { kind: "NEEDS_SELECTION", brands: [HAUTE_BRAND, NIRVANA_BRAND], message: "pick one" },
    });
    expect(r.readiness).toBe("NEEDS_SELECTION");
  });

  it("healthy gateway + expired tokens is NOT READY_FOR_DRY_RUN", () => {
    const r = deriveZohoReadiness({
      health: { status: "CONNECTED", url: baseUrl, probedPath: "/health", httpStatus: 200, message: "ok", elapsedMs: 50 },
      brand: {
        kind: "NEEDS_REAUTH",
        brand: HAUTE_BRAND,
        brands: [HAUTE_BRAND],
        expiredProducts: HAUTE_BRAND.products,
        message: "expired",
      },
    });
    expect(r.readiness).not.toBe("READY_FOR_DRY_RUN");
  });
});

// ─── Backward-compat shim: fetchZohoOrganizations ─────────────────────────

describe("ZOHO-GW-2 · fetchZohoOrganizations (legacy shim)", () => {
  it("OK with one org when brand OK", async () => {
    const allValid = {
      brands: [
        {
          ...HAUTE_STATUS_PAYLOAD.brands[1],
          products: HAUTE_STATUS_PAYLOAD.brands[1]!.products.map((p) => ({ ...p, token_status: "valid" })),
        },
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(allValid), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") expect(r.organizations[0]?.organizationId).toBe("883647111");
  });

  it("OK with one org even when NEEDS_REAUTH (legacy callers don't gate on tokens)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(HAUTE_STATUS_PAYLOAD), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl, "s3cr3t", "haute_brands"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("OK");
  });

  it("NEEDS_SELECTION when multi-brand and no brand env", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(HAUTE_STATUS_PAYLOAD), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl, "s3cr3t"),
      fetchImpl,
      paths: ["/status"],
    });
    expect(r.kind).toBe("NEEDS_SELECTION");
    if (r.kind === "NEEDS_SELECTION") expect(r.organizations.length).toBe(3);
  });
});

describe("ZOHO-GW-2 · extractOrganizations (legacy alias)", () => {
  it("maps the real /status payload's brands to a single haute_brands org-shape row", () => {
    const out = extractOrganizations(HAUTE_STATUS_PAYLOAD);
    expect(out.length).toBe(3);
    const haute = out.find((o) => o.organizationName === "haute_brands");
    expect(haute?.organizationId).toBe("883647111");
  });
});

// ─── Static guards ────────────────────────────────────────────────────────

describe("ZOHO-GW-2 · static guards", () => {
  it("gateway client never imports the legacy direct-OAuth client", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "gateway.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\/client"/);
    expect(src).not.toMatch(/refresh_token/);
    expect(src).not.toMatch(/access_token/);
  });

  it("gateway client uses only GET (no Zoho-write methods anywhere)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "gateway.ts"), "utf8");
    expect(src).not.toMatch(/method:\s*"POST"/);
    expect(src).not.toMatch(/method:\s*"PUT"/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).not.toMatch(/method:\s*"PATCH"/);
  });

  it("gateway client carries no item / customer / sales-order / PO sync logic", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "gateway.ts"), "utf8");
    // No /items, /customers, /salesorders, /purchaseorders endpoints
    // — sync paths must land in their own modules.
    expect(src).not.toMatch(/\/items/);
    expect(src).not.toMatch(/\/customers/);
    expect(src).not.toMatch(/\/salesorders/);
    expect(src).not.toMatch(/\/purchaseorders/);
  });
});
