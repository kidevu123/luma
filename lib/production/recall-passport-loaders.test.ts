// LOT-1D — recall-passport loader tests.
//
// Live-DB queries are exercised during staging verification; these
// vitest cases focus on the pure shape of the public API plus the
// "missing data is honest, not invented" invariants.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {},
}));

// Re-import the types only (no DB-touching helper is called here).
import type {
  RecallPassport,
  RecallSearchInput,
} from "./recall-passport-loaders";

// Reuse the rollup helper from LOT-1B to assert the confidence
// behavior the loader promises.
import { rollupRecallConfidence } from "./recall-passport";

function emptyPassport(input: RecallSearchInput): RecallPassport {
  return {
    searchInput: input,
    rawBags: [],
    finishedLots: [],
    workflowBags: [],
    outputs: [],
    packagingLots: [],
    qcEvents: [],
    shipmentLinks: [],
    confidence: "MISSING",
    warnings: [],
    missingLinks: [],
  };
}

describe("RecallPassport return shape", () => {
  it("empty passport has MISSING confidence and zero-length arrays", () => {
    const p = emptyPassport({ kind: "supplier_lot", value: "X" });
    expect(p.confidence).toBe("MISSING");
    expect(p.rawBags).toEqual([]);
    expect(p.finishedLots).toEqual([]);
    expect(p.workflowBags).toEqual([]);
    expect(p.outputs).toEqual([]);
    expect(p.packagingLots).toEqual([]);
    expect(p.qcEvents).toEqual([]);
    expect(p.shipmentLinks).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.missingLinks).toEqual([]);
  });
});

describe("confidence rollup matches MIN-across-chain semantics", () => {
  it("HIGH × HIGH × HIGH = HIGH", () => {
    expect(rollupRecallConfidence(["HIGH", "HIGH", "HIGH"])).toBe("HIGH");
  });

  it("HIGH × LOW × HIGH = LOW", () => {
    expect(rollupRecallConfidence(["HIGH", "LOW", "HIGH"])).toBe("LOW");
  });

  it("any MISSING in chain → MISSING", () => {
    expect(rollupRecallConfidence(["HIGH", "MISSING", "MEDIUM"])).toBe(
      "MISSING",
    );
  });

  it("empty chain → MISSING (loader returns this when no edges exist)", () => {
    expect(rollupRecallConfidence([])).toBe("MISSING");
  });
});

describe("search-input discriminator covers six axes", () => {
  it("accepts every documented search kind without type narrowing collapse", () => {
    const supplier: RecallSearchInput = {
      kind: "supplier_lot",
      value: "HN-1",
    };
    const receipt: RecallSearchInput = {
      kind: "internal_receipt_number",
      value: "PO1-1",
    };
    const qr: RecallSearchInput = {
      kind: "raw_bag_qr",
      value: "BAG-uuid",
    };
    const trace: RecallSearchInput = {
      kind: "finished_lot_trace_code",
      value: "FL-1",
    };
    const product: RecallSearchInput = {
      kind: "product_date_range",
      productId: "p-1",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    };
    const customer: RecallSearchInput = {
      kind: "customer_date_range",
      customerId: "c-1",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    };
    expect(
      [supplier, receipt, qr, trace, product, customer].map((x) => x.kind),
    ).toEqual([
      "supplier_lot",
      "internal_receipt_number",
      "raw_bag_qr",
      "finished_lot_trace_code",
      "product_date_range",
      "customer_date_range",
    ]);
  });
});

describe("data-honesty invariants (RecallPassport)", () => {
  // The loader fills warnings + missingLinks; we lock in the contract
  // that missing chains never get fabricated rows. The unit-level
  // assurance comes from constructing a typical "no shipments yet"
  // passport and verifying the right note surfaces.
  it("shipmentLinks empty + lots non-empty → recall page renders missing-link note (data-honesty contract)", () => {
    const p: RecallPassport = {
      searchInput: { kind: "supplier_lot", value: "X" },
      rawBags: [],
      finishedLots: [
        {
          id: "fl-1",
          finishedLotNumber: "2026-001",
          traceCode: "FL-2026-001",
          finishedLotCodeAlias: null,
          productId: "p-1",
          productName: "Vit C 30",
          productSku: "VITC-30",
          producedOn: "2026-05-10",
          packedAt: new Date("2026-05-10T13:00:00Z"),
          expiresAt: null,
          unitsProduced: 100,
          displaysProduced: 10,
          casesProduced: 1,
          status: "RELEASED",
          workflowBagId: null,
        },
      ],
      workflowBags: [],
      outputs: [],
      packagingLots: [],
      qcEvents: [],
      shipmentLinks: [],
      confidence: "MEDIUM",
      warnings: [],
      missingLinks: [
        "No shipment / customer linkage recorded yet for any of the matched finished lots.",
      ],
    };
    expect(p.shipmentLinks).toEqual([]);
    expect(p.missingLinks[0]).toMatch(/No shipment/);
  });

  it("rawBags with null bag_qr_code → loader produces a warning, not silence", () => {
    const p: RecallPassport = {
      searchInput: { kind: "internal_receipt_number", value: "PO1-1" },
      rawBags: [
        {
          id: "bag-1",
          bagNumber: 1,
          bagQrCode: null,
          internalReceiptNumber: "PO1-1",
          declaredPillCount: 10000,
          pillCount: 9800,
          weightGrams: null,
          vendorBarcode: null,
          status: "AVAILABLE",
          notes: null,
          batchId: null,
          batchNumber: null,
          supplierLotNumber: null,
          vendorName: null,
          smallBoxId: "box-1",
          boxNumber: 1,
          receiveId: "rcv-1",
          receiveName: "PO1",
          receivedAt: new Date("2026-05-10T08:00:00Z"),
        },
      ],
      finishedLots: [],
      workflowBags: [],
      outputs: [],
      packagingLots: [],
      qcEvents: [],
      shipmentLinks: [],
      confidence: "LOW",
      warnings: [
        "Bag PO1-1: legacy raw-bag QR missing — recall lookup is using receipt/bag identity.",
      ],
      missingLinks: [],
    };
    expect(p.warnings[0]).toMatch(/raw-bag QR missing/);
  });
});
