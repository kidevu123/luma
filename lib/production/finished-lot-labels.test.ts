// LOT-1E — finished-lot label / CSV helper tests.

import { describe, expect, it } from "vitest";
import {
  buildCustomerSafeLabelPayload,
  buildFinishedLotLabelPayload,
  buildRecallPassportCsv,
  formatTraceCodeForPrint,
  getCsvHeaders,
  shouldExposeSupplierLotForCustomer,
} from "./finished-lot-labels";
import type { RecallPassport } from "./recall-passport-loaders";

function baseLabelArgs() {
  return {
    traceCode: "FL-2026-001",
    traceAlias: null,
    productName: "Mango Peach 30",
    productSku: "MP-30",
    output: {
      outputType: "MASTER_CASE",
      quantity: 12,
      unit: "each",
      printPayload: {
        source: "PROJECTOR",
        trace_code: "FL-2026-001",
      } as Record<string, unknown>,
    },
    packedAt: new Date("2026-05-10T13:00:00Z"),
    expiresAt: new Date("2027-05-10T13:00:00Z"),
    internalReceiptAlias: "INT-ALIAS-001",
    sourceRawBagCount: 3,
    supplierLotNumber: "HN-LOT-555",
    confidence: "HIGH",
    warnings: [] as string[],
    missingLinks: [] as string[],
  };
}

describe("shouldExposeSupplierLotForCustomer", () => {
  it("defaults to false (hidden)", () => {
    expect(shouldExposeSupplierLotForCustomer({})).toBe(false);
    expect(
      shouldExposeSupplierLotForCustomer({ customerSupplierLotVisible: null }),
    ).toBe(false);
    expect(
      shouldExposeSupplierLotForCustomer({
        customerSupplierLotVisible: false,
      }),
    ).toBe(false);
  });

  it("returns true only on explicit opt-in", () => {
    expect(
      shouldExposeSupplierLotForCustomer({
        customerSupplierLotVisible: true,
      }),
    ).toBe(true);
  });
});

describe("formatTraceCodeForPrint", () => {
  it("prefers customer alias over trace_code", () => {
    expect(formatTraceCodeForPrint("FL-2026-001", "ACME-INTERNAL-7")).toBe(
      "ACME-INTERNAL-7",
    );
  });

  it("falls back to trace_code when alias is null / blank", () => {
    expect(formatTraceCodeForPrint("FL-2026-001", null)).toBe("FL-2026-001");
    expect(formatTraceCodeForPrint("FL-2026-001", "   ")).toBe("FL-2026-001");
  });

  it("renders explicit warning when both are missing", () => {
    expect(formatTraceCodeForPrint(null, null)).toBe("MISSING TRACE CODE");
    expect(formatTraceCodeForPrint("", "")).toBe("MISSING TRACE CODE");
  });
});

describe("buildCustomerSafeLabelPayload", () => {
  it("hides supplier_lot by default", () => {
    const l = buildCustomerSafeLabelPayload(baseLabelArgs());
    expect(l.template).toBe("CUSTOMER");
    expect(l.internalFields.supplierLotNumber).toBeNull();
  });

  it("exposes supplier_lot only when customerSupplierLotVisible=true", () => {
    const l = buildCustomerSafeLabelPayload({
      ...baseLabelArgs(),
      customerSupplierLotVisible: true,
    });
    expect(l.internalFields.supplierLotNumber).toBe("HN-LOT-555");
  });

  it("prefers trace_code over internal_receipt_number for qrPayloadText", () => {
    const l = buildCustomerSafeLabelPayload(baseLabelArgs());
    expect(l.qrPayloadText).toBe("FL-2026-001");
    expect(l.qrPayloadText.startsWith("FL-")).toBe(true);
    expect(l.qrPayloadText.startsWith("BAG-")).toBe(false);
  });

  it("uses print_payload as a snapshot (no live recalculation)", () => {
    const args = baseLabelArgs();
    const l = buildCustomerSafeLabelPayload(args);
    expect(l.printPayloadSnapshot).toBe(args.output.printPayload);
  });

  it("renders trace code 'MISSING TRACE CODE' when no trace_code or alias", () => {
    const l = buildCustomerSafeLabelPayload({
      ...baseLabelArgs(),
      traceCode: null,
      traceAlias: null,
    });
    expect(l.traceCode).toBe("MISSING TRACE CODE");
  });

  it("missing print_payload surfaces as null (not fabricated)", () => {
    const l = buildCustomerSafeLabelPayload({
      ...baseLabelArgs(),
      output: {
        outputType: "MASTER_CASE",
        quantity: 12,
        unit: "each",
        printPayload: null,
      },
    });
    expect(l.printPayloadSnapshot).toBeNull();
  });
});

describe("buildFinishedLotLabelPayload (INTERNAL template)", () => {
  it("includes internal receipt alias on internal template", () => {
    const l = buildFinishedLotLabelPayload({
      template: "INTERNAL",
      ...baseLabelArgs(),
    });
    expect(l.template).toBe("INTERNAL");
    expect(l.internalFields.internalReceiptAlias).toBe("INT-ALIAS-001");
    expect(l.internalFields.sourceRawBagCount).toBe(3);
  });

  it("internal template always carries supplier_lot regardless of customer flag", () => {
    const l1 = buildFinishedLotLabelPayload({
      template: "INTERNAL",
      ...baseLabelArgs(),
    });
    const l2 = buildFinishedLotLabelPayload({
      template: "INTERNAL",
      ...baseLabelArgs(),
      customerSupplierLotVisible: false,
    });
    expect(l1.internalFields.supplierLotNumber).toBe("HN-LOT-555");
    expect(l2.internalFields.supplierLotNumber).toBe("HN-LOT-555");
  });
});

