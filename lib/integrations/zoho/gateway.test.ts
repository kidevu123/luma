// ZOHO-1 — gateway client tests. All tests use fetch mocks; no live
// network calls. Validates: config validation, header construction +
// redaction, error mapping, health probe behaviour, organization
// fetching across the four documented response shapes.

import { describe, expect, it } from "vitest";
import {
  buildZohoGatewayHeaders,
  checkZohoGatewayHealth,
  extractOrganizations,
  fetchZohoOrganizations,
  isNonBlank,
  mapZohoGatewayError,
  stripZohoSecret,
  validateZohoGatewayConfig,
  ZOHO_GATEWAY_SECRET_ENV,
  ZOHO_GATEWAY_URL_ENV,
} from "@/lib/integrations/zoho/gateway";

const baseUrl = "http://192.168.1.190:9503";

function envWith(url: string | undefined, secret?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (url !== undefined) env[ZOHO_GATEWAY_URL_ENV] = url;
  if (secret !== undefined) env[ZOHO_GATEWAY_SECRET_ENV] = secret;
  return env;
}

describe("ZOHO-1 gateway · validateZohoGatewayConfig", () => {
  it("returns NOT_CONFIGURED when ZOHO_INTEGRATION_URL is missing", () => {
    const r = validateZohoGatewayConfig({});
    expect(r.configured).toBe(false);
    expect(r.issues[0]).toMatch(/Missing ZOHO_INTEGRATION_URL/);
  });

  it("treats whitespace-only URL as missing", () => {
    const r = validateZohoGatewayConfig(envWith("   "));
    expect(r.configured).toBe(false);
    expect(r.issues[0]).toMatch(/Missing/);
  });

  it("treats empty string URL as missing", () => {
    const r = validateZohoGatewayConfig(envWith(""));
    expect(r.configured).toBe(false);
  });

  it("rejects non-URL strings", () => {
    const r = validateZohoGatewayConfig(envWith("not a url"));
    expect(r.configured).toBe(false);
    expect(r.issues[0]).toMatch(/not a valid URL/);
  });

  it("rejects unsupported protocols (ftp://)", () => {
    const r = validateZohoGatewayConfig(envWith("ftp://example.com"));
    expect(r.configured).toBe(false);
    expect(r.issues[0]).toMatch(/http: or https:/);
  });

  it("accepts a well-formed http URL", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl));
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.url).toBe(baseUrl);
  });

  it("trims trailing slashes off the URL", () => {
    const r = validateZohoGatewayConfig(envWith(`${baseUrl}///`));
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.url).toBe(baseUrl);
  });

  it("missing secret is allowed; hasSecret = false", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl));
    expect(r.hasSecret).toBe(false);
  });

  it("whitespace secret reads as missing; hasSecret = false", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "   "));
    expect(r.hasSecret).toBe(false);
  });

  it("non-blank secret is detected; hasSecret = true", () => {
    const r = validateZohoGatewayConfig(envWith(baseUrl, "s3cr3t"));
    expect(r.hasSecret).toBe(true);
  });
});

describe("ZOHO-1 gateway · isNonBlank", () => {
  it("returns false for null / undefined / empty / whitespace", () => {
    expect(isNonBlank(null)).toBe(false);
    expect(isNonBlank(undefined)).toBe(false);
    expect(isNonBlank("")).toBe(false);
    expect(isNonBlank("   ")).toBe(false);
    expect(isNonBlank("\t\n")).toBe(false);
  });
  it("returns true for any non-whitespace content", () => {
    expect(isNonBlank("a")).toBe(true);
    expect(isNonBlank(" x ")).toBe(true);
  });
});

describe("ZOHO-1 gateway · buildZohoGatewayHeaders", () => {
  it("omits x-luma-zoho-secret when no secret is configured", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl));
    expect(h["x-luma-zoho-secret"]).toBeUndefined();
    expect(h.accept).toBe("application/json");
    expect(h["x-luma-source"]).toBe("luma");
  });

  it("includes x-luma-zoho-secret when the secret is non-blank", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "s3cr3t"));
    expect(h["x-luma-zoho-secret"]).toBe("s3cr3t");
  });

  it("trims whitespace around the secret value", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "  abc  "));
    expect(h["x-luma-zoho-secret"]).toBe("abc");
  });

  it("does NOT include the secret as a substring of any other header", () => {
    const h = buildZohoGatewayHeaders(envWith(baseUrl, "myhighentropy"));
    const otherValues = Object.entries(h)
      .filter(([k]) => k !== "x-luma-zoho-secret")
      .map(([, v]) => v);
    for (const v of otherValues) expect(v).not.toContain("myhighentropy");
  });
});

