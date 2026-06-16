// WAREHOUSE-RESOLUTION-v1.3.0 — source-level contract tests.
//
// Pin cross-file invariants so they survive future edits:
//
//   * The preview action calls the new resolver.
//   * Settings + product admin both persist warehouse IDs.
//   * Post-commit verification still uses the LIVE inventory path.
//   * No code path imports a cached endpoint yet (Zoho v1.23.0
//     hasn't shipped; we are NOT switching until it does).
//   * Migration 0066 is shaped correctly and registered in the
//     drizzle journal.
//   * Schema mirror has the column.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

const MIGRATION_PATH = "drizzle/0066_product_zoho_default_warehouse_id.sql";
const JOURNAL_PATH = "drizzle/meta/_journal.json";
const SCHEMA_PATH = "lib/db/schema.ts";
const RESOLVER_PATH = "lib/zoho/warehouse-resolution.ts";
const PREVIEW_ACTIONS_PATH =
  "app/(admin)/finished-lots/[id]/zoho-production-output-preview-actions.ts";
const SETTINGS_FORM_PATH = "app/(admin)/settings/zoho/form.tsx";
const SETTINGS_ACTIONS_PATH = "app/(admin)/settings/zoho/actions.ts";
const PRODUCT_PAGE_PATH = "app/(admin)/products/[id]/page.tsx";
const PRODUCT_FORM_PATH = "app/(admin)/products/[id]/zoho-mapping-form.tsx";
const PRODUCT_ACTIONS_PATH =
  "app/(admin)/products/[id]/zoho-mapping-actions.ts";
const PRODUCT_QUERIES_PATH = "lib/db/queries/products.ts";
const VERIFICATION_PATH = "lib/zoho/purchase-receive-verification.ts";
const INVENTORY_CLIENT_PATH = "lib/zoho/inventory-service-client.ts";
const PRODUCTION_OUTPUT_CONFIG_PATH = "lib/zoho/production-output-config.ts";

describe("Migration 0066 — additive product.zoho_default_warehouse_id", () => {
  it("migration file adds the column with ADD COLUMN IF NOT EXISTS (additive only)", () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).toMatch(/ALTER TABLE "products"/);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "zoho_default_warehouse_id" text/,
    );
  });

  it("migration is purely additive — no DROP, RENAME, or type change", () => {
    const sql = read(MIGRATION_PATH);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER COLUMN[\s\S]+TYPE\b/i);
  });

  it("journal has 0066 registered with a strictly greater 'when' than 0065", () => {
    const journal = JSON.parse(read(JOURNAL_PATH)) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const overs = journal.entries.find(
      (e) => e.tag === "0065_zoho_raw_bag_overs_resolution",
    );
    const wh = journal.entries.find(
      (e) => e.tag === "0066_product_zoho_default_warehouse_id",
    );
    expect(overs).toBeDefined();
    expect(wh).toBeDefined();
    expect(wh!.idx).toBe(overs!.idx + 1);
    expect(wh!.when).toBeGreaterThan(overs!.when);
  });

  it("schema mirror has the zohoDefaultWarehouseId column on products", () => {
    const schema = read(SCHEMA_PATH);
    expect(schema).toMatch(
      /zohoDefaultWarehouseId:\s*text\("zoho_default_warehouse_id"\)/,
    );
  });
});

describe("Preview action wires the resolver into the preview flow", () => {
  it("imports resolveProductionOutputWarehouseId from the canonical module", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    expect(src).toMatch(
      /import\s*\{\s*resolveProductionOutputWarehouseId\s*\}\s*from\s*"@\/lib\/zoho\/warehouse-resolution"/,
    );
  });

  it("calls the resolver with all four candidate sources", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    expect(src).toMatch(/operatorOverride:\s*parsed\.data\.warehouseId/);
    expect(src).toMatch(
      /productWarehouseId:\s*lot\.product\.zohoDefaultWarehouseId/,
    );
    // Either explicit `key: value` OR shorthand `key,` is fine —
    // both wire the same local through.
    expect(src).toMatch(/appSettingsWarehouseId(?::\s*appSettingsWarehouseId)?\s*,/);
    expect(src).toMatch(/envWarehouseId:\s*config\.defaultWarehouseId/);
  });

  it("returns a PAYLOAD_BLOCKED with the canonical message on miss", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    expect(src).toMatch(/kind:\s*"PAYLOAD_BLOCKED"/);
    expect(src).toMatch(/field:\s*"warehouse_id"/);
    expect(src).toMatch(/warehouseResolution\.reason/);
  });

  it("loads the app-settings warehouse from zoho_credentials (not env)", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    expect(src).toMatch(/loadAppSettingsWarehouseId/);
    expect(src).toMatch(/zohoCredentials\.warehouseId/);
  });

  it("selects products.zohoDefaultWarehouseId in the lot loader", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    expect(src).toMatch(
      /zohoDefaultWarehouseId:\s*products\.zohoDefaultWarehouseId/,
    );
  });

  it("does NOT use the prior operator-or-env-only fallback expression", () => {
    const src = read(PREVIEW_ACTIONS_PATH);
    // The pre-v1.3.0 line was:
    //   parsed.data.warehouseId || config.defaultWarehouseId || ""
    // It must be gone; the resolver owns this now.
    expect(src).not.toMatch(
      /parsed\.data\.warehouseId\s*\|\|\s*config\.defaultWarehouseId\s*\|\|\s*""/,
    );
  });
});

