// COMMERCIAL-TRACE-6 — auth, scope, sanitizer, and response-builder tests.
//
// Pure logic only. Routes are exercised at the source-shape level by
// nexus-routes-shape.test.ts.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  authenticateNexusLookupRequest,
  buildBatchPassportResponse,
  buildCustomerBatchesResponse,
  buildInvoiceBatchesResponse,
  buildNexusBatchDropdownLabel,
  extractBearerToken,
  resolveNexusLookupScope,
  safeEqual,
  sanitizeNexusBatchForScope,
  sanitizeNexusPassportForScope,
  validateNexusLookupConfig,
  type NexusBatchRow,
  type NexusPassportRow,
} from "@/lib/integrations/nexus/lookup";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function mkBatch(over: Partial<NexusBatchRow> = {}): NexusBatchRow {
  return {
    shipment_finished_lot_id: "sfl-1",
    finished_lot_id: "fl-1",
    trace_code: "FL-2026-001",
    product_name: "Mango Peach 30ct",
    product_sku: "HN-MP-30",
    quantity: 12,
    unit: "cases",
    packed_at: "2026-05-10T12:00:00.000Z",
    shipped_at: "2026-05-18T12:00:00.000Z",
    dropdown_label: "",
    confidence: "HIGH",
    warnings: [],
    supplier_lot_number: "QA-1243",
    internal_receipt_number: "QA-R1001",
    raw_bag_qr: "BAG-abc-def",
    operator_name: "Alice",
    machine_id: "M-2",
    ...over,
  };
}

function mkPassport(over: Partial<NexusPassportRow> = {}): NexusPassportRow {
  return {
    trace_code: "FL-2026-001",
    finished_lot_id: "fl-1",
    shipment_finished_lot_id: "sfl-1",
    product_name: "Mango Peach 30ct",
    product_sku: "HN-MP-30",
    packed_at: "2026-05-10T12:00:00.000Z",
    shipped_at: "2026-05-18T12:00:00.000Z",
    quantity: 12,
    unit: "cases",
    warnings: ["No customer linkage recorded."],
    missing_links: [],
    supplier_lots: [{ batch_number: "QA-1243", vendor_name: "QA Vendor" }],
    raw_bag_receipts: ["QA-R1001"],
    raw_bag_qrs: ["BAG-abc-def"],
    pos: [{ po_number: "QA-PO-1", vendor_name: "QA Vendor" }],
    operators: ["Alice"],
    machines: ["M-2"],
    qc_events: [
      { event_type: "BLISTER_DAMAGE_REPORT", occurred_at: "2026-05-12T10:00:00.000Z" },
    ],
    packaging_lots: [
      { material_name: "PVC clear", roll_number: "PVC-23-A-04", supplier: "ACME" },
    ],
    ...over,
  };
}

const fakeReq = (headers: Record<string, string>, url = "http://localhost/api"): {
  headers: { get: (n: string) => string | null };
  url: string;
} => ({
  url,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? headers[n] ?? null },
});

// ─── Config ──────────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · validateNexusLookupConfig", () => {
  it("returns configured=false when no tokens are set", () => {
    const r = validateNexusLookupConfig({});
    expect(r.configured).toBe(false);
    expect(r.hasCustomerToken).toBe(false);
    expect(r.hasCsrToken).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it("configured=true when at least one token is set", () => {
    expect(validateNexusLookupConfig({ NEXUS_LOOKUP_TOKEN: "x" }).configured).toBe(true);
    expect(validateNexusLookupConfig({ NEXUS_CSR_LOOKUP_TOKEN: "y" }).configured).toBe(true);
    expect(
      validateNexusLookupConfig({ NEXUS_LOOKUP_TOKEN: "  " }).configured,
    ).toBe(false);
  });
});