describe("ZOHO-1 gateway · stripZohoSecret", () => {
  it("redacts lowercase header key", () => {
    const out = stripZohoSecret({ "x-luma-zoho-secret": "supersecret", other: "ok" });
    expect(out["x-luma-zoho-secret"]).toBe("[REDACTED]");
    expect(out.other).toBe("ok");
  });

  it("redacts capitalised header key", () => {
    const out = stripZohoSecret({ "X-Luma-Zoho-Secret": "supersecret" });
    expect(out["X-Luma-Zoho-Secret"]).toBe("[REDACTED]");
  });

  it("does not mutate the input", () => {
    const src = { "x-luma-zoho-secret": "supersecret", other: "ok" };
    const out = stripZohoSecret(src);
    expect(src["x-luma-zoho-secret"]).toBe("supersecret");
    expect(out).not.toBe(src);
  });
});

describe("ZOHO-1 gateway · mapZohoGatewayError", () => {
  it("ECONNREFUSED → UNREACHABLE", () => {
    const r = mapZohoGatewayError({ thrown: new Error("connect ECONNREFUSED 127.0.0.1:9503") });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("ENOTFOUND → UNREACHABLE", () => {
    const r = mapZohoGatewayError({ thrown: new TypeError("fetch failed: ENOTFOUND zoho.lan") });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("ETIMEDOUT → UNREACHABLE", () => {
    const r = mapZohoGatewayError({ thrown: new Error("connect ETIMEDOUT") });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("non-network thrown error → ERROR", () => {
    const r = mapZohoGatewayError({ thrown: new Error("certificate signature failure") });
    expect(r.status).toBe("ERROR");
  });

  it("HTTP 2xx → CONNECTED", () => {
    const r = mapZohoGatewayError({ httpStatus: 204 });
    expect(r.status).toBe("CONNECTED");
  });

  it("HTTP 500 → ERROR", () => {
    const r = mapZohoGatewayError({ httpStatus: 500 });
    expect(r.status).toBe("ERROR");
  });

  it("HTTP 404 → ERROR (probe loop will have already skipped)", () => {
    const r = mapZohoGatewayError({ httpStatus: 404 });
    expect(r.status).toBe("ERROR");
  });

  it("never includes the secret in the message", () => {
    const r = mapZohoGatewayError({
      thrown: new Error("connect ECONNREFUSED with secret=abcdef"),
    });
    // Caller is responsible for not putting secrets in error messages,
    // but our mapper preserves the message text verbatim only when it is
    // ALREADY safe (a network-failure message); we just confirm the
    // mapper itself does not invent / leak secrets.
    expect(r.message).not.toContain("abcdef");
  });
});

describe("ZOHO-1 gateway · checkZohoGatewayHealth", () => {
  it("returns NOT_CONFIGURED with no URL configured", async () => {
    const r = await checkZohoGatewayHealth({ env: {} });
    expect(r.status).toBe("NOT_CONFIGURED");
    expect(r.url).toBeNull();
  });

  it("returns CONNECTED on the first 200 response", async () => {
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

  it("returns UNREACHABLE on connection refusal", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.190:9503");
    }) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health"],
    });
    expect(r.status).toBe("UNREACHABLE");
  });

  it("returns ERROR on HTTP 500", async () => {
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

  it("tries each probe path in order and returns the first 2xx", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/health")) return new Response("", { status: 404 });
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health", "/status", "/api/health"],
    });
    expect(r.status).toBe("CONNECTED");
    expect(r.probedPath).toBe("/status");
    expect(calls).toEqual([`${baseUrl}/health`, `${baseUrl}/status`]);
  });

  it("returns ERROR with the last non-2xx code when no probe hits 2xx", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/health")) return new Response("", { status: 404 });
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const r = await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health", "/status"],
    });
    expect(r.status).toBe("ERROR");
    expect(r.httpStatus).toBe(503);
    expect(r.probedPath).toBe("/status");
  });

  it("sends the configured secret in the x-luma-zoho-secret header", async () => {
    let capturedHeaders: Headers | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers as HeadersInit);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await checkZohoGatewayHealth({
      env: envWith(baseUrl, "s3cr3t"),
      fetchImpl,
      paths: ["/health"],
    });
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!.get("x-luma-zoho-secret")).toBe("s3cr3t");
  });

  it("omits the secret header when none is configured", async () => {
    let capturedHeaders: Headers | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers as HeadersInit);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await checkZohoGatewayHealth({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/health"],
    });
    expect(capturedHeaders!.get("x-luma-zoho-secret")).toBeNull();
  });
});