describe("Settings UI persists the app-level default warehouse", () => {
  it("settings form still has the warehouseId input wired to the save action", () => {
    const form = read(SETTINGS_FORM_PATH);
    expect(form).toMatch(/name="warehouseId"/);
    expect(form).toMatch(/initial\?\.warehouseId/);
  });

  it("settings form announces the v1.23.0 cached-dropdown follow-up", () => {
    const form = read(SETTINGS_FORM_PATH);
    // Helper copy spans multiple lines — match across whitespace.
    expect(form).toMatch(/Cached[\s\S]+warehouse dropdown[\s\S]+gateway v1\.23\.0/);
  });

  it("settings save action persists warehouseId on insert AND update branches", () => {
    const actions = read(SETTINGS_ACTIONS_PATH);
    // Insert branch
    expect(actions).toMatch(
      /\.values\(\{[\s\S]+warehouseId:\s*parsed\.data\.warehouseId\s*\?\?\s*null/,
    );
    // Update branch
    expect(actions).toMatch(
      /\.set\(\{[\s\S]+warehouseId:\s*parsed\.data\.warehouseId\s*\?\?\s*null/,
    );
  });
});

describe("Product admin persists the per-product override", () => {
  it("ProductInput type carries the new field through updateProduct", () => {
    const queries = read(PRODUCT_QUERIES_PATH);
    expect(queries).toMatch(
      /zohoDefaultWarehouseId\?:\s*string\s*\|\s*null\s*\|\s*undefined/,
    );
  });

  it("product action schema parses zohoDefaultWarehouseId from the form", () => {
    const actions = read(PRODUCT_ACTIONS_PATH);
    expect(actions).toMatch(/zohoDefaultWarehouseId:\s*z\.string\(\)/);
    expect(actions).toMatch(
      /zohoDefaultWarehouseId:\s*\([\s\S]*formData\.get\("zohoDefaultWarehouseId"\)/,
    );
  });

  it("product form renders the override input wired to the action", () => {
    const form = read(PRODUCT_FORM_PATH);
    expect(form).toMatch(/name="zohoDefaultWarehouseId"/);
    expect(form).toMatch(/defaultValue=\{zohoDefaultWarehouseId\s*\?\?\s*""\}/);
  });

  it("product page passes the current value and app-settings hint to the form", () => {
    const page = read(PRODUCT_PAGE_PATH);
    expect(page).toMatch(
      /zohoDefaultWarehouseId=\{product\.zohoDefaultWarehouseId\s*\?\?\s*null\}/,
    );
    expect(page).toMatch(
      /appSettingsWarehouseId=\{appSettingsWarehouseId\}/,
    );
  });
});

describe("Post-commit verification still uses the LIVE inventory path", () => {
  it("purchase-receive-verification imports getInventoryPurchaseReceive directly (not a cached variant)", () => {
    const src = read(VERIFICATION_PATH);
    expect(src).toMatch(
      /import\s*\{\s*getInventoryPurchaseReceive\s*\}\s*from\s*"@\/lib\/zoho\/inventory-service-client"/,
    );
  });

  it("inventory-service-client builds purchase-receive path against /zoho/purchase_receives/get/", () => {
    const src = read(INVENTORY_CLIENT_PATH);
    // Live (uncached) endpoint for verifying a receive we just wrote.
    expect(src).toMatch(/\/zoho\/purchase_receives\/get\//);
  });
});

describe("No cached endpoint paths are used yet (Zoho v1.23.0 has not landed)", () => {
  const FILES_THAT_MUST_NOT_REFERENCE_CACHED = [
    INVENTORY_CLIENT_PATH,
    PREVIEW_ACTIONS_PATH,
    RESOLVER_PATH,
    PRODUCTION_OUTPUT_CONFIG_PATH,
    PRODUCT_FORM_PATH,
    PRODUCT_ACTIONS_PATH,
    SETTINGS_FORM_PATH,
    SETTINGS_ACTIONS_PATH,
  ];

  it.each(FILES_THAT_MUST_NOT_REFERENCE_CACHED)(
    "%s does not import or call /zoho/cached/*",
    (rel) => {
      const src = read(rel);
      expect(src).not.toMatch(/\/zoho\/cached\//);
      expect(src).not.toMatch(/cachedPurchaseOrders/);
      expect(src).not.toMatch(/listPurchaseOrdersInvCached/);
    },
  );

  it("the new resolver helper has no I/O — it is a pure function", () => {
    const src = read(RESOLVER_PATH);
    expect(src).not.toMatch(/from\s*"@\/lib\/db/);
    // The docstring mentions `process.env.ZOHO_WAREHOUSE_ID` for
    // context; what matters is that no code reads it directly.
    // Strip comments before checking for an actual env read.
    const codeOnly = src
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/process\.env/);
    expect(codeOnly).not.toMatch(/\bfetch\(/);
    expect(codeOnly).not.toMatch(/\bawait\b/);
  });
});

describe("production-output-config doc comment marks defaultWarehouseId as env-fallback only", () => {
  it("the defaultWarehouseId field has the v1.3.0 disclaimer comment", () => {
    const src = read(PRODUCTION_OUTPUT_CONFIG_PATH);
    expect(src).toMatch(/WAREHOUSE-RESOLUTION-v1\.3\.0/);
    expect(src).toMatch(/Env-level fallback/);
  });
});