// ─── Auth ────────────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · authenticateNexusLookupRequest", () => {
  it("503 when no tokens configured", () => {
    const r = authenticateNexusLookupRequest(fakeReq({ authorization: "Bearer x" }), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.httpStatus).toBe(503);
      expect(r.error.code).toBe("NEXUS_LOOKUP_NOT_CONFIGURED");
    }
  });

  it("401 when Authorization header missing", () => {
    const r = authenticateNexusLookupRequest(fakeReq({}), {
      NEXUS_LOOKUP_TOKEN: "cust-tok",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.httpStatus).toBe(401);
      // Must not echo the token in the error message.
      expect(r.error.message).not.toContain("cust-tok");
    }
  });

  it("401 when token does not match either configured value", () => {
    const r = authenticateNexusLookupRequest(
      fakeReq({ authorization: "Bearer wrong" }),
      { NEXUS_LOOKUP_TOKEN: "cust-tok", NEXUS_CSR_LOOKUP_TOKEN: "csr-tok" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.httpStatus).toBe(401);
  });

  it("customer scope on matching customer token", () => {
    const r = authenticateNexusLookupRequest(
      fakeReq({ authorization: "Bearer cust-tok" }),
      { NEXUS_LOOKUP_TOKEN: "cust-tok" },
    );
    expect(r).toMatchObject({ ok: true, scope: "customer" });
  });

  it("csr scope on matching CSR token", () => {
    const r = authenticateNexusLookupRequest(
      fakeReq({ authorization: "Bearer csr-tok" }),
      { NEXUS_CSR_LOOKUP_TOKEN: "csr-tok" },
    );
    expect(r).toMatchObject({ ok: true, scope: "csr" });
  });

  it("ignores extra whitespace and is case-insensitive on the scheme", () => {
    const r = authenticateNexusLookupRequest(
      fakeReq({ authorization: "  bearer    cust-tok   " }),
      { NEXUS_LOOKUP_TOKEN: "cust-tok" },
    );
    expect(r).toMatchObject({ ok: true, scope: "customer" });
  });

  it("never echoes the token in any returned message", () => {
    const r = authenticateNexusLookupRequest(
      fakeReq({ authorization: "Bearer cust-tok" }),
      { NEXUS_CSR_LOOKUP_TOKEN: "different" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).not.toContain("cust-tok");
      expect(r.error.message).not.toContain("different");
    }
  });
});

describe("COMMERCIAL-TRACE-6 · extractBearerToken / safeEqual", () => {
  it("returns the token from a well-formed Authorization header", () => {
    expect(extractBearerToken({ get: () => "Bearer abc-123" })).toBe("abc-123");
  });
  it("returns null for empty / non-Bearer / missing header", () => {
    expect(extractBearerToken({ get: () => null })).toBeNull();
    expect(extractBearerToken({ get: () => "Basic abc" })).toBeNull();
    expect(extractBearerToken({ get: () => "Bearer  " })).toBeNull();
  });
  it("safeEqual compares equal strings as true and unequal as false", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

// ─── Scope resolution ────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · resolveNexusLookupScope", () => {
  it("customer auth always gives customer scope, regardless of ?scope=", () => {
    expect(
      resolveNexusLookupScope(
        fakeReq({}, "http://localhost/api?scope=csr"),
        "customer",
      ),
    ).toBe("customer");
  });
  it("CSR auth defaults to csr but allows ?scope=customer for preview", () => {
    expect(resolveNexusLookupScope(fakeReq({}, "http://localhost/api"), "csr")).toBe("csr");
    expect(
      resolveNexusLookupScope(
        fakeReq({}, "http://localhost/api?scope=customer"),
        "csr",
      ),
    ).toBe("customer");
  });
});

// ─── Dropdown label ──────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · buildNexusBatchDropdownLabel", () => {
  it("composes product + trace + shipped date", () => {
    expect(
      buildNexusBatchDropdownLabel({
        product_name: "Mango Peach 30ct",
        trace_code: "FL-2026-001",
        shipped_at: "2026-05-18T12:00:00.000Z",
      }),
    ).toBe("Mango Peach 30ct — FL-2026-001 — Shipped May 18");
  });
  it("falls back to packed when shipped missing", () => {
    expect(
      buildNexusBatchDropdownLabel({
        product_name: "Mango Peach 30ct",
        trace_code: "FL-2026-001",
        packed_at: "2026-05-10T00:00:00.000Z",
      }),
    ).toBe("Mango Peach 30ct — FL-2026-001 — Packed May 10");
  });
  it("returns 'Untitled batch' when nothing usable", () => {
    expect(buildNexusBatchDropdownLabel({})).toBe("Untitled batch");
  });
});

// ─── Sanitizers ──────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · sanitizeNexusBatchForScope", () => {
  it("customer scope strips supplier_lot / internal_receipt / raw_bag_qr / operator / machine", () => {
    const clean = sanitizeNexusBatchForScope(mkBatch(), "customer");
    expect(clean.trace_code).toBe("FL-2026-001");
    expect(clean.product_sku).toBe("HN-MP-30");
    expect("supplier_lot_number" in clean).toBe(false);
    expect("internal_receipt_number" in clean).toBe(false);
    expect("raw_bag_qr" in clean).toBe(false);
    expect("operator_name" in clean).toBe(false);
    expect("machine_id" in clean).toBe(false);
  });
  it("csr scope preserves CSR-only fields", () => {
    const clean = sanitizeNexusBatchForScope(mkBatch(), "csr");
    expect(clean.supplier_lot_number).toBe("QA-1243");
    expect(clean.internal_receipt_number).toBe("QA-R1001");
    expect(clean.raw_bag_qr).toBe("BAG-abc-def");
    expect(clean.operator_name).toBe("Alice");
    expect(clean.machine_id).toBe("M-2");
  });
});

