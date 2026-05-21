// ZOHO-2A — sync-dry-run.ts: diff engine + orchestrator tests.
// Everything mocked; no live DB writes, no live Zoho fetches.

import { describe, expect, it } from "vitest";
import {
  countDryRunRows,
  diffZohoCustomersAgainstLuma,
  diffZohoItemsAgainstLuma,
  readinessBlockedMessage,
  runZohoDryRunSync,
  type LumaCustomerSnapshot,
  type LumaItemSnapshot,
} from "@/lib/integrations/zoho/sync-dry-run";
import { type NormalizedZohoItem } from "@/lib/integrations/zoho/items";
import { type NormalizedZohoCustomer } from "@/lib/integrations/zoho/customers";

// ─── Item diff ────────────────────────────────────────────────────────────

function makeZohoItem(overrides: Partial<NormalizedZohoItem> = {}): NormalizedZohoItem {
  return {
    zohoItemId: "ZI-100",
    name: "Generic SKU",
    sku: "GEN-001",
    itemType: "inventory",
    active: true,
    unit: "pcs",
    category: "Finished Goods",
    rate: 10,
    purchaseRate: 4,
    inventoryAccount: "Finished Goods Inventory",
    raw: {},
    ...overrides,
  };
}

const emptyLuma: LumaItemSnapshot = { products: [], tabletTypes: [], packagingMaterials: [] };

describe("ZOHO-2A · diffZohoItemsAgainstLuma", () => {
  it("CREATE_CANDIDATE when item is new and mappable", () => {
    const { rows } = diffZohoItemsAgainstLuma([makeZohoItem()], emptyLuma);
    expect(rows[0]?.action).toBe("CREATE_CANDIDATE");
  });

  it("NEEDS_REVIEW when SKU is missing", () => {
    const { rows } = diffZohoItemsAgainstLuma([makeZohoItem({ sku: null })], emptyLuma);
    expect(rows[0]?.action).toBe("NEEDS_REVIEW");
    expect(rows[0]?.reasons).toContain("missing_sku");
  });

  it("NEEDS_REVIEW when item is inactive", () => {
    const { rows } = diffZohoItemsAgainstLuma(
      [makeZohoItem({ active: false })],
      emptyLuma,
    );
    expect(rows[0]?.action).toBe("NEEDS_REVIEW");
    expect(rows[0]?.reasons).toContain("inactive_in_zoho");
  });

  it("NEEDS_REVIEW when item type is unmappable", () => {
    const { rows } = diffZohoItemsAgainstLuma(
      [makeZohoItem({ itemType: null, category: null, inventoryAccount: null })],
      emptyLuma,
    );
    expect(rows[0]?.action).toBe("NEEDS_REVIEW");
    expect(rows[0]?.reasons).toContain("luma_target_unknown");
  });

  it("CONFLICT on duplicate Zoho id within payload", () => {
    const dup = [makeZohoItem(), makeZohoItem({ name: "Same id different name" })];
    const { rows } = diffZohoItemsAgainstLuma(dup, emptyLuma);
    expect(rows.every((r) => r.action === "CONFLICT")).toBe(true);
    expect(rows[0]?.reasons).toContain("duplicate_zoho_id");
  });

  it("CONFLICT on duplicate SKU within payload (different Zoho ids)", () => {
    const a = makeZohoItem({ zohoItemId: "A", sku: "SAME" });
    const b = makeZohoItem({ zohoItemId: "B", sku: "SAME" });
    const { rows, warnings } = diffZohoItemsAgainstLuma([a, b], emptyLuma);
    expect(rows[0]?.action).toBe("CONFLICT");
    expect(rows[0]?.reasons).toContain("duplicate_sku_in_zoho");
    expect(warnings.length).toBe(1);
  });

  it("NO_CHANGE when local already mapped and name matches", () => {
    const luma: LumaItemSnapshot = {
      products: [{ id: "p1", sku: "GEN-001", name: "Generic SKU", zohoItemId: "ZI-100" }],
      tabletTypes: [],
      packagingMaterials: [],
    };
    const { rows } = diffZohoItemsAgainstLuma([makeZohoItem()], luma);
    expect(rows[0]?.action).toBe("NO_CHANGE");
    expect(rows[0]?.reasons).toContain("local_already_mapped");
    expect(rows[0]?.reasons).toContain("mapping_present_no_change");
    expect(rows[0]?.matchedLumaId).toBe("p1");
    expect(rows[0]?.matchedLumaTable).toBe("products");
  });

  it("UPDATE_CANDIDATE when local mapped but name drifted", () => {
    const luma: LumaItemSnapshot = {
      products: [{ id: "p1", sku: "GEN-001", name: "Old name", zohoItemId: "ZI-100" }],
      tabletTypes: [],
      packagingMaterials: [],
    };
    const { rows } = diffZohoItemsAgainstLuma([makeZohoItem()], luma);
    expect(rows[0]?.action).toBe("UPDATE_CANDIDATE");
    expect(rows[0]?.reasons).toContain("mapping_present_name_changed");
  });

  it("packaging material category routes to PACKAGING_MATERIAL target", () => {
    const z = makeZohoItem({
      category: "Packaging Materials",
      inventoryAccount: "Packaging Inventory",
    });
    const { rows } = diffZohoItemsAgainstLuma([z], emptyLuma);
    expect(rows[0]?.suggestedTarget).toBe("PACKAGING_MATERIAL");
  });

  it("never writes — receives only readonly inputs and returns plain rows", () => {
    const items = [makeZohoItem()];
    const lumaCopy: LumaItemSnapshot = { products: [], tabletTypes: [], packagingMaterials: [] };
    diffZohoItemsAgainstLuma(items, lumaCopy);
    expect(items.length).toBe(1);
    expect(lumaCopy.products.length).toBe(0);
  });
});

