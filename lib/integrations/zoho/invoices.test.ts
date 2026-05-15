// COMMERCIAL-TRACE-3 — invoice client / normalizer / dry-run tests.
//
// Fetch is fully mocked; no live calls. Readiness is stubbed via
// runZohoInvoiceDryRun's `probeReadiness` seam. Persistence is stubbed
// via `persistRun`. No DB writes, no Nexus, no Zoho HTTP.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  deriveZohoInvoiceDiff,
  fetchZohoInvoicesDryRun,
  fetchZohoInvoiceByNumberDryRun,
  mapZohoInvoiceGatewayError,
  normalizeZohoInvoice,
  normalizeZohoInvoiceLine,
  runZohoInvoiceDryRun,
  summarizeZohoInvoiceDryRun,
  ZOHO_INVOICES_GET_PATH_PREFIX,
  ZOHO_INVOICES_LIST_PATH,
  type LumaInvoiceSnapshot,
  type NormalizedZohoInvoice,
  type NormalizedZohoInvoiceLine,
} from "@/lib/integrations/zoho/invoices";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const baseEnv = {
  ZOHO_INTEGRATION_URL: "http://192.168.1.205:8000",
  ZOHO_INTEGRATION_SECRET: "s3cr3t",
  ZOHO_BRAND: "haute_brands",
};

const emptySnapshot: LumaInvoiceSnapshot = {
  customers: [],
  invoices: [],
};

const invoiceFixture = {
  invoice_id: "INV-zoho-1001",
  invoice_number: "INV-001",
  customer_id: "CUST-7",
  customer_name: "Customer Seven LLC",
  date: "2026-04-15",
  status: "sent",
  currency_code: "USD",
  sub_total: 100,
  total: 110,
  balance: 10,
  line_items: [
    {
      line_item_id: "LN-1",
      item_id: "ZI-1001",
      sku: "HN-DM-30",
      name: "HN Daily Multi 30ct",
      description: "Bottle of 30",
      quantity: 12,
      unit: "ea",
      rate: 8.33,
      item_total: 99.96,
    },
  ],
};

const lineFixture = invoiceFixture.line_items[0];

