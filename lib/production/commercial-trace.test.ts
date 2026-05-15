// COMMERCIAL-TRACE-2 — schema + helper tests.
//
// Validates:
//   1. The three new tables (zoho_invoices, zoho_invoice_lines,
//      finished_lot_invoice_allocations) are exported from
//      lib/db/schema and have the expected columns.
//   2. shipment_finished_lots gained the invoice_allocation_status +
//      last_invoice_allocation_at columns.
//   3. zoho_sync_kind enum includes INVOICES.
//   4. Helpers in lib/production/commercial-trace.ts behave per spec.
//   5. Visibility policy hides supplier_lot / internal_receipt /
//      raw_bag_qr / operator / machine for customer scope and permits
//      them for CSR / internal scope.
//   6. Safety: no nexus_complaints / complaint webhook / complaint
//      attachment tables, no live Zoho call wiring landed.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  zohoInvoices,
  zohoInvoiceLines,
  finishedLotInvoiceAllocations,
  shipmentFinishedLots,
  zohoSyncKindEnum,
} from "@/lib/db/schema";
import {
  ALLOCATION_CONFIDENCE_VALUES,
  ALLOCATION_STATUS_VALUES,
  CSR_ONLY_COMMERCIAL_TRACE_FIELDS,
  commercialTraceVisibilityPolicy,
  isCustomerSafeCommercialTraceField,
  normalizeInvoiceNumber,
  normalizeZohoInvoiceLineKey,
  validateAllocationQuantity,
} from "@/lib/production/commercial-trace";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("COMMERCIAL-TRACE-2 · schema shape", () => {
  it("zoho_invoices table is exported with the spec columns", () => {
    const cols = Object.keys(zohoInvoices) as string[];
    for (const required of [
      "id",
      "zohoInvoiceId",
      "invoiceNumber",
      "zohoCustomerId",
      "customerId",
      "invoiceDate",
      "status",
      "currency",
      "subtotal",
      "total",
      "balance",
      "rawPayload",
      "lastSeenAt",
      "lastSyncedAt",
      "createdAt",
      "updatedAt",
    ]) {
      expect(cols).toContain(required);
    }
  });

  it("zoho_invoice_lines table is exported with the spec columns", () => {
    const cols = Object.keys(zohoInvoiceLines) as string[];
    for (const required of [
      "id",
      "zohoInvoiceId",
      "zohoInvoiceLineId",
      "zohoItemId",
      "sku",
      "itemName",
      "description",
      "quantity",
      "unit",
      "rate",
      "amount",
      "rawPayload",
      "createdAt",
      "updatedAt",
    ]) {
      expect(cols).toContain(required);
    }
  });

  it("finished_lot_invoice_allocations table is exported with the spec columns", () => {
    const cols = Object.keys(finishedLotInvoiceAllocations) as string[];
    for (const required of [
      "id",
      "invoiceLineId",
      "finishedLotId",
      "shipmentFinishedLotId",
      "quantityAllocated",
      "unit",
      "confidence",
      "source",
      "status",
      "confirmed",
      "confirmedByUserId",
      "confirmedAt",
      "notes",
      "createdAt",
      "updatedAt",
    ]) {
      expect(cols).toContain(required);
    }
  });

  it("shipment_finished_lots gained invoice-allocation columns", () => {
    const cols = Object.keys(shipmentFinishedLots) as string[];
    expect(cols).toContain("invoiceAllocationStatus");
    expect(cols).toContain("lastInvoiceAllocationAt");
  });

  it("zoho_sync_kind enum includes INVOICES", () => {
    // Drizzle's pgEnum exposes the values via `.enumValues` at runtime.
    const values = (
      zohoSyncKindEnum as unknown as { enumValues: readonly string[] }
    ).enumValues;
    expect(values).toContain("INVOICES");
    // Preserves the existing vocabulary.
    for (const existing of [
      "CONNECTIVITY_CHECK",
      "ITEMS",
      "CUSTOMERS",
      "SALES_ORDERS",
      "PURCHASE_ORDERS",
      "FINISHED_LOT_PUSH",
    ]) {
      expect(values).toContain(existing);
    }
  });
});

