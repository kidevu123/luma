import { describe, it, expect } from "vitest";
import {
  buildInventoryServiceHeaders,
  redactInventoryServiceHeaders,
  listInventoryPurchaseOrders,
  getInventoryPurchaseOrder,
  searchZohoItems,
  listWarehouses,
  extractIsTabletPo,
} from "./inventory-service-client";

// ─── Test env ─────────────────────────────────────────────────────────────────

const VALID_ENV: Record<string, string> = {
  ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000",
  ZOHO_SERVICE_BEARER_SECRET: "test-bearer-secret",
  ZOHO_BRAND: "haute_brands",
  ZOHO_DRY_RUN_WRITES_ENABLED: "false",
};

// ─── Mock fetch helper ────────────────────────────────────────────────────────

const mockFetch = (status: number, body: unknown): typeof fetch =>
  (() =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })) as unknown as typeof fetch;

// ─── Sample response fixtures ─────────────────────────────────────────────────

const SAMPLE_META = {
  request_id: "req-abc-123",
  brand: "haute_brands",
  service: "inventory",
  action: "list",
};

const SAMPLE_PO_SUMMARY = {
  purchaseorder_id: "po-001",
  purchaseorder_number: "PO-2026-001",
  vendor_name: "ACME Pharmaceuticals",
  status: "issued",
  date: "2026-05-20",
  total: 15000,
  received_status: "to_be_received",
  quantity_yet_to_receive: 500,
};

const SAMPLE_LINE_ITEM = {
  line_item_id: "li-001",
  item_id: "item-001",
  name: "Vitamin C 500mg",
  quantity_ordered: 500,
  quantity_received: 0,
  quantity_remaining: 500,
  unit: "qty",
  status: "to_be_received",
};

const SAMPLE_PO_DETAIL = {
  purchaseorder_id: "po-001",
  purchaseorder_number: "PO-2026-001",
  vendor_name: "ACME Pharmaceuticals",
  status: "issued",
  date: "2026-05-20",
  received_status: "to_be_received",
  line_items: [SAMPLE_LINE_ITEM],
};

const SAMPLE_ITEM = {
  item_id: "item-001",
  name: "Vitamin C 500mg",
  sku: "VIT-C-500",
  status: "active",
  item_type: "inventory",
  is_combo_product: false,
};

const SAMPLE_WAREHOUSE = {
  warehouse_id: "wh-001",
  warehouse_name: "Main Warehouse",
};

// ─── buildInventoryServiceHeaders ────────────────────────────────────────────

describe("buildInventoryServiceHeaders", () => {
  const BASE_OPTS = {
    bearerSecret: "test-secret-abc",
    brand: "haute_brands",
  };

  it("sets Authorization: Bearer <secret>", () => {
    const h = buildInventoryServiceHeaders(BASE_OPTS);
    expect(h["Authorization"]).toBe("Bearer test-secret-abc");
  });

  it("sets X-Brand from brand parameter", () => {
    const h = buildInventoryServiceHeaders(BASE_OPTS);
    expect(h["X-Brand"]).toBe("haute_brands");
  });

  it("sets Accept: application/json", () => {
    const h = buildInventoryServiceHeaders(BASE_OPTS);
    expect(h["Accept"]).toBe("application/json");
  });

  it("does NOT include Idempotency-Key (reads only)", () => {
    const h = buildInventoryServiceHeaders(BASE_OPTS);
    expect(Object.keys(h)).not.toContain("Idempotency-Key");
  });

  it("does NOT include Content-Type (GET requests)", () => {
    const h = buildInventoryServiceHeaders(BASE_OPTS);
    expect(Object.keys(h)).not.toContain("Content-Type");
  });
});

// ─── redactInventoryServiceHeaders ───────────────────────────────────────────

describe("redactInventoryServiceHeaders", () => {
  it("replaces Authorization value with 'Bearer [REDACTED]'", () => {
    const headers = {
      Authorization: "Bearer actual-secret-value",
      "X-Brand": "haute_brands",
      Accept: "application/json",
    };
    const redacted = redactInventoryServiceHeaders(headers);
    expect(redacted["Authorization"]).toBe("Bearer [REDACTED]");
  });

  it("does not modify other headers", () => {
    const headers = {
      Authorization: "Bearer secret",
      "X-Brand": "haute_brands",
      Accept: "application/json",
    };
    const redacted = redactInventoryServiceHeaders(headers);
    expect(redacted["X-Brand"]).toBe("haute_brands");
    expect(redacted["Accept"]).toBe("application/json");
  });

  it("does not mutate the original headers object", () => {
    const headers = { Authorization: "Bearer secret", "X-Brand": "haute_brands" };
    const original = { ...headers };
    redactInventoryServiceHeaders(headers);
    expect(headers).toEqual(original);
  });

  it("handles case-insensitive Authorization key (lowercase)", () => {
    const headers = { authorization: "Bearer secret", "X-Brand": "haute_brands" };
    const redacted = redactInventoryServiceHeaders(headers);
    expect(redacted["authorization"]).toBe("Bearer [REDACTED]");
  });

  it("returns headers unchanged when no Authorization header present", () => {
    const headers = { Accept: "application/json" };
    const redacted = redactInventoryServiceHeaders(headers);
    expect(redacted).toEqual({ Accept: "application/json" });
  });
});