// ─── Normalization ───────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-3 · normalizeZohoInvoice", () => {
  it("normalizes a complete invoice payload", () => {
    const n = normalizeZohoInvoice(invoiceFixture);
    expect(n).not.toBeNull();
    expect(n!.zohoInvoiceId).toBe("INV-zoho-1001");
    expect(n!.invoiceNumber).toBe("INV-001");
    expect(n!.zohoCustomerId).toBe("CUST-7");
    expect(n!.customerName).toBe("Customer Seven LLC");
    expect(n!.invoiceDate).toBe("2026-04-15");
    expect(n!.status).toBe("sent");
    expect(n!.currency).toBe("USD");
    expect(n!.subtotal).toBe(100);
    expect(n!.total).toBe(110);
    expect(n!.balance).toBe(10);
    expect(n!.raw).toMatchObject({ invoice_id: "INV-zoho-1001" });
  });

  it("returns null when invoice_id is missing", () => {
    expect(normalizeZohoInvoice({ invoice_number: "INV-1" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(normalizeZohoInvoice(null)).toBeNull();
    expect(normalizeZohoInvoice("string")).toBeNull();
    expect(normalizeZohoInvoice(42)).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const n = normalizeZohoInvoice({ invoice_id: "X1" });
    expect(n).not.toBeNull();
    expect(n!.invoiceNumber).toBeNull();
    expect(n!.zohoCustomerId).toBeNull();
    expect(n!.subtotal).toBeNull();
  });

  it("parses numeric strings", () => {
    const n = normalizeZohoInvoice({
      invoice_id: "X1",
      total: "123.45",
      sub_total: "100",
    });
    expect(n!.total).toBe(123.45);
    expect(n!.subtotal).toBe(100);
  });
});

describe("COMMERCIAL-TRACE-3 · normalizeZohoInvoiceLine", () => {
  it("normalizes a complete invoice line", () => {
    const n = normalizeZohoInvoiceLine(lineFixture);
    expect(n).not.toBeNull();
    expect(n!.zohoInvoiceLineId).toBe("LN-1");
    expect(n!.zohoItemId).toBe("ZI-1001");
    expect(n!.sku).toBe("HN-DM-30");
    expect(n!.itemName).toBe("HN Daily Multi 30ct");
    expect(n!.description).toBe("Bottle of 30");
    expect(n!.quantity).toBe(12);
    expect(n!.unit).toBe("ea");
    expect(n!.rate).toBe(8.33);
    expect(n!.amount).toBe(99.96);
  });

  it("returns null when both item id AND name are missing", () => {
    expect(normalizeZohoInvoiceLine({ quantity: 1 })).toBeNull();
  });

  it("keeps the line when name is present but item id missing", () => {
    const n = normalizeZohoInvoiceLine({ name: "Manual line", quantity: 1 });
    expect(n).not.toBeNull();
    expect(n!.zohoItemId).toBeNull();
    expect(n!.itemName).toBe("Manual line");
  });

  it("keeps the line when item id is present but name missing", () => {
    const n = normalizeZohoInvoiceLine({ item_id: "ZI-2", quantity: 5 });
    expect(n).not.toBeNull();
    expect(n!.itemName).toBe("(unnamed line)");
  });
});

// ─── Gateway fetchers ─────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-3 · fetchZohoInvoicesDryRun", () => {
  it("returns NOT_CONFIGURED when ZOHO_INTEGRATION_URL is missing", async () => {
    const r = await fetchZohoInvoicesDryRun({
      env: {},
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    expect(r.kind).toBe("NOT_CONFIGURED");
  });

  it("hits /zoho/invoices/list with X-Internal-Token + X-Brand", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedMethod = "";
    const mockFetch = (async (input: string, init?: RequestInit) => {
      capturedUrl = input;
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        status: 200,
        json: async () => ({
          invoices: [invoiceFixture],
          page_context: { has_more_page: false },
        }),
      };
    }) as unknown as typeof fetch;
    const r = await fetchZohoInvoicesDryRun({
      env: baseEnv,
      fetchImpl: mockFetch,
      page: 2,
      perPage: 50,
    });
    expect(r.kind).toBe("OK");
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain(ZOHO_INVOICES_LIST_PATH);
    expect(capturedUrl).toContain("per_page=50");
    expect(capturedUrl).toContain("page=2");
    expect(capturedHeaders["x-internal-token"]).toBe("s3cr3t");
    expect(capturedHeaders["x-brand"]).toBe("haute_brands");
    if (r.kind === "OK") {
      expect(r.invoices).toHaveLength(1);
      expect(r.invoices[0]!.invoiceNumber).toBe("INV-001");
    }
  });

  it("maps 401 to UNAUTHORIZED without throwing", async () => {
    const mockFetch = (async () => ({
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const r = await fetchZohoInvoicesDryRun({ env: baseEnv, fetchImpl: mockFetch });
    expect(r.kind).toBe("UNAUTHORIZED");
    if (r.kind === "UNAUTHORIZED") expect(r.httpStatus).toBe(401);
  });

  it("maps connection refused to UNREACHABLE", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED 192.168.1.205:8000");
    }) as unknown as typeof fetch;
    const r = await fetchZohoInvoicesDryRun({ env: baseEnv, fetchImpl: mockFetch });
    expect(r.kind).toBe("UNREACHABLE");
  });

  it("never uses POST/PUT/PATCH/DELETE", async () => {
    let capturedMethod = "";
    const mockFetch = (async (_input: string, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      return { status: 200, json: async () => ({ invoices: [] }) };
    }) as unknown as typeof fetch;
    await fetchZohoInvoicesDryRun({ env: baseEnv, fetchImpl: mockFetch });
    expect(["GET", undefined]).toContain(capturedMethod);
  });
});

