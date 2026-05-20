import { describe, it, expect } from "vitest";
import {
  buildAssemblyServiceHeaders,
  validateAssemblyServiceConfig,
  redactAssemblyServiceHeaders,
  ZOHO_BEARER_SECRET_ENV,
  ZOHO_DRY_RUN_ENABLED_ENV,
  ZOHO_WAREHOUSE_ID_ENV,
} from "./assembly-service-client";

// ─── buildAssemblyServiceHeaders ─────────────────────────────────────────────

describe("buildAssemblyServiceHeaders", () => {
  const BASE_OPTS = {
    bearerSecret: "test-secret-abc",
    brand: "haute_brands",
    idempotencyKey: "luma-purchase-receive-op-123",
  };

  it("sets Authorization: Bearer <secret>", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(h["Authorization"]).toBe("Bearer test-secret-abc");
  });

  it("sets X-Brand from brand parameter", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(h["X-Brand"]).toBe("haute_brands");
  });

  it("sets Idempotency-Key from idempotencyKey parameter", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(h["Idempotency-Key"]).toBe("luma-purchase-receive-op-123");
  });

  it("sets Content-Type: application/json", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("sets Accept: application/json", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(h["Accept"]).toBe("application/json");
  });

  it("does not contain X-Internal-Token (bearer auth only for v1.10.0 endpoints)", () => {
    const h = buildAssemblyServiceHeaders(BASE_OPTS);
    expect(Object.keys(h)).not.toContain("X-Internal-Token");
  });

  it("uses exact brand value passed in — haute_brands for production", () => {
    const h = buildAssemblyServiceHeaders({ ...BASE_OPTS, brand: "haute_brands" });
    expect(h["X-Brand"]).toBe("haute_brands");
  });

  it("idempotency key for TABLET_RECEIVE follows luma-purchase-receive-<id> format", () => {
    const opId = "aaaaaaaa-0000-0000-0000-000000000001";
    const h = buildAssemblyServiceHeaders({
      ...BASE_OPTS,
      idempotencyKey: `luma-purchase-receive-${opId}`,
    });
    expect(h["Idempotency-Key"]).toBe(`luma-purchase-receive-${opId}`);
  });

  it("idempotency key for assembly follows luma-assembly-<id> format", () => {
    const opId = "bbbbbbbb-0000-0000-0000-000000000002";
    const h = buildAssemblyServiceHeaders({
      ...BASE_OPTS,
      idempotencyKey: `luma-assembly-${opId}`,
    });
    expect(h["Idempotency-Key"]).toBe(`luma-assembly-${opId}`);
  });
});

// ─── validateAssemblyServiceConfig ───────────────────────────────────────────