// ─── Config failures ──────────────────────────────────────────────────────────

describe("config validation failures (via listInventoryPurchaseOrders)", () => {
  it("returns ok:false when ZOHO_INTEGRATION_URL is missing", async () => {
    const { ZOHO_INTEGRATION_URL: _, ...envWithout } = VALID_ENV;
    const result = await listInventoryPurchaseOrders({
      env: envWithout,
      fetchImpl: mockFetch(200, {}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/ZOHO_INTEGRATION_URL/);
    expect(result.httpStatus).toBeNull();
  });

  it("returns ok:false when ZOHO_SERVICE_BEARER_SECRET is missing", async () => {
    const { ZOHO_SERVICE_BEARER_SECRET: _, ...envWithout } = VALID_ENV;
    const result = await listInventoryPurchaseOrders({
      env: envWithout,
      fetchImpl: mockFetch(200, {}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/ZOHO_SERVICE_BEARER_SECRET/);
  });

  it("returns ok:false when ZOHO_INTEGRATION_URL is not a valid URL", async () => {
    const result = await listInventoryPurchaseOrders({
      env: { ...VALID_ENV, ZOHO_INTEGRATION_URL: "not-a-url" },
      fetchImpl: mockFetch(200, {}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/valid URL/i);
  });
});

// ─── listInventoryPurchaseOrders ──────────────────────────────────────────────

describe("listInventoryPurchaseOrders", () => {
  it("returns ok:true with PO array on 200 with valid shape", async () => {
    const responseBody = {
      data: { purchaseorders: [SAMPLE_PO_SUMMARY] },
      meta: SAMPLE_META,
    };
    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.purchaseorder_id).toBe("po-001");
    expect(result.data[0]?.purchaseorder_number).toBe("PO-2026-001");
    expect(result.data[0]?.vendor_name).toBe("ACME Pharmaceuticals");
  });

  it("surfaces meta on success", async () => {
    const responseBody = {
      data: { purchaseorders: [SAMPLE_PO_SUMMARY] },
      meta: SAMPLE_META,
    };
    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.request_id).toBe("req-abc-123");
    expect(result.meta.brand).toBe("haute_brands");
  });

  it("returns ok:true with empty array when purchaseorders is []", async () => {
    const responseBody = {
      data: { purchaseorders: [] },
      meta: SAMPLE_META,
    };
    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("returns ok:false with httpStatus 403 on 403 response", async () => {
    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: mockFetch(403, { error: "Forbidden" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(403);
  });

  it("returns ok:false on network error", async () => {
    const networkErrorFetch = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: networkErrorFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBeNull();
    expect(result.message).toContain("Network error");
  });
});

// ─── getInventoryPurchaseOrder ────────────────────────────────────────────────

describe("getInventoryPurchaseOrder", () => {
  it("returns ok:true with PO detail on 200 with valid shape", async () => {
    const responseBody = {
      data: SAMPLE_PO_DETAIL,
      meta: SAMPLE_META,
    };
    const result = await getInventoryPurchaseOrder("po-001", {
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.purchaseorder_id).toBe("po-001");
    expect(result.data.purchaseorder_number).toBe("PO-2026-001");
    expect(result.data.vendor_name).toBe("ACME Pharmaceuticals");
  });

  it("line_items array is present and populated", async () => {
    const responseBody = {
      data: SAMPLE_PO_DETAIL,
      meta: SAMPLE_META,
    };
    const result = await getInventoryPurchaseOrder("po-001", {
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data.line_items)).toBe(true);
    expect(result.data.line_items).toHaveLength(1);
    expect(result.data.line_items[0]?.line_item_id).toBe("li-001");
  });

  it("quantity_remaining is present on line items", async () => {
    const responseBody = {
      data: SAMPLE_PO_DETAIL,
      meta: SAMPLE_META,
    };
    const result = await getInventoryPurchaseOrder("po-001", {
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.line_items[0]?.quantity_remaining).toBe(500);
  });

  it("returns ok:false with httpStatus 404 on 404 response", async () => {
    const result = await getInventoryPurchaseOrder("does-not-exist", {
      env: VALID_ENV,
      fetchImpl: mockFetch(404, { error: "Not found" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(404);
  });

  it("returns ok:false on network error", async () => {
    const networkErrorFetch = (() =>
      Promise.reject(new Error("Connection reset"))) as unknown as typeof fetch;
    const result = await getInventoryPurchaseOrder("po-001", {
      env: VALID_ENV,
      fetchImpl: networkErrorFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Network error");
  });
});

// ─── searchZohoItems ──────────────────────────────────────────────────────────

describe("searchZohoItems", () => {
  it("returns ok:true with items array on 200", async () => {
    const responseBody = {
      data: { items: [SAMPLE_ITEM] },
      meta: { ...SAMPLE_META, has_more: false, page: 1, per_page: 25 },
    };
    const result = await searchZohoItems({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data[0]?.item_id).toBe("item-001");
    expect(result.data[0]?.sku).toBe("VIT-C-500");
  });

  it("meta.has_more is surfaced when true", async () => {
    const responseBody = {
      data: { items: [SAMPLE_ITEM] },
      meta: { ...SAMPLE_META, has_more: true, page: 1, per_page: 25 },
    };
    const result = await searchZohoItems({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.has_more).toBe(true);
  });

  it("meta.has_more is false when service returns false", async () => {
    const responseBody = {
      data: { items: [] },
      meta: { ...SAMPLE_META, has_more: false, page: 2, per_page: 25 },
    };
    const result = await searchZohoItems({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.has_more).toBe(false);
    expect(result.meta.page).toBe(2);
    expect(result.meta.per_page).toBe(25);
  });

  it("returns ok:false on 401 response", async () => {
    const result = await searchZohoItems({
      env: VALID_ENV,
      fetchImpl: mockFetch(401, { error: "Unauthorized" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(401);
  });
});

// ─── listWarehouses ───────────────────────────────────────────────────────────

describe("listWarehouses", () => {
  it("returns ok:true with warehouses array on 200", async () => {
    const responseBody = {
      data: { warehouses: [SAMPLE_WAREHOUSE] },
      meta: SAMPLE_META,
    };
    const result = await listWarehouses({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data[0]?.warehouse_id).toBe("wh-001");
    expect(result.data[0]?.warehouse_name).toBe("Main Warehouse");
  });

  it("returns ok:true with empty array when warehouses is []", async () => {
    const responseBody = {
      data: { warehouses: [] },
      meta: SAMPLE_META,
    };
    const result = await listWarehouses({
      env: VALID_ENV,
      fetchImpl: mockFetch(200, responseBody),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("returns ok:false on 500 response", async () => {
    const result = await listWarehouses({
      env: VALID_ENV,
      fetchImpl: mockFetch(500, { error: "Internal Server Error" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(500);
    expect(result.message).toContain("500");
  });
});

// ─── Timeout / AbortError ─────────────────────────────────────────────────────

describe("timeout handling", () => {
  it("AbortError from fetch → ok:false with message containing 'Network error'", async () => {
    const abortErrorFetch = (() => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: abortErrorFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBeNull();
    expect(result.message).toContain("Network error");
  });
});

// ─── Non-JSON response body ───────────────────────────────────────────────────

describe("non-JSON response body", () => {
  it("gracefully falls back to text on non-JSON body, still returns error shape on non-2xx", async () => {
    const textFetch = (() =>
      Promise.resolve({
        status: 503,
        ok: false,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
        text: () => Promise.resolve("Service Unavailable"),
      })) as unknown as typeof fetch;

    const result = await listInventoryPurchaseOrders({
      env: VALID_ENV,
      fetchImpl: textFetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.httpStatus).toBe(503);
    // body should be the plain text fallback
    expect(result.body).toBe("Service Unavailable");
  });
});

// ─── tabletOnly option ────────────────────────────────────────────────────────

describe("listInventoryPurchaseOrders — tabletOnly option", () => {
  it("calls ?luma_tablet_only=true when tabletOnly: true", async () => {
    let capturedUrl: string | null = null;

    const captureFetch: typeof fetch = ((url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            data: { purchaseorders: [] },
            meta: SAMPLE_META,
          }),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof fetch;

    await listInventoryPurchaseOrders({
      tabletOnly: true,
      env: VALID_ENV,
      fetchImpl: captureFetch,
    });

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl).toContain("/zoho/purchaseorders_inv/list");
    expect(capturedUrl).toContain("luma_tablet_only=true");
  });

  it("does NOT include luma_tablet_only when tabletOnly is omitted", async () => {
    let capturedUrl: string | null = null;

    const captureFetch: typeof fetch = ((url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            data: { purchaseorders: [] },
            meta: SAMPLE_META,
          }),
        text: () => Promise.resolve(""),
      });
    }) as unknown as typeof fetch;

    await listInventoryPurchaseOrders({ env: VALID_ENV, fetchImpl: captureFetch });

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl).not.toContain("luma_tablet_only");
  });
});

// ─── extractIsTabletPo helper ─────────────────────────────────────────────────

describe("extractIsTabletPo", () => {
  it("returns true when app_flags.luma.is_tablet_po is true", () => {
    expect(extractIsTabletPo({ app_flags: { luma: { is_tablet_po: true } } })).toBe(true);
  });

  it("returns false when app_flags is missing", () => {
    expect(extractIsTabletPo({})).toBe(false);
  });

  it("returns false when luma block is missing", () => {
    expect(extractIsTabletPo({ app_flags: {} })).toBe(false);
  });

  it("returns false when is_tablet_po is false", () => {
    expect(extractIsTabletPo({ app_flags: { luma: { is_tablet_po: false } } })).toBe(false);
  });

  it("returns false when is_tablet_po is undefined", () => {
    expect(extractIsTabletPo({ app_flags: { luma: {} } })).toBe(false);
  });
});