describe("COMMERCIAL-TRACE-3 · fetchZohoInvoiceByNumberDryRun", () => {
  it("hits /zoho/invoices/get/<id> and returns lines[]", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: string, init?: RequestInit) => {
      capturedUrl = input;
      return {
        status: 200,
        json: async () => ({ invoice: invoiceFixture }),
      };
    }) as unknown as typeof fetch;
    const r = await fetchZohoInvoiceByNumberDryRun({
      env: baseEnv,
      fetchImpl: mockFetch,
      zohoInvoiceId: "INV-zoho-1001",
    });
    expect(capturedUrl).toContain(`${ZOHO_INVOICES_GET_PATH_PREFIX}INV-zoho-1001`);
    expect(r.kind).toBe("OK");
    if (r.kind === "OK") {
      expect(r.invoice.zohoInvoiceId).toBe("INV-zoho-1001");
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]!.sku).toBe("HN-DM-30");
    }
  });

  it("returns NOT_FOUND on 404", async () => {
    const mockFetch = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const r = await fetchZohoInvoiceByNumberDryRun({
      env: baseEnv,
      fetchImpl: mockFetch,
      zohoInvoiceId: "NOPE",
    });
    expect(r.kind).toBe("NOT_FOUND");
  });

  it("rejects an empty zoho_invoice_id without calling fetch", async () => {
    let called = false;
    const mockFetch = (async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await fetchZohoInvoiceByNumberDryRun({
      env: baseEnv,
      fetchImpl: mockFetch,
      zohoInvoiceId: "  ",
    });
    expect(r.kind).toBe("ERROR");
    expect(called).toBe(false);
  });
});

// ─── Diff ────────────────────────────────────────────────────────────────

function mkInvoice(over: Partial<NormalizedZohoInvoice> = {}): NormalizedZohoInvoice {
  return {
    zohoInvoiceId: "Z-1",
    invoiceNumber: "INV-1",
    zohoCustomerId: "C-1",
    customerName: "Customer One",
    invoiceDate: "2026-04-01",
    status: "sent",
    currency: "USD",
    subtotal: 10,
    total: 10,
    balance: 0,
    raw: {},
    ...over,
  };
}

function mkLine(over: Partial<NormalizedZohoInvoiceLine> = {}): NormalizedZohoInvoiceLine {
  return {
    zohoInvoiceLineId: "L-1",
    zohoItemId: "I-1",
    sku: "SKU-1",
    itemName: "Item 1",
    description: null,
    quantity: 1,
    unit: "ea",
    rate: 5,
    amount: 5,
    raw: {},
    ...over,
  };
}