// ─── Customer diff ────────────────────────────────────────────────────────

function makeZohoCustomer(overrides: Partial<NormalizedZohoCustomer> = {}): NormalizedZohoCustomer {
  return {
    zohoCustomerId: "ZC-200",
    customerName: "Acme Wholesale",
    customerCodeSuggestion: "ACME-WHOLESALE",
    email: "ordering@acme.example",
    phone: "+1-555-0000",
    billingAddress: null,
    shippingAddress: null,
    active: true,
    raw: {},
    ...overrides,
  };
}

const emptyCust: LumaCustomerSnapshot = { customers: [] };

describe("ZOHO-2A · diffZohoCustomersAgainstLuma", () => {
  it("CREATE_CANDIDATE when customer is new and mappable", () => {
    const { rows } = diffZohoCustomersAgainstLuma([makeZohoCustomer()], emptyCust);
    expect(rows[0]?.action).toBe("CREATE_CANDIDATE");
  });

  it("NEEDS_REVIEW when customer_code suggestion missing", () => {
    const { rows } = diffZohoCustomersAgainstLuma(
      [makeZohoCustomer({ customerCodeSuggestion: null })],
      emptyCust,
    );
    expect(rows[0]?.action).toBe("NEEDS_REVIEW");
    expect(rows[0]?.reasons).toContain("missing_customer_code");
  });

  it("NEEDS_REVIEW when customer is inactive", () => {
    const { rows } = diffZohoCustomersAgainstLuma(
      [makeZohoCustomer({ active: false })],
      emptyCust,
    );
    expect(rows[0]?.action).toBe("NEEDS_REVIEW");
    expect(rows[0]?.reasons).toContain("inactive_in_zoho");
  });

  it("CONFLICT on duplicate Zoho customer id in payload", () => {
    const dup = [makeZohoCustomer(), makeZohoCustomer({ customerName: "Diff Name" })];
    const { rows } = diffZohoCustomersAgainstLuma(dup, emptyCust);
    expect(rows.every((r) => r.action === "CONFLICT")).toBe(true);
    expect(rows[0]?.reasons).toContain("customer_duplicate_in_zoho");
  });

  it("NO_CHANGE when local already mapped and name matches", () => {
    const luma: LumaCustomerSnapshot = {
      customers: [
        { id: "c1", customerCode: "ACME", name: "Acme Wholesale", zohoCustomerId: "ZC-200" },
      ],
    };
    const { rows } = diffZohoCustomersAgainstLuma([makeZohoCustomer()], luma);
    expect(rows[0]?.action).toBe("NO_CHANGE");
    expect(rows[0]?.matchedLumaId).toBe("c1");
  });

  it("UPDATE_CANDIDATE when local mapped but name drifted", () => {
    const luma: LumaCustomerSnapshot = {
      customers: [
        { id: "c1", customerCode: "ACME", name: "Old name", zohoCustomerId: "ZC-200" },
      ],
    };
    const { rows } = diffZohoCustomersAgainstLuma([makeZohoCustomer()], luma);
    expect(rows[0]?.action).toBe("UPDATE_CANDIDATE");
  });
});

// ─── Counts ───────────────────────────────────────────────────────────────

