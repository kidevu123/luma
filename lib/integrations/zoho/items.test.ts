// ZOHO-2A — items.ts unit tests. Fetch is fully mocked; no live calls.

import { describe, expect, it } from "vitest";
import {
  deriveZohoItemLumaTarget,
  extractCollection,
  fetchZohoItemsDryRun,
  normalizeZohoItem,
  ZOHO_ITEMS_LIST_PATH,
} from "@/lib/integrations/zoho/items";

const baseEnv = {
  ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000",
  ZOHO_INTEGRATION_SECRET: "s3cr3t",
  ZOHO_BRAND: "haute_brands",
};

const itemFixture = {
  item_id: "ZI-1001",
  name: "HN Daily Multi 30ct Bottle",
  sku: "HN-DM-30",
  item_type: "inventory",
  status: "active",
  unit: "pcs",
  category_name: "Finished Goods",
  rate: 12.5,
  purchase_rate: 6.25,
  inventory_account_name: "Finished Goods Inventory",
};

describe("ZOHO-2A items · normalizeZohoItem", () => {
  it("normalizes a complete Zoho item", () => {
    const n = normalizeZohoItem(itemFixture);
    expect(n).not.toBeNull();
    expect(n!.zohoItemId).toBe("ZI-1001");
    expect(n!.name).toBe("HN Daily Multi 30ct Bottle");
    expect(n!.sku).toBe("HN-DM-30");
    expect(n!.itemType).toBe("inventory");
    expect(n!.active).toBe(true);
    expect(n!.unit).toBe("pcs");
    expect(n!.category).toBe("Finished Goods");
    expect(n!.rate).toBe(12.5);
    expect(n!.purchaseRate).toBe(6.25);
    expect(n!.inventoryAccount).toBe("Finished Goods Inventory");
  });

  it("returns null when item_id is missing", () => {
    expect(normalizeZohoItem({ name: "no id here" })).toBeNull();
  });

  it("treats missing SKU as null (not empty string)", () => {
    const n = normalizeZohoItem({ item_id: "x", name: "y", sku: "" });
    expect(n!.sku).toBeNull();
  });

  it("parses 'inactive' status to active=false", () => {
    const n = normalizeZohoItem({ ...itemFixture, status: "inactive" });
    expect(n!.active).toBe(false);
  });

  it("accepts boolean is_active", () => {
    const n = normalizeZohoItem({ item_id: "x", name: "y", is_active: false });
    expect(n!.active).toBe(false);
  });

  it("rate accepts string-encoded number", () => {
    const n = normalizeZohoItem({ item_id: "x", name: "y", rate: "9.99" });
    expect(n!.rate).toBe(9.99);
  });

  it("preserves raw payload verbatim", () => {
    const n = normalizeZohoItem(itemFixture);
    expect((n!.raw as Record<string, unknown>).inventory_account_name).toBe(
      "Finished Goods Inventory",
    );
  });

  it("returns null for non-object input", () => {
    expect(normalizeZohoItem(null)).toBeNull();
    expect(normalizeZohoItem(undefined)).toBeNull();
    expect(normalizeZohoItem("string")).toBeNull();
    expect(normalizeZohoItem(123)).toBeNull();
  });
});

describe("ZOHO-2A items · deriveZohoItemLumaTarget", () => {
  it("PACKAGING_MATERIAL from category 'Packaging'", () => {
    const n = normalizeZohoItem({ ...itemFixture, category_name: "Packaging Materials" });
    expect(deriveZohoItemLumaTarget(n!)).toBe("PACKAGING_MATERIAL");
  });

  it("PACKAGING_MATERIAL from inventory_account hint", () => {
    const n = normalizeZohoItem({
      ...itemFixture,
      category_name: "Misc",
      inventory_account_name: "Packaging Inventory",
    });
    expect(deriveZohoItemLumaTarget(n!)).toBe("PACKAGING_MATERIAL");
  });

  it("TABLET_TYPE from category 'Tablet' or 'Bulk'", () => {
    const tabletFromCat = normalizeZohoItem({ ...itemFixture, category_name: "Bulk Tablets" });
    expect(deriveZohoItemLumaTarget(tabletFromCat!)).toBe("TABLET_TYPE");
  });

  it("TABLET_TYPE from item_type 'raw'", () => {
    const tabletFromType = normalizeZohoItem({ ...itemFixture, item_type: "raw_material", category_name: "" });
    expect(deriveZohoItemLumaTarget(tabletFromType!)).toBe("TABLET_TYPE");
  });

  it("PRODUCT for default inventory items", () => {
    const n = normalizeZohoItem(itemFixture);
    expect(deriveZohoItemLumaTarget(n!)).toBe("PRODUCT");
  });

  it("UNKNOWN when category + item_type are ambiguous", () => {
    const n = normalizeZohoItem({ item_id: "x", name: "y" });
    expect(deriveZohoItemLumaTarget(n!)).toBe("UNKNOWN");
  });
});

describe("ZOHO-2A items · extractCollection", () => {
  it("pulls 'items' key", () => {
    expect(
      extractCollection({ items: [itemFixture] }, "items"),
    ).toEqual([itemFixture]);
  });

  it("falls back to 'data'", () => {
    expect(extractCollection({ data: [itemFixture] }, "items").length).toBe(1);
  });

  it("tolerates a bare array", () => {
    expect(extractCollection([itemFixture, itemFixture], "items").length).toBe(2);
  });

  it("returns empty for non-list shapes", () => {
    expect(extractCollection({}, "items")).toEqual([]);
    expect(extractCollection(null, "items")).toEqual([]);
  });
});

describe("ZOHO-2A items · fetchZohoItemsDryRun (mocked)", () => {
  it("NOT_CONFIGURED with empty env", async () => {
    const r = await fetchZohoItemsDryRun({ env: {} });
    expect(r.kind).toBe("NOT_CONFIGURED");
  });

  it("OK with one valid item", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ items: [itemFixture] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await fetchZohoItemsDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") {
      expect(r.items.length).toBe(1);
      expect(r.items[0]?.zohoItemId).toBe("ZI-1001");
    }
  });

  it("sends X-Internal-Token + X-Brand on the request", async () => {
    let captured: Headers | null = null;
    let capturedUrl = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      captured = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchZohoItemsDryRun({ env: baseEnv, fetchImpl });
    expect(captured!.get("x-internal-token")).toBe("s3cr3t");
    expect(captured!.get("x-brand")).toBe("haute_brands");
    expect(capturedUrl).toContain(ZOHO_ITEMS_LIST_PATH);
    expect(capturedUrl).toContain("per_page=200");
    expect(capturedUrl).toContain("page=1");
  });

  it("UNAUTHORIZED on 401", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", { status: 401 })) as unknown as typeof fetch;
    const r = await fetchZohoItemsDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("UNAUTHORIZED");
  });

  it("ERROR on HTTP 500", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await fetchZohoItemsDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("ERROR");
  });

  it("UNREACHABLE on ECONNREFUSED", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 192.168.1.205:8000");
    }) as unknown as typeof fetch;
    const r = await fetchZohoItemsDryRun({ env: baseEnv, fetchImpl });
    expect(r.kind).toBe("UNREACHABLE");
  });
});