describe("COMMERCIAL-TRACE-3 · deriveZohoInvoiceDiff", () => {
  it("CREATE_CANDIDATE when invoice is unknown and clean", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice(), lines: [mkLine()] }],
      luma: { customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }], invoices: [] },
    });
    expect(headers[0]!.action).toBe("CREATE_CANDIDATE");
    expect(headers[0]!.customerMatchedLumaId).toBe("luma-c1");
  });

  it("NEEDS_REVIEW when invoice number is missing", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice({ invoiceNumber: null }), lines: [mkLine()] }],
      luma: { customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }], invoices: [] },
    });
    expect(headers[0]!.action).toBe("NEEDS_REVIEW");
    expect(headers[0]!.reasons).toContain("missing_invoice_number");
  });

  it("CONFLICT when two fetched invoices share the same zoho_invoice_id", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [
        { invoice: mkInvoice({ zohoInvoiceId: "DUP" }), lines: [mkLine()] },
        { invoice: mkInvoice({ zohoInvoiceId: "DUP" }), lines: [mkLine()] },
      ],
      luma: emptySnapshot,
    });
    expect(headers[0]!.action).toBe("CONFLICT");
    expect(headers[0]!.reasons).toContain("duplicate_zoho_invoice_id_in_zoho");
    expect(headers[1]!.action).toBe("CONFLICT");
  });

  it("CONFLICT when two fetched invoices share the same invoice number", () => {
    const { headers, warnings } = deriveZohoInvoiceDiff({
      invoices: [
        { invoice: mkInvoice({ zohoInvoiceId: "A", invoiceNumber: "INV-9" }), lines: [mkLine()] },
        { invoice: mkInvoice({ zohoInvoiceId: "B", invoiceNumber: "INV-9" }), lines: [mkLine()] },
      ],
      luma: emptySnapshot,
    });
    expect(headers.every((h) => h.action === "CONFLICT")).toBe(true);
    expect(headers[0]!.reasons).toContain("duplicate_invoice_number_in_zoho");
    expect(warnings.some((w) => w.includes('INV-9'))).toBe(true);
  });

  it("CONFLICT when invoice_number collides with a different Luma invoice", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice({ zohoInvoiceId: "NEW" }), lines: [mkLine()] }],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [
          {
            id: "existing-luma",
            zohoInvoiceId: "OLD-ZOHO",
            invoiceNumber: "INV-1",
            lastSyncedAt: null,
          },
        ],
      },
    });
    expect(headers[0]!.action).toBe("CONFLICT");
    expect(headers[0]!.reasons).toContain("invoice_number_collides_in_luma");
  });

  it("NEEDS_REVIEW when zoho_customer_id is missing", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice({ zohoCustomerId: null }), lines: [mkLine()] }],
      luma: emptySnapshot,
    });
    expect(headers[0]!.action).toBe("NEEDS_REVIEW");
    expect(headers[0]!.reasons).toContain("missing_zoho_customer_id");
  });

  it("NEEDS_REVIEW when customer is not mapped in Luma", () => {
    const { headers, warnings } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice({ zohoCustomerId: "UNKNOWN" }), lines: [mkLine()] }],
      luma: emptySnapshot,
    });
    expect(headers[0]!.action).toBe("NEEDS_REVIEW");
    expect(headers[0]!.reasons).toContain("customer_not_mapped_to_luma");
    expect(headers[0]!.customerMatchedLumaId).toBeNull();
    expect(warnings.some((w) => w.includes("not yet mapped"))).toBe(true);
  });

  it("NEEDS_REVIEW when invoice has no lines", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice(), lines: [] }],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [],
      },
    });
    expect(headers[0]!.action).toBe("NEEDS_REVIEW");
    expect(headers[0]!.reasons).toContain("invoice_has_no_lines");
  });

  it("NEEDS_REVIEW when a line is missing item_id", () => {
    const { headers, lines } = deriveZohoInvoiceDiff({
      invoices: [
        {
          invoice: mkInvoice(),
          lines: [mkLine({ zohoItemId: null })],
        },
      ],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [],
      },
    });
    expect(lines[0]!.reasons).toContain("line_missing_item_id");
    // Header rolls up worst line status.
    expect(headers[0]!.action).toBe("NEEDS_REVIEW");
  });

  it("NEEDS_REVIEW when a line is missing SKU", () => {
    const { lines } = deriveZohoInvoiceDiff({
      invoices: [
        {
          invoice: mkInvoice(),
          lines: [mkLine({ sku: null })],
        },
      ],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [],
      },
    });
    expect(lines[0]!.reasons).toContain("line_missing_sku");
  });

  it("NEEDS_REVIEW when quantity is missing or invalid", () => {
    const { lines } = deriveZohoInvoiceDiff({
      invoices: [
        {
          invoice: mkInvoice(),
          lines: [
            mkLine({ quantity: null }),
            mkLine({ quantity: 0 }),
            mkLine({ quantity: -5 }),
            mkLine({ quantity: Number.NaN }),
          ],
        },
      ],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [],
      },
    });
    expect(lines[0]!.reasons).toContain("line_missing_quantity");
    for (const i of [1, 2, 3]) {
      expect(lines[i]!.reasons).toContain("line_quantity_invalid");
    }
  });

  it("NO_CHANGE when the invoice already exists in Luma by zoho_invoice_id", () => {
    const { headers } = deriveZohoInvoiceDiff({
      invoices: [{ invoice: mkInvoice(), lines: [mkLine()] }],
      luma: {
        customers: [{ id: "luma-c1", customerCode: "C1", name: "C1", zohoCustomerId: "C-1" }],
        invoices: [
          {
            id: "luma-inv-1",
            zohoInvoiceId: "Z-1",
            invoiceNumber: "INV-1",
            lastSyncedAt: new Date("2026-04-10T00:00:00Z"),
          },
        ],
      },
    });
    expect(headers[0]!.action).toBe("NO_CHANGE");
    expect(headers[0]!.reasons).toContain("local_invoice_already_exists");
    expect(headers[0]!.matchedLumaInvoiceId).toBe("luma-inv-1");
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-3 · summarizeZohoInvoiceDryRun", () => {
  it("aggregates counts from header + line arrays", () => {
    const counts = summarizeZohoInvoiceDryRun({
      headers: [
        { action: "CREATE_CANDIDATE" },
        { action: "NEEDS_REVIEW" },
        { action: "NO_CHANGE" },
        { action: "CONFLICT" },
        { action: "CREATE_CANDIDATE" },
      ],
      lines: [
        { action: "CREATE_CANDIDATE" },
        { action: "CREATE_CANDIDATE" },
        { action: "NEEDS_REVIEW" },
      ],
    });
    expect(counts.invoicesScanned).toBe(5);
    expect(counts.linesScanned).toBe(3);
    expect(counts.createCandidates).toBe(2);
    expect(counts.needsReview).toBe(1);
    expect(counts.noChange).toBe(1);
    expect(counts.conflicts).toBe(1);
  });
});