describe("COMMERCIAL-TRACE-2 · migration files", () => {
  it("0035 adds INVOICES to zoho_sync_kind via standalone ALTER TYPE", () => {
    const sql = readRepoFile("drizzle/0035_zoho_sync_kind_invoices.sql");
    expect(sql).toMatch(/ALTER TYPE "zoho_sync_kind" ADD VALUE/);
    expect(sql).toMatch(/'INVOICES'/);
  });

  it("0036 creates the three new tables and extends shipment_finished_lots", () => {
    const sql = readRepoFile("drizzle/0036_commercial_trace_schema.sql");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "zoho_invoices"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "zoho_invoice_lines"/);
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS "finished_lot_invoice_allocations"/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "shipment_finished_lots"[\s\S]*"invoice_allocation_status"/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "shipment_finished_lots"[\s\S]*"last_invoice_allocation_at"/,
    );
    // Quantity-positive CHECK constraint enforced at the DB.
    expect(sql).toMatch(
      /finished_lot_invoice_allocations_quantity_positive[\s\S]*CHECK[\s\S]*"quantity_allocated" > 0/,
    );
  });

  it("journal registers idx 35 and idx 36", () => {
    const journal = JSON.parse(
      readRepoFile("drizzle/meta/_journal.json"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0035_zoho_sync_kind_invoices");
    expect(tags).toContain("0036_commercial_trace_schema");
  });
});

describe("COMMERCIAL-TRACE-2 · allocation invariants", () => {
  it("confidence vocabulary supports HIGH / MEDIUM / LOW / MISSING", () => {
    expect([...ALLOCATION_CONFIDENCE_VALUES]).toEqual([
      "HIGH",
      "MEDIUM",
      "LOW",
      "MISSING",
    ]);
  });

  it("status vocabulary supports SUGGESTED / CONFIRMED / REJECTED / NEEDS_REVIEW", () => {
    expect([...ALLOCATION_STATUS_VALUES]).toEqual([
      "SUGGESTED",
      "CONFIRMED",
      "REJECTED",
      "NEEDS_REVIEW",
    ]);
  });

  it("quantity must be strictly positive", () => {
    expect(validateAllocationQuantity(0)).toMatchObject({ ok: false });
    expect(validateAllocationQuantity(-1)).toMatchObject({ ok: false });
    expect(validateAllocationQuantity(Number.NaN)).toMatchObject({ ok: false });
    expect(validateAllocationQuantity(Number.POSITIVE_INFINITY)).toMatchObject({
      ok: false,
    });
    expect(validateAllocationQuantity(0.0001)).toMatchObject({
      ok: true,
      value: 0.0001,
    });
    expect(validateAllocationQuantity(1234)).toMatchObject({
      ok: true,
      value: 1234,
    });
  });

  it("invoice line FK + finished lot FK are not unique-paired in schema (M:N allowed)", () => {
    // The table intentionally does NOT carry a uniqueIndex on
    // (invoice_line_id, finished_lot_id) — one invoice line can spread
    // across multiple finished lots, one finished lot can satisfy
    // multiple invoice lines. The Drizzle table extras helper exposes
    // the configured indexes; assert no unique index over that pair.
    const extras = (
      finishedLotInvoiceAllocations as unknown as {
        _: {
          config?: {
            indexes?: Array<{ config: { unique?: boolean; columns: unknown[] } }>;
          };
        };
      }
    )._?.config?.indexes;
    // Drizzle internals are opaque enough that the safest test is to
    // read the migration source and assert there's no
    // ON ("invoice_line_id", "finished_lot_id") unique index there.
    void extras;
    const sql = readRepoFile("drizzle/0036_commercial_trace_schema.sql");
    expect(sql).not.toMatch(
      /UNIQUE INDEX[^"]*finished_lot_invoice_allocations[^"]*\("invoice_line_id", *"finished_lot_id"\)/,
    );
  });
});

describe("COMMERCIAL-TRACE-2 · visibility policy", () => {
  it("customer scope hides supplier lot", () => {
    const p = commercialTraceVisibilityPolicy("customer");
    expect(p.allowField("supplier_lot")).toBe(false);
    expect(p.allowField("supplier_lot_number")).toBe(false);
    expect(p.allowField("vendor_lot_number")).toBe(false);
  });

  it("customer scope hides internal receipt number", () => {
    const p = commercialTraceVisibilityPolicy("customer");
    expect(p.allowField("internal_receipt_number")).toBe(false);
  });

  it("customer scope hides raw bag QR", () => {
    const p = commercialTraceVisibilityPolicy("customer");
    expect(p.allowField("raw_bag_qr")).toBe(false);
    expect(p.allowField("bag_qr_code")).toBe(false);
  });

  it("customer scope hides operator and machine details", () => {
    const p = commercialTraceVisibilityPolicy("customer");
    expect(p.allowField("operator_name")).toBe(false);
    expect(p.allowField("operator_id")).toBe(false);
    expect(p.allowField("employee_name")).toBe(false);
    expect(p.allowField("employee_id")).toBe(false);
    expect(p.allowField("machine_id")).toBe(false);
    expect(p.allowField("machine_label")).toBe(false);
    expect(p.allowField("station_id")).toBe(false);
    expect(p.allowField("station_label")).toBe(false);
    expect(p.allowField("qc_history")).toBe(false);
  });

  it("customer scope still permits customer-safe fields", () => {
    const p = commercialTraceVisibilityPolicy("customer");
    for (const safe of [
      "finished_lot_number",
      "trace_code",
      "invoice_number",
      "invoice_date",
      "customer_name",
      "product_name",
      "sku",
      "expiry_date",
      "produced_on",
    ]) {
      expect(p.allowField(safe)).toBe(true);
    }
  });

  it("CSR scope permits the CSR-only fields", () => {
    const p = commercialTraceVisibilityPolicy("csr");
    for (const field of CSR_ONLY_COMMERCIAL_TRACE_FIELDS) {
      expect(p.allowField(field)).toBe(true);
    }
    expect(p.blockedFields).toEqual([]);
  });

  it("internal scope behaves like CSR (full visibility)", () => {
    const p = commercialTraceVisibilityPolicy("internal");
    expect(p.allowField("supplier_lot")).toBe(true);
    expect(p.allowField("operator_name")).toBe(true);
    expect(p.blockedFields).toEqual([]);
  });

  it("isCustomerSafeCommercialTraceField is case-insensitive", () => {
    expect(isCustomerSafeCommercialTraceField("Supplier_Lot")).toBe(false);
    expect(isCustomerSafeCommercialTraceField("RAW_BAG_QR")).toBe(false);
    expect(isCustomerSafeCommercialTraceField(" operator_name ")).toBe(false);
    expect(isCustomerSafeCommercialTraceField("Trace_Code")).toBe(true);
  });

  it("empty / whitespace field names are rejected (never accidentally exposed)", () => {
    expect(isCustomerSafeCommercialTraceField("")).toBe(false);
    expect(isCustomerSafeCommercialTraceField("   ")).toBe(false);
  });
});