describe("COMMERCIAL-TRACE-6 · sanitizeNexusPassportForScope", () => {
  it("customer scope drops supplier_lots, raw_bag_receipts, raw_bag_qrs, operators, machines, qc_events, packaging_lots", () => {
    const clean = sanitizeNexusPassportForScope(mkPassport(), "customer");
    expect("supplier_lots" in clean).toBe(false);
    expect("raw_bag_receipts" in clean).toBe(false);
    expect("raw_bag_qrs" in clean).toBe(false);
    expect("operators" in clean).toBe(false);
    expect("machines" in clean).toBe(false);
    expect("qc_events" in clean).toBe(false);
    expect("packaging_lots" in clean).toBe(false);
    // Customer-safe fields preserved.
    expect(clean.trace_code).toBe("FL-2026-001");
    expect(clean.product_sku).toBe("HN-MP-30");
    expect(clean.quantity).toBe(12);
    expect(clean.warnings).toEqual(["No customer linkage recorded."]);
  });
  it("csr scope preserves the full passport", () => {
    const clean = sanitizeNexusPassportForScope(mkPassport(), "csr");
    expect(clean.supplier_lots?.[0]?.batch_number).toBe("QA-1243");
    expect(clean.raw_bag_receipts?.[0]).toBe("QA-R1001");
    expect(clean.raw_bag_qrs?.[0]).toBe("BAG-abc-def");
    expect(clean.operators?.[0]).toBe("Alice");
    expect(clean.machines?.[0]).toBe("M-2");
    expect(clean.qc_events?.[0]?.event_type).toBe("BLISTER_DAMAGE_REPORT");
    expect(clean.packaging_lots?.[0]?.material_name).toBe("PVC clear");
  });
});

// ─── Response builders ───────────────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · buildInvoiceBatchesResponse", () => {
  it("strips CSR-only fields for customer scope + auto-fills dropdown labels", () => {
    const body = buildInvoiceBatchesResponse({
      scope: "customer",
      invoice: {
        invoice_number: "INV-001",
        invoice_date: "2026-05-10",
        customer_code: "C7",
        nexus_customer_id: "NEX-C7",
      },
      batches: [mkBatch()],
    });
    expect(body.scope).toBe("customer");
    expect(body.batches[0]!.dropdown_label).toContain("Mango Peach 30ct");
    expect("supplier_lot_number" in body.batches[0]!).toBe(false);
  });

  it("CSR scope preserves CSR-only fields", () => {
    const body = buildInvoiceBatchesResponse({
      scope: "csr",
      invoice: {
        invoice_number: "INV-001",
        invoice_date: "2026-05-10",
        customer_code: "C7",
        nexus_customer_id: "NEX-C7",
      },
      batches: [mkBatch()],
    });
    expect(body.batches[0]!.supplier_lot_number).toBe("QA-1243");
    expect(body.batches[0]!.internal_receipt_number).toBe("QA-R1001");
  });

  it("empty batches surfaces as honest empty list", () => {
    const body = buildInvoiceBatchesResponse({
      scope: "customer",
      invoice: {
        invoice_number: "INV-X",
        invoice_date: null,
        customer_code: null,
        nexus_customer_id: null,
      },
      batches: [],
      warnings: ["No confirmed allocations exist for this invoice yet."],
    });
    expect(body.batches).toEqual([]);
    expect(body.warnings[0]).toMatch(/no confirmed allocations/i);
  });
});

describe("COMMERCIAL-TRACE-6 · buildCustomerBatchesResponse", () => {
  it("preserves customer + filter shape and sanitizes batches", () => {
    const body = buildCustomerBatchesResponse({
      scope: "customer",
      customer: { customer_code: "C7", nexus_customer_id: "NEX-C7" },
      filters: {
        product_sku: "HN-MP-30",
        date_from: "2026-05-01",
        date_to: "2026-05-31",
        active_only: true,
      },
      batches: [mkBatch()],
    });
    expect(body.customer.customer_code).toBe("C7");
    expect(body.filters.active_only).toBe(true);
    expect("supplier_lot_number" in body.batches[0]!).toBe(false);
  });
});