// ─── Orchestrator ────────────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-3 · runZohoInvoiceDryRun · BLOCKED path", () => {
  it("returns BLOCKED + writes ONE PARTIAL audit row when NEEDS_REAUTH", async () => {
    let invoiceFetchCount = 0;
    const persisted: Array<{ status: string; summary: Record<string, unknown> }> = [];

    const result = await runZohoInvoiceDryRun({
      probeReadiness: async () => "NEEDS_REAUTH",
      fetchInvoices: async () => {
        invoiceFetchCount++;
        return { kind: "OK", invoices: [], raw: { count: 0 } };
      },
      fetchInvoiceById: async () => {
        invoiceFetchCount++;
        return { kind: "OK", invoice: normalizeZohoInvoice(invoiceFixture)!, lines: [] };
      },
      loadLumaSnapshot: async () => emptySnapshot,
      persistRun: async (input) => {
        persisted.push({ status: input.status, summary: input.summary });
        return "run-blocked-1";
      },
      actorUserId: "user-1",
    });

    expect(result.kind).toBe("BLOCKED");
    expect(invoiceFetchCount).toBe(0); // no /invoices/list or /invoices/get call
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe("PARTIAL");
    expect(persisted[0]!.summary).toMatchObject({
      readiness: "NEEDS_REAUTH",
      blocked: true,
    });
    if (result.kind === "BLOCKED") {
      expect(result.readiness).toBe("NEEDS_REAUTH");
      expect(result.runId).toBe("run-blocked-1");
      expect(result.reason.toLowerCase()).toContain("re-authoriz");
    }
  });

  it("returns BLOCKED for any non-READY readiness", async () => {
    for (const readiness of [
      "NOT_CONFIGURED",
      "UNREACHABLE",
      "ERROR",
      "CONNECTED_HEALTH_ONLY",
      "NEEDS_SELECTION",
    ] as const) {
      let invoiceFetchCount = 0;
      const r = await runZohoInvoiceDryRun({
        probeReadiness: async () => readiness,
        fetchInvoices: async () => {
          invoiceFetchCount++;
          return { kind: "OK", invoices: [], raw: { count: 0 } };
        },
        loadLumaSnapshot: async () => emptySnapshot,
        persistRun: async () => "run-id",
      });
      expect(r.kind).toBe("BLOCKED");
      expect(invoiceFetchCount).toBe(0);
    }
  });
});

