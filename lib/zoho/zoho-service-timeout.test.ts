import { describe, it, expect } from "vitest";
import { resolveZohoServiceTimeoutMs } from "./assembly-service-client";

describe("resolveZohoServiceTimeoutMs", () => {
  it("returns 45_000 when env var is absent", () => {
    expect(resolveZohoServiceTimeoutMs({})).toBe(45_000);
  });

  it("returns the parsed value when ZOHO_SERVICE_TIMEOUT_MS is a valid integer >= 1000", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "60000" })).toBe(60_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is garbage (non-numeric)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "abc" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is empty string", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is below 1000 (sub-minimum clamped to default)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "500" })).toBe(45_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is exactly 999 (below floor)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "999" })).toBe(45_000);
  });

  it("returns the value when ZOHO_SERVICE_TIMEOUT_MS is exactly 1000 (at floor)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "1000" })).toBe(1_000);
  });

  it("returns 45_000 when ZOHO_SERVICE_TIMEOUT_MS is Infinity (non-finite)", () => {
    expect(resolveZohoServiceTimeoutMs({ ZOHO_SERVICE_TIMEOUT_MS: "Infinity" })).toBe(45_000);
  });

  it("returns 45_000 when called with no argument (uses process.env default, which won't have the var in test)", () => {
    // Valid as long as ZOHO_SERVICE_TIMEOUT_MS is not set in the test runner's process.env.
    const saved = process.env["ZOHO_SERVICE_TIMEOUT_MS"];
    delete process.env["ZOHO_SERVICE_TIMEOUT_MS"];
    try {
      expect(resolveZohoServiceTimeoutMs()).toBe(45_000);
    } finally {
      if (saved !== undefined) process.env["ZOHO_SERVICE_TIMEOUT_MS"] = saved;
    }
  });
});