describe("ZOHO-2A · countDryRunRows", () => {
  it("totals each action category", () => {
    const counts = countDryRunRows([
      { action: "CREATE_CANDIDATE" },
      { action: "CREATE_CANDIDATE" },
      { action: "UPDATE_CANDIDATE" },
      { action: "NO_CHANGE" },
      { action: "NEEDS_REVIEW" },
      { action: "CONFLICT" },
      { action: "CONFLICT" },
    ]);
    expect(counts).toEqual({
      scanned: 7,
      createCandidates: 2,
      updateCandidates: 1,
      noChange: 1,
      needsReview: 1,
      conflicts: 2,
    });
  });
});

// ─── Readiness messaging ──────────────────────────────────────────────────

describe("ZOHO-2A · readinessBlockedMessage", () => {
  it("READY_FOR_DRY_RUN returns short 'Ready.'", () => {
    expect(readinessBlockedMessage("READY_FOR_DRY_RUN")).toBe("Ready.");
  });
  it("NEEDS_REAUTH spells out the operator action", () => {
    const m = readinessBlockedMessage("NEEDS_REAUTH");
    expect(m).toContain("haute_brands");
    expect(m).toContain("re-authorized");
  });
  it("NEEDS_SELECTION mentions ZOHO_BRAND", () => {
    expect(readinessBlockedMessage("NEEDS_SELECTION")).toContain("ZOHO_BRAND");
  });
  it("each readiness state has a message", () => {
    const states = [
      "NOT_CONFIGURED",
      "UNREACHABLE",
      "ERROR",
      "CONNECTED_HEALTH_ONLY",
      "NEEDS_SELECTION",
      "NEEDS_REAUTH",
      "READY_FOR_DRY_RUN",
    ] as const;
    for (const s of states) {
      const m = readinessBlockedMessage(s);
      expect(m.length).toBeGreaterThan(3);
    }
  });
});

// ─── Orchestrator ─────────────────────────────────────────────────────────

describe("ZOHO-2A · runZohoDryRunSync (orchestrator)", () => {
  it("returns BLOCKED + writes only an ITEMS audit row when readiness=NEEDS_REAUTH", async () => {
    const persisted: Array<{ syncType: string; status: string; error: string | null }> = [];
    const r = await runZohoDryRunSync({
      probeReadiness: async () => "NEEDS_REAUTH",
      fetchItems: async () => {
        throw new Error("must not be called when blocked");
      },
      fetchCustomers: async () => {
        throw new Error("must not be called when blocked");
      },
      loadLumaItems: async () => emptyLuma,
      loadLumaCustomers: async () => emptyCust,
      persistRun: async (input) => {
        persisted.push({
          syncType: input.syncType,
          status: input.status,
          error: input.error,
        });
        return "run-id-1";
      },
    });
    expect(r.kind).toBe("BLOCKED");
    if (r.kind === "BLOCKED") {
      expect(r.readiness).toBe("NEEDS_REAUTH");
      expect(r.itemRunId).toBe("run-id-1");
      expect(r.customerRunId).toBeNull();
      expect(r.reason).toContain("haute_brands");
    }
    // Exactly one audit row: the ITEMS PARTIAL row. No CUSTOMERS row.
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.syncType).toBe("ITEMS");
    expect(persisted[0]?.status).toBe("PARTIAL");
    expect(persisted[0]?.error).toContain("haute_brands");
  });

  it("returns BLOCKED for every non-READY readiness without calling fetchers", async () => {
    for (const readiness of [
      "NOT_CONFIGURED",
      "UNREACHABLE",
      "ERROR",
      "CONNECTED_HEALTH_ONLY",
      "NEEDS_SELECTION",
    ] as const) {
      let itemCalled = false;
      let customerCalled = false;
      const r = await runZohoDryRunSync({
        probeReadiness: async () => readiness,
        fetchItems: async () => {
          itemCalled = true;
          return { kind: "OK", items: [], raw: { count: 0 } };
        },
        fetchCustomers: async () => {
          customerCalled = true;
          return { kind: "OK", customers: [], raw: { count: 0 } };
        },
        loadLumaItems: async () => emptyLuma,
        loadLumaCustomers: async () => emptyCust,
        persistRun: async () => "id",
      });
      expect(r.kind).toBe("BLOCKED");
      expect(itemCalled).toBe(false);
      expect(customerCalled).toBe(false);
    }
  });

  it("runs the full diff + writes ITEMS + CUSTOMERS rows when READY_FOR_DRY_RUN", async () => {
    const persisted: Array<{ syncType: string; status: string; summary: Record<string, unknown> }> = [];
    const r = await runZohoDryRunSync({
      probeReadiness: async () => "READY_FOR_DRY_RUN",
      fetchItems: async () => ({
        kind: "OK",
        items: [
          makeZohoItem({ zohoItemId: "Z1", sku: "A" }),
          makeZohoItem({ zohoItemId: "Z2", sku: "B", active: false }),
        ],
        raw: { count: 2 },
      }),
      fetchCustomers: async () => ({
        kind: "OK",
        customers: [makeZohoCustomer({ zohoCustomerId: "ZC-1" })],
        raw: { count: 1 },
      }),
      loadLumaItems: async () => emptyLuma,
      loadLumaCustomers: async () => emptyCust,
      persistRun: async (input) => {
        persisted.push({
          syncType: input.syncType,
          status: input.status,
          summary: input.summary,
        });
        return `id-${input.syncType}`;
      },
    });
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") {
      expect(r.itemRunId).toBe("id-ITEMS");
      expect(r.customerRunId).toBe("id-CUSTOMERS");
      expect(r.items.counts.scanned).toBe(2);
      // Two items: one CREATE_CANDIDATE (active=true, named), one
      // NEEDS_REVIEW (active=false).
      expect(r.items.counts.createCandidates).toBe(1);
      expect(r.items.counts.needsReview).toBe(1);
      expect(r.customers.counts.scanned).toBe(1);
      expect(r.customers.counts.createCandidates).toBe(1);
    }
    expect(persisted.map((p) => p.syncType).sort()).toEqual(["CUSTOMERS", "ITEMS"]);
  });

  it("propagates fetch ERROR result without panicking", async () => {
    const r = await runZohoDryRunSync({
      probeReadiness: async () => "READY_FOR_DRY_RUN",
      fetchItems: async () => ({ kind: "ERROR", message: "boom" }),
      fetchCustomers: async () => ({ kind: "OK", customers: [], raw: { count: 0 } }),
      loadLumaItems: async () => emptyLuma,
      loadLumaCustomers: async () => emptyCust,
      persistRun: async () => "x",
    });
    expect(r.kind).toBe("ERROR");
  });

  it("never invokes the default DB persister — orchestrator routes through persistRun option only", async () => {
    let persistCalls = 0;
    await runZohoDryRunSync({
      probeReadiness: async () => "NEEDS_REAUTH",
      fetchItems: async () => {
        throw new Error("nope");
      },
      fetchCustomers: async () => {
        throw new Error("nope");
      },
      loadLumaItems: async () => emptyLuma,
      loadLumaCustomers: async () => emptyCust,
      persistRun: async () => {
        persistCalls++;
        return "x";
      },
    });
    expect(persistCalls).toBe(1);
  });
});