describe("COMMERCIAL-TRACE-3 · runZohoInvoiceDryRun · OK path", () => {
  it("fetches list, normalizes, diffs, writes SUCCESS row, returns preview", async () => {
    const persisted: Array<{ status: string; summary: Record<string, unknown> }> = [];
    let listCalls = 0;

    const result = await runZohoInvoiceDryRun({
      probeReadiness: async () => "READY_FOR_DRY_RUN",
      fetchInvoices: async () => {
        listCalls++;
        return {
          kind: "OK",
          invoices: [normalizeZohoInvoice(invoiceFixture)!],
          raw: { count: 1 },
        };
      },
      fetchInvoiceById: async () => {
        // Line items are inline in the list response, so detail fetch
        // should not run. If it does, return clearly-different content.
        return {
          kind: "OK",
          invoice: normalizeZohoInvoice(invoiceFixture)!,
          lines: [],
        };
      },
      loadLumaSnapshot: async () => ({
        customers: [
          {
            id: "luma-c7",
            customerCode: "C7",
            name: "Customer Seven LLC",
            zohoCustomerId: "CUST-7",
          },
        ],
        invoices: [],
      }),
      persistRun: async (input) => {
        persisted.push({ status: input.status, summary: input.summary });
        return "ok-run-id";
      },
    });

    expect(listCalls).toBe(1);
    expect(result.kind).toBe("OK");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe("SUCCESS");
    if (result.kind === "OK") {
      expect(result.counts.invoicesScanned).toBe(1);
      expect(result.counts.linesScanned).toBe(1);
      expect(result.counts.createCandidates).toBe(1);
      expect(result.counts.conflicts).toBe(0);
      expect(result.headers[0]!.customerMatchedLumaId).toBe("luma-c7");
    }
  });

  it("writes PARTIAL when conflicts are present", async () => {
    const persisted: Array<{ status: string }> = [];
    const dupFixture = {
      ...invoiceFixture,
      invoice_id: "DUP",
      line_items: [lineFixture],
    };
    const r = await runZohoInvoiceDryRun({
      probeReadiness: async () => "READY_FOR_DRY_RUN",
      fetchInvoices: async () => ({
        kind: "OK",
        invoices: [normalizeZohoInvoice(dupFixture)!, normalizeZohoInvoice(dupFixture)!],
        raw: { count: 2 },
      }),
      loadLumaSnapshot: async () => emptySnapshot,
      persistRun: async (input) => {
        persisted.push({ status: input.status });
        return "id";
      },
    });
    expect(r.kind).toBe("OK");
    expect(persisted[0]!.status).toBe("PARTIAL");
  });
});

// ─── Safety guardrails ───────────────────────────────────────────────────

describe("COMMERCIAL-TRACE-3 · safety guardrails", () => {
  it("invoices.ts never imports the direct-OAuth client", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib", "integrations", "zoho", "invoices.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']@\/lib\/zoho\/client/);
    expect(src).not.toMatch(/refresh_token/);
  });

  it("invoices.ts never references POST/PUT/PATCH/DELETE methods", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib", "integrations", "zoho", "invoices.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/method:\s*["']POST/);
    expect(src).not.toMatch(/method:\s*["']PUT/);
    expect(src).not.toMatch(/method:\s*["']PATCH/);
    expect(src).not.toMatch(/method:\s*["']DELETE/);
  });

  it("invoices.ts never imports or writes to allocation tables", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib", "integrations", "zoho", "invoices.ts"),
      "utf8",
    );
    // The Drizzle table symbol is only ever imported when code wants to
    // read or write the table. Tolerate doc-comments naming the table
    // as a "we do NOT write here" guarantee, but reject the actual
    // symbol import or call sites.
    expect(src).not.toMatch(/finishedLotInvoiceAllocations\b\s*[,\)\.]/);
    expect(src).not.toMatch(/insert\(\s*finishedLotInvoiceAllocations\b/);
    expect(src).not.toMatch(/update\(\s*finishedLotInvoiceAllocations\b/);
    expect(src).not.toMatch(/invoiceAllocationStatus[^a-zA-Z0-9_]/);
  });

  it("invoices.ts never writes to shipment_finished_lots", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "lib", "integrations", "zoho", "invoices.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/shipmentFinishedLots[\s\S]*\.update\(/);
    expect(src).not.toMatch(/shipment_finished_lots[\s\S]*UPDATE/);
    expect(src).not.toMatch(/insert\(\s*shipmentFinishedLots\b/);
  });

  it("mapZohoInvoiceGatewayError is a distinct exported symbol", () => {
    // Used so tests / callers can stub one error mapper without
    // affecting the items / customers modules.
    const m = mapZohoInvoiceGatewayError({
      thrown: new Error("ECONNREFUSED 192.168.1.205"),
    });
    expect(m.status).toBe("UNREACHABLE");
  });
});
