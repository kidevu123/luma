// WAREHOUSE-CAPABILITY-v1.4.0 — pure mapping + fetch tests.

import { describe, expect, it, vi } from "vitest";
import {
  BRAND_CAPABILITY_WAREHOUSE_PATH,
  fetchWarehouseCapability,
  mapWarehouseCapabilityResponse,
} from "./brand-capabilities-client";

const ENV = {
  ZOHO_SERVICE_BASE_URL: "http://gateway.test",
  ZOHO_SERVICE_BEARER_SECRET: "secret-1",
  ZOHO_BRAND: "haute_brands",
};

describe("mapWarehouseCapabilityResponse — total mapping", () => {
  it("warehouse_required:true -> REQUIRED with request_id", () => {
    const r = mapWarehouseCapabilityResponse({
      data: { warehouse_required: true },
      meta: { request_id: "req-1" },
    });
    expect(r).toEqual({ state: "REQUIRED", gatewayRequestId: "req-1" });
  });

  it("warehouse_required:false -> OPTIONAL with request_id", () => {
    const r = mapWarehouseCapabilityResponse({
      data: { warehouse_required: false },
      meta: { request_id: "req-2" },
    });
    expect(r).toEqual({ state: "OPTIONAL", gatewayRequestId: "req-2" });
  });

  it("haute_brands deployed payload shape -> OPTIONAL", () => {
    // Verbatim from the gateway v1.23.1 deploy:
    const r = mapWarehouseCapabilityResponse({
      data: {
        warehouse_required: false,
        warehouse_source: "none_configured",
        warehouse_count: 0,
        last_observed_at: "2026-06-17T12:00:00Z",
        stale: false,
      },
      warnings: [],
      meta: {
        brand: "haute_brands",
        request_id: "wh-cap-abc",
      },
    });
    expect(r).toEqual({ state: "OPTIONAL", gatewayRequestId: "wh-cap-abc" });
  });

  it("warehouse_required:null -> UNKNOWN", () => {
    const r = mapWarehouseCapabilityResponse({
      data: { warehouse_required: null },
      meta: { request_id: "x" },
    });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toBe("gateway returned null");
  });

  it("warehouse_required field missing -> UNKNOWN", () => {
    const r = mapWarehouseCapabilityResponse({ data: {}, meta: {} });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toBe("gateway omitted warehouse_required field");
  });

  it("data block missing -> UNKNOWN", () => {
    const r = mapWarehouseCapabilityResponse({ meta: {} });
    expect(r.state).toBe("UNKNOWN");
  });

  it("non-boolean warehouse_required -> UNKNOWN", () => {
    const r = mapWarehouseCapabilityResponse({
      data: { warehouse_required: "true" },
      meta: {},
    });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toContain("non-boolean");
  });

  it("null body -> UNKNOWN", () => {
    expect(mapWarehouseCapabilityResponse(null).state).toBe("UNKNOWN");
  });

  it("string body -> UNKNOWN", () => {
    expect(mapWarehouseCapabilityResponse("oops").state).toBe("UNKNOWN");
  });

  it("missing meta.request_id substitutes a sentinel", () => {
    const r = mapWarehouseCapabilityResponse({
      data: { warehouse_required: true },
    });
    expect(r.state).toBe("REQUIRED");
    if (r.state === "REQUIRED")
      expect(r.gatewayRequestId).toBe("unknown-request-id");
  });
});

describe("fetchWarehouseCapability — transport-level errors all collapse to UNKNOWN", () => {
  function makeFetch(impl: (input: string) => Promise<Response>): typeof fetch {
    return ((input: RequestInfo | URL) =>
      impl(String(input))) as unknown as typeof fetch;
  }

  it("uses the canonical path", async () => {
    const seen: string[] = [];
    const fetchFn = makeFetch(async (url) => {
      seen.push(url);
      return new Response(
        JSON.stringify({
          data: { warehouse_required: true },
          meta: { request_id: "x" },
        }),
        { status: 200 },
      );
    });
    await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(seen[0]).toMatch(
      new RegExp(`${BRAND_CAPABILITY_WAREHOUSE_PATH}$`),
    );
  });

  it("HTTP 500 -> UNKNOWN with status in reason", async () => {
    const fetchFn = makeFetch(
      async () => new Response("server error", { status: 500 }),
    );
    const r = await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toContain("500");
  });

  it("HTTP 401 -> UNKNOWN with status in reason", async () => {
    const fetchFn = makeFetch(
      async () => new Response("unauth", { status: 401 }),
    );
    const r = await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toContain("401");
  });

  it("fetch throws (transport error) -> UNKNOWN", async () => {
    const fetchFn = makeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toContain("unreachable");
  });

  it("invalid JSON body -> UNKNOWN", async () => {
    const fetchFn = makeFetch(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const r = await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toBe("gateway response not parseable");
  });

  it("missing env (no base URL) -> UNKNOWN without firing fetch", async () => {
    const fetchFn = vi.fn();
    const r = await fetchWarehouseCapability({
      env: { ZOHO_SERVICE_BEARER_SECRET: "x" },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.state).toBe("UNKNOWN");
    if (r.state !== "UNKNOWN") return;
    expect(r.reason).toContain("not configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("happy path with the haute_brands deployed shape -> OPTIONAL", async () => {
    const fetchFn = makeFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              warehouse_required: false,
              warehouse_source: "none_configured",
              warehouse_count: 0,
              last_observed_at: "2026-06-17T12:00:00Z",
              stale: false,
            },
            warnings: [],
            meta: { brand: "haute_brands", request_id: "live-1" },
          }),
          { status: 200 },
        ),
    );
    const r = await fetchWarehouseCapability({ env: ENV, fetchFn });
    expect(r).toEqual({ state: "OPTIONAL", gatewayRequestId: "live-1" });
  });
});