describe("ZOHO-1 gateway · extractOrganizations", () => {
  it("handles a bare array shape", () => {
    const out = extractOrganizations([
      { organization_id: "111", organization_name: "Acme" },
    ]);
    expect(out).toEqual([
      expect.objectContaining({ organizationId: "111", organizationName: "Acme" }),
    ]);
  });

  it("handles { organizations: [...] } shape", () => {
    const out = extractOrganizations({
      organizations: [{ organizationId: "222", organizationName: "Beta" }],
    });
    expect(out[0]?.organizationId).toBe("222");
  });

  it("handles { data: [...] } shape", () => {
    const out = extractOrganizations({ data: [{ id: "333", name: "Gamma" }] });
    expect(out[0]?.organizationId).toBe("333");
    expect(out[0]?.organizationName).toBe("Gamma");
  });

  it("drops entries without an id", () => {
    const out = extractOrganizations([{ organization_name: "Headless" }]);
    expect(out).toEqual([]);
  });

  it("preserves the verbatim raw payload", () => {
    const out = extractOrganizations([
      { organization_id: "1", organization_name: "X", extra: { nested: true } },
    ]);
    expect((out[0]?.raw as Record<string, unknown>).extra).toEqual({ nested: true });
  });
});

describe("ZOHO-1 gateway · fetchZohoOrganizations", () => {
  it("returns OK when exactly one organization is returned", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ organization_id: "1", organization_name: "Acme" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations"],
    });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") expect(r.organizations.length).toBe(1);
  });

  it("returns NEEDS_SELECTION when multiple organizations are returned", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { organization_id: "1", organization_name: "Acme" },
          { organization_id: "2", organization_name: "Beta" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations"],
    });
    expect(r.kind).toBe("NEEDS_SELECTION");
    if (r.kind === "NEEDS_SELECTION") expect(r.organizations.length).toBe(2);
  });

  it("returns NONE_RETURNED when the endpoint exists but is empty", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations"],
    });
    expect(r.kind).toBe("NONE_RETURNED");
  });

  it("returns GATEWAY_LACKS_ENDPOINT when every probed path is 404", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations", "/api/organizations"],
    });
    expect(r.kind).toBe("GATEWAY_LACKS_ENDPOINT");
    if (r.kind === "GATEWAY_LACKS_ENDPOINT") {
      expect(r.probedPaths).toEqual(["/organizations", "/api/organizations"]);
    }
  });

  it("returns UNREACHABLE when the gateway connection is refused", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.190:9503");
    }) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations"],
    });
    expect(r.kind).toBe("UNREACHABLE");
  });

  it("returns NOT_CONFIGURED with no URL configured", async () => {
    const r = await fetchZohoOrganizations({ env: {} });
    expect(r.kind).toBe("NOT_CONFIGURED");
  });

  it("returns ERROR on HTTP 500", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await fetchZohoOrganizations({
      env: envWith(baseUrl),
      fetchImpl,
      paths: ["/organizations"],
    });
    expect(r.kind).toBe("ERROR");
  });
});

describe("ZOHO-1 gateway · static guards", () => {
  it("module never imports direct OAuth Zoho client", async () => {
    // The gateway client must not reach into lib/zoho/client.ts. This is
    // a string-level scan of the source — keeps the gateway path
    // separate from the legacy direct-OAuth path.
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "gateway.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\/client"/);
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\b/);
    // No refresh-token / access-token concepts allowed in the gateway
    // client — those belong to the legacy direct-OAuth path.
    expect(src).not.toMatch(/refresh_token/);
    expect(src).not.toMatch(/access_token/);
  });

  it("does not write to Zoho", async () => {
    // The gateway client surface area in ZOHO-1 is GET-only. No POST /
    // PUT / DELETE / PATCH should appear in the source.
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
});