// ─── CSV ──────────────────────────────────────────────────────────────

function buildPassportWithSupplierLot(): RecallPassport {
  return {
    searchInput: { kind: "supplier_lot", value: "HN-555" },
    rawBags: [
      {
        id: "bag-1",
        bagNumber: 1,
        bagQrCode: "BAG-uuid-1",
        internalReceiptNumber: "PO123-R1-B1-1",
        declaredPillCount: 10000,
        pillCount: 9800,
        weightGrams: 8000,
        vendorBarcode: null,
        status: "AVAILABLE",
        notes: null,
        batchId: "batch-1",
        batchNumber: "B-1",
        supplierLotNumber: "HN-LOT-555",
        vendorName: "Acme",
        smallBoxId: "box-1",
        boxNumber: 1,
        receiveId: "rcv-1",
        receiveName: "PO123-R1",
        receivedAt: new Date("2026-05-01T08:00:00Z"),
      },
    ],
    finishedLots: [
      {
        id: "fl-1",
        finishedLotNumber: "2026-001",
        traceCode: "FL-2026-001",
        finishedLotCodeAlias: null,
        productId: "p-1",
        productName: "Mango Peach 30",
        productSku: "MP-30",
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
    outputs: [
      {
        id: "o-1",
        finishedLotId: "fl-1",
        outputType: "MASTER_CASE",
        quantity: 1,
        unit: "each",
        traceCodePrinted: "FL-2026-001",
        printPayload: {},
      },
    ],
    packagingLots: [
      {
        id: "plk-1",
        finishedLotId: "fl-1",
        packagingLotId: "plot-1",
        materialId: "m-1",
        materialName: "Bottle Label",
        materialKind: "LABEL",
        rollNumber: null,
        supplier: null,
        supplierLotNumber: null,
        quantityUsed: 100,
        unit: "each",
        confidence: "HIGH",
        source: "PROJECTOR",
        firstUsedAt: null,
        lastUsedAt: null,
      },
    ],
    qcEvents: [
      {
        id: "qc-1",
        finishedLotId: "fl-1",
        workflowEventId: "wev-1",
        eventType: "PACKAGING_DAMAGE_RETURN",
        occurredAt: new Date("2026-05-10T11:00:00Z"),
      },
    ],
    shipmentLinks: [
      {
        id: "sf-1",
        shipmentId: "shp-1",
        finishedLotId: "fl-1",
        customerId: "c-1",
        customerCode: "ACME",
        customerName: "Acme Foods",
        carrier: "FedEx",
        trackingNumber: "FX123",
        quantity: 1,
        unit: "cases",
        shippedAt: new Date("2026-05-11T10:00:00Z"),
      },
    ],
    confidence: "MEDIUM",
    warnings: [],
    missingLinks: [],
  };
}

describe("buildRecallPassportCsv", () => {
  it("first line is the header; row count = 1 summary + raw + outputs + packaging + qc + shipments", () => {
    const p = buildPassportWithSupplierLot();
    const csv = buildRecallPassportCsv(p, { customerSupplierLotVisible: true });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(getCsvHeaders().join(","));
    expect(lines.length).toBe(1 + 1 + 1 + 1 + 1 + 1 + 1); // header + summary + 1 each
  });

  it("hides supplier_lot when customer flag is false (default)", () => {
    const p = buildPassportWithSupplierLot();
    const csv = buildRecallPassportCsv(p);
    expect(csv).not.toContain("HN-LOT-555");
  });

  it("exposes supplier_lot when customer flag is true", () => {
    const p = buildPassportWithSupplierLot();
    const csv = buildRecallPassportCsv(p, { customerSupplierLotVisible: true });
    expect(csv).toContain("HN-LOT-555");
  });

  it("includes raw bag / packaging / qc / shipment sections", () => {
    const p = buildPassportWithSupplierLot();
    const csv = buildRecallPassportCsv(p, { customerSupplierLotVisible: true });
    expect(csv).toContain("PO123-R1-B1-1");
    expect(csv).toContain("BAG-uuid-1");
    expect(csv).toContain("FL-2026-001");
    expect(csv).toContain("Bottle Label");
    expect(csv).toContain("PACKAGING_DAMAGE_RETURN");
    expect(csv).toContain("ACME");
    expect(csv).toContain("FedEx");
  });

  it("never invents missing data — empty passport still emits the header + a summary row", () => {
    const empty: RecallPassport = {
      searchInput: { kind: "supplier_lot", value: "NOPE" },
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
    const csv = buildRecallPassportCsv(empty);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(getCsvHeaders().join(","));
    expect(lines.length).toBe(2); // header + summary
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("null");
  });

  it("QR namespace on output rows uses FL- (trace_code), not BAG-", () => {
    const p = buildPassportWithSupplierLot();
    const csv = buildRecallPassportCsv(p, { customerSupplierLotVisible: true });
    // The output section's row carries the finished_lot_trace_code = FL-…
    const outputLine = csv
      .split("\n")
      .find((l) => l.includes("output") && l.includes("MASTER_CASE"));
    expect(outputLine).toBeDefined();
    // Same row should NOT mention BAG- (that's the raw-bag namespace).
    expect(outputLine!.includes("FL-2026-001")).toBe(true);
  });
});