// ─── Static-source guards ─────────────────────────────────────────────────

describe("ZOHO-2A · static guards", () => {
  it("sync-dry-run never imports the direct OAuth client", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "sync-dry-run.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\/client"/);
    // No write-side HTTP methods.
    expect(src).not.toMatch(/method:\s*"POST"/);
    expect(src).not.toMatch(/method:\s*"PUT"/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).not.toMatch(/method:\s*"PATCH"/);
  });

  it("items.ts never imports the direct OAuth client + never uses write methods", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "items.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\/client"/);
    expect(src).not.toMatch(/method:\s*"POST"/);
    expect(src).not.toMatch(/method:\s*"PUT"/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).not.toMatch(/method:\s*"PATCH"/);
  });

  it("customers.ts never imports the direct OAuth client + never uses write methods", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "customers.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/zoho\/client"/);
    expect(src).not.toMatch(/method:\s*"POST"/);
    expect(src).not.toMatch(/method:\s*"PUT"/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).not.toMatch(/method:\s*"PATCH"/);
  });

  it("ZOHO-2A modules never write into products/tablet_types/packaging_materials/customers", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ["items.ts", "customers.ts", "sync-dry-run.ts"]) {
      const src = readFileSync(resolve(here, f), "utf8");
      // No insert/update/delete into the master tables. The string
      // match is loose on purpose: a real write would always contain
      // one of these patterns somewhere.
      expect(src).not.toMatch(/\.insert\(\s*products\s*\)/);
      expect(src).not.toMatch(/\.insert\(\s*tabletTypes\s*\)/);
      expect(src).not.toMatch(/\.insert\(\s*packagingMaterials\s*\)/);
      expect(src).not.toMatch(/\.insert\(\s*customers\s*\)/);
      expect(src).not.toMatch(/\.update\(\s*products\s*\)/);
      expect(src).not.toMatch(/\.update\(\s*tabletTypes\s*\)/);
      expect(src).not.toMatch(/\.update\(\s*packagingMaterials\s*\)/);
      expect(src).not.toMatch(/\.update\(\s*customers\s*\)/);
    }
  });
});