describe("validateAssemblyServiceConfig", () => {
  const VALID_ENV: Record<string, string> = {
    ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000",
    ZOHO_SERVICE_BEARER_SECRET: "secret-abc-123",
    ZOHO_BRAND: "haute_brands",
    ZOHO_DRY_RUN_WRITES_ENABLED: "false",
  };

  it("returns ok:true with correct values from valid env", () => {
    const result = validateAssemblyServiceConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseUrl).toBe("http://192.168.1.205:8000");
    expect(result.brand).toBe("haute_brands");
    expect(result.dryRunEnabled).toBe(false);
    expect(result.bearerSecret).toBe("secret-abc-123");
  });

  it("dryRunEnabled is true only when ZOHO_DRY_RUN_WRITES_ENABLED is exactly 'true'", () => {
    const result = validateAssemblyServiceConfig({
      ...VALID_ENV,
      ZOHO_DRY_RUN_WRITES_ENABLED: "true",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRunEnabled).toBe(true);
  });

  it("dryRunEnabled is false when ZOHO_DRY_RUN_WRITES_ENABLED is 'false'", () => {
    const result = validateAssemblyServiceConfig({
      ...VALID_ENV,
      ZOHO_DRY_RUN_WRITES_ENABLED: "false",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRunEnabled).toBe(false);
  });

  it("dryRunEnabled is false when ZOHO_DRY_RUN_WRITES_ENABLED is absent", () => {
    const { ZOHO_DRY_RUN_WRITES_ENABLED: _, ...envWithout } = VALID_ENV;
    const result = validateAssemblyServiceConfig(envWithout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRunEnabled).toBe(false);
  });

  it("brand defaults to haute_brands when ZOHO_BRAND is absent", () => {
    const { ZOHO_BRAND: _, ...envWithout } = VALID_ENV;
    const result = validateAssemblyServiceConfig(envWithout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brand).toBe("haute_brands");
  });

  it("brand defaults to haute_brands when ZOHO_BRAND is empty string", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_BRAND: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brand).toBe("haute_brands");
  });

  it("ZOHO_WAREHOUSE_ID is included in config when set", () => {
    const result = validateAssemblyServiceConfig({
      ...VALID_ENV,
      ZOHO_WAREHOUSE_ID: "WH-HAUTE-001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warehouseId).toBe("WH-HAUTE-001");
  });

  it("ZOHO_WAREHOUSE_ID is null when absent", () => {
    const result = validateAssemblyServiceConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warehouseId).toBeNull();
  });

  it("ZOHO_WAREHOUSE_ID is null when empty string", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_WAREHOUSE_ID: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warehouseId).toBeNull();
  });

  it("returns ok:false when ZOHO_INTEGRATION_URL is absent", () => {
    const { ZOHO_INTEGRATION_URL: _, ...envWithout } = VALID_ENV;
    const result = validateAssemblyServiceConfig(envWithout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ZOHO_INTEGRATION_URL/);
  });

  it("returns ok:false when ZOHO_INTEGRATION_URL is empty string", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_INTEGRATION_URL: "" });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when ZOHO_INTEGRATION_URL is invalid URL", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_INTEGRATION_URL: "not-a-url" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/valid URL/i);
  });

  it("returns ok:false when ZOHO_SERVICE_BEARER_SECRET is absent", () => {
    const { ZOHO_SERVICE_BEARER_SECRET: _, ...envWithout } = VALID_ENV;
    const result = validateAssemblyServiceConfig(envWithout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ZOHO_SERVICE_BEARER_SECRET/);
  });

  it("returns ok:false when ZOHO_SERVICE_BEARER_SECRET is empty string", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_SERVICE_BEARER_SECRET: "" });
    expect(result.ok).toBe(false);
  });

  it("strips trailing slash from baseUrl", () => {
    const result = validateAssemblyServiceConfig({
      ...VALID_ENV,
      ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseUrl).toBe("http://192.168.1.205:8000");
  });

  it("uses the configured brand when ZOHO_BRAND is set to a non-default value", () => {
    const result = validateAssemblyServiceConfig({ ...VALID_ENV, ZOHO_BRAND: "boomin_brands" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brand).toBe("boomin_brands");
  });

  it("env var name constants match expected strings", () => {
    expect(ZOHO_BEARER_SECRET_ENV).toBe("ZOHO_SERVICE_BEARER_SECRET");
    expect(ZOHO_DRY_RUN_ENABLED_ENV).toBe("ZOHO_DRY_RUN_WRITES_ENABLED");
    expect(ZOHO_WAREHOUSE_ID_ENV).toBe("ZOHO_WAREHOUSE_ID");
  });
});

// ─── redactAssemblyServiceHeaders ────────────────────────────────────────────

describe("redactAssemblyServiceHeaders", () => {
  it("replaces Authorization value with 'Bearer [REDACTED]'", () => {
    const headers = {
      Authorization: "Bearer actual-secret-value",
      "X-Brand": "haute_brands",
      "Content-Type": "application/json",
    };
    const redacted = redactAssemblyServiceHeaders(headers);
    expect(redacted["Authorization"]).toBe("Bearer [REDACTED]");
  });

  it("does not modify other headers", () => {
    const headers = {
      Authorization: "Bearer secret",
      "X-Brand": "haute_brands",
      "Idempotency-Key": "luma-purchase-receive-123",
      "Content-Type": "application/json",
    };
    const redacted = redactAssemblyServiceHeaders(headers);
    expect(redacted["X-Brand"]).toBe("haute_brands");
    expect(redacted["Idempotency-Key"]).toBe("luma-purchase-receive-123");
    expect(redacted["Content-Type"]).toBe("application/json");
  });

  it("does not mutate the original headers object", () => {
    const headers = { Authorization: "Bearer secret", "X-Brand": "haute_brands" };
    const original = { ...headers };
    redactAssemblyServiceHeaders(headers);
    expect(headers).toEqual(original);
  });

  it("handles case-insensitive Authorization key (lowercase)", () => {
    const headers = { authorization: "Bearer secret", "X-Brand": "haute_brands" };
    const redacted = redactAssemblyServiceHeaders(headers);
    expect(redacted["authorization"]).toBe("Bearer [REDACTED]");
  });

  it("returns empty object unchanged when no Authorization header", () => {
    const headers = { "Content-Type": "application/json" };
    const redacted = redactAssemblyServiceHeaders(headers);
    expect(redacted).toEqual({ "Content-Type": "application/json" });
  });
});