describe("COMMERCIAL-TRACE-2 · normalizers", () => {
  it("normalizeInvoiceNumber trims, uppercases, collapses whitespace", () => {
    expect(normalizeInvoiceNumber("  inv-001  ")).toBe("INV-001");
    expect(normalizeInvoiceNumber("inv 001")).toBe("INV 001");
    expect(normalizeInvoiceNumber("inv\t002")).toBe("INV 002");
    expect(normalizeInvoiceNumber("")).toBeNull();
    expect(normalizeInvoiceNumber("   ")).toBeNull();
    expect(normalizeInvoiceNumber(null)).toBeNull();
    expect(normalizeInvoiceNumber(undefined)).toBeNull();
    expect(normalizeInvoiceNumber(42 as unknown as string)).toBeNull();
  });

  it("normalizeZohoInvoiceLineKey requires both parts non-empty", () => {
    expect(normalizeZohoInvoiceLineKey("inv-1", "line-1")).toBe(
      "inv-1::line-1",
    );
    expect(normalizeZohoInvoiceLineKey("inv-1", "")).toBeNull();
    expect(normalizeZohoInvoiceLineKey("", "line-1")).toBeNull();
    expect(normalizeZohoInvoiceLineKey("inv-1", null)).toBeNull();
    expect(normalizeZohoInvoiceLineKey(null, "line-1")).toBeNull();
    expect(normalizeZohoInvoiceLineKey("  inv-1  ", "  line-1  ")).toBe(
      "inv-1::line-1",
    );
  });
});

describe("COMMERCIAL-TRACE-2 · safety guardrails", () => {
  it("no nexus_complaints table is created in the schema", () => {
    const schemaSrc = readRepoFile("lib/db/schema.ts");
    expect(schemaSrc).not.toMatch(/nexus_complaints|nexusComplaints/);
  });

  it("no complaint webhook / attachment / status-history tables landed", () => {
    const schemaSrc = readRepoFile("lib/db/schema.ts");
    expect(schemaSrc).not.toMatch(/complaint_webhook/);
    expect(schemaSrc).not.toMatch(/complaint_attachments/);
    expect(schemaSrc).not.toMatch(/complaint_status_history/);
  });

  it("no live Zoho fetch wiring was introduced (no new client code)", () => {
    // Helper is pure — no fs / net / db imports.
    const helperSrc = readRepoFile("lib/production/commercial-trace.ts");
    expect(helperSrc).not.toMatch(/from\s+["']@\/lib\/db/);
    expect(helperSrc).not.toMatch(/from\s+["']@\/lib\/integrations\/zoho/);
    expect(helperSrc).not.toMatch(/fetch\s*\(|axios|node:http/);
  });

  it("no Nexus endpoint was added under app/api/nexus for invoice lookup yet", () => {
    const nexusDir = path.join(REPO_ROOT, "app", "api", "nexus");
    if (!fs.existsSync(nexusDir)) {
      // No nexus API tree means no invoice endpoint by definition.
      expect(true).toBe(true);
      return;
    }
    // Recurse and assert no file references zoho_invoices / invoice-batches.
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else out.push(p);
      }
      return out;
    }
    const files = walk(nexusDir);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).not.toMatch(/zoho_invoices|invoice-batches|customer-batches/);
    }
  });
});