describe("COMMERCIAL-TRACE-6 · buildBatchPassportResponse", () => {
  it("customer-scope passport has no CSR-only fields", () => {
    const body = buildBatchPassportResponse({
      scope: "customer",
      passport: mkPassport(),
    });
    expect("supplier_lots" in body.passport).toBe(false);
    expect("operators" in body.passport).toBe(false);
  });
  it("csr-scope passport keeps supplier lots + operators + qc events", () => {
    const body = buildBatchPassportResponse({
      scope: "csr",
      passport: mkPassport(),
    });
    expect(body.passport.supplier_lots?.length).toBe(1);
    expect(body.passport.operators?.[0]).toBe("Alice");
    expect(body.passport.qc_events?.length).toBe(1);
  });
});

// ─── Route-shape + safety guards ────────────────────────────────────

describe("COMMERCIAL-TRACE-6 · route shape + safety", () => {
  function readRoute(p: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, "app", "api", "nexus", p), "utf8");
  }

  it("all three routes export GET and refuse other methods", () => {
    for (const file of [
      "invoice-batches/route.ts",
      "customer-batches/route.ts",
      "batch-passport/route.ts",
    ]) {
      const src = readRoute(file);
      expect(src).toMatch(/export async function GET\(/);
      // POST/PUT/PATCH/DELETE handlers exist and return 405.
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(src).toMatch(new RegExp(`export async function ${m}\\(`));
      }
      expect(src).toMatch(/METHOD_NOT_ALLOWED/);
    }
  });

  it("routes authenticate before doing anything else", () => {
    for (const file of [
      "invoice-batches/route.ts",
      "customer-batches/route.ts",
      "batch-passport/route.ts",
    ]) {
      const src = readRoute(file);
      const get = src.match(/export async function GET\([\s\S]*?\n}\n/);
      expect(get).not.toBeNull();
      // authenticateNexusLookupRequest is the FIRST function called in GET.
      const idx = get![0].indexOf("authenticateNexusLookupRequest(");
      expect(idx).toBeGreaterThan(-1);
      const before = get![0].slice(0, idx);
      // No DB query call should happen before auth.
      expect(before).not.toMatch(/loadConfirmed/);
      expect(before).not.toMatch(/loadBatchPassport/);
    }
  });

  it("routes never import the Zoho gateway or invoices client", () => {
    for (const file of [
      "invoice-batches/route.ts",
      "customer-batches/route.ts",
      "batch-passport/route.ts",
    ]) {
      const src = readRoute(file);
      expect(src).not.toMatch(/from\s+["']@\/lib\/integrations\/zoho/);
      expect(src).not.toMatch(/fetchZohoInvoices/);
    }
  });

  it("no complaint table / complaint webhook added", () => {
    for (const file of [
      "invoice-batches/route.ts",
      "customer-batches/route.ts",
      "batch-passport/route.ts",
    ]) {
      const src = readRoute(file);
      expect(src).not.toMatch(/nexus_complaints|nexusComplaints/);
      expect(src).not.toMatch(/complaint_webhook/);
      expect(src).not.toMatch(/complaint_attachments/);
    }
  });

  it("DB query layer hard-filters confirmed=true + status='CONFIRMED'", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib", "db", "queries", "nexus-lookups.ts"),
      "utf8",
    );
    // Every confirmed-allocations query path includes both predicates.
    const allocBlocks = [
      ...src.matchAll(
        /finishedLotInvoiceAllocations[\s\S]*?\.where\([\s\S]*?confirmed[\s\S]*?status[\s\S]*?CONFIRMED/g,
      ),
    ];
    expect(allocBlocks.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/eq\(finishedLotInvoiceAllocations\.confirmed, true\)/);
    expect(src).toMatch(/eq\(finishedLotInvoiceAllocations\.status, "CONFIRMED"\)/);
  });

  it("invoice-batches route exposes a customer-scope ownership check via DB", () => {
    const src = readRoute("invoice-batches/route.ts");
    expect(src).toMatch(/CUSTOMER_SCOPE_MISMATCH/);
  });

  it("batch-passport route enforces customer ownership when nexus_customer_id is supplied", () => {
    const src = readRoute("batch-passport/route.ts");
    expect(src).toMatch(/scope === "customer"/);
    expect(src).toMatch(/nexus_customer_id/);
    expect(src).toMatch(/CUSTOMER_SCOPE_MISMATCH/);
  });
});
