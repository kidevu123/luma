// LOT-1B — receiving-bridge helper tests.

import { describe, expect, it } from "vitest";
import {
  buildFinishedLotTraceCode,
  buildInternalReceiptNumber,
  buildRawBagQrPayload,
  buildRawBagQrPayloadJson,
  firstFinishedLotId,
  getRawBagReceiptIdentity,
  normalizeSupplierLotNumber,
  rollupRecallConfidence,
  shouldExposeSupplierLot,
  validateInternalReceiptNumber,
  validateTraceCode,
} from "./recall-passport";

describe("firstFinishedLotId — recall page crash guard (digest 3511293824)", () => {
  it("returns the first lot id when finished lots exist", () => {
    expect(firstFinishedLotId({ finishedLots: [{ id: "fl-1" }, { id: "fl-2" }] })).toBe("fl-1");
  });

  it("returns null (no crash) when the search matched raw bags but no finished lot", () => {
    // The exact production condition: a supplier-lot / receipt / bag-QR search
    // resolves raw bags for an in-progress or partial bag that has no finished
    // lot yet. Previously `finishedLots[0]!.id` threw and crashed the render.
    expect(firstFinishedLotId({ finishedLots: [] })).toBeNull();
  });
});

describe("buildInternalReceiptNumber", () => {
  it("builds receive + box + bag", () => {
    expect(
      buildInternalReceiptNumber({
        receiveName: "PO123-R1",
        boxNumber: 2,
        bagNumber: 7,
      }),
    ).toBe("PO123-R1-B2-7");
  });

  it("omits box section when boxNumber is null", () => {
    expect(
      buildInternalReceiptNumber({
        receiveName: "PO123-R1",
        bagNumber: 7,
      }),
    ).toBe("PO123-R1-7");
  });

  it("returns null when bagNumber is missing", () => {
    expect(
      buildInternalReceiptNumber({
        receiveName: "PO123-R1",
        bagNumber: null,
      }),
    ).toBeNull();
  });

  it("returns null when receiveName is empty / whitespace", () => {
    expect(buildInternalReceiptNumber({ receiveName: "", bagNumber: 7 })).toBeNull();
    expect(buildInternalReceiptNumber({ receiveName: "   ", bagNumber: 7 })).toBeNull();
  });

  it("trims surrounding whitespace from receiveName", () => {
    expect(
      buildInternalReceiptNumber({ receiveName: " PO9 ", bagNumber: 3 }),
    ).toBe("PO9-3");
  });
});

describe("validateInternalReceiptNumber", () => {
  it("accepts the canonical receive+bag format", () => {
    expect(validateInternalReceiptNumber("PO123-R1-B2-7").ok).toBe(true);
  });

  it("accepts legacy receipt-pad numbers (alphanumeric + dash/underscore)", () => {
    expect(validateInternalReceiptNumber("RC_2026_0001").ok).toBe(true);
    expect(validateInternalReceiptNumber("RC-2026-00001").ok).toBe(true);
    expect(validateInternalReceiptNumber("R1").ok).toBe(false); // too short
  });

  it("rejects unsafe characters", () => {
    expect(validateInternalReceiptNumber("PO/123").ok).toBe(false);
    expect(validateInternalReceiptNumber("PO 123").ok).toBe(false);
    expect(validateInternalReceiptNumber("PO;123").ok).toBe(false);
    expect(validateInternalReceiptNumber("PO\n123").ok).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    // Trailing newline / spaces from a paste are normalised away;
    // the underlying value "PO123" is fine.
    expect(validateInternalReceiptNumber("PO123\n").ok).toBe(true);
    expect(validateInternalReceiptNumber("  PO123  ").ok).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(validateInternalReceiptNumber(null).ok).toBe(false);
    expect(validateInternalReceiptNumber(123).ok).toBe(false);
  });
});

describe("normalizeSupplierLotNumber", () => {
  it("uppercases and trims", () => {
    expect(normalizeSupplierLotNumber("abc-123")).toBe("ABC-123");
    expect(normalizeSupplierLotNumber(" abc-123 ")).toBe("ABC-123");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeSupplierLotNumber("abc   123")).toBe("ABC 123");
  });

  it("returns null for empty / whitespace / null", () => {
    expect(normalizeSupplierLotNumber("")).toBeNull();
    expect(normalizeSupplierLotNumber("   ")).toBeNull();
    expect(normalizeSupplierLotNumber(null)).toBeNull();
    expect(normalizeSupplierLotNumber(undefined)).toBeNull();
  });
});

describe("buildRawBagQrPayload + buildRawBagQrPayloadJson", () => {
  it("returns a BAG- prefixed string keyed to the inventory bag id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const s = buildRawBagQrPayload({
      inventoryBagId: id,
      internalReceiptNumber: "PO123-R1-B2-7",
      bagSequence: 7,
    });
    expect(s).toBe(`BAG-${id}`);
  });

  it("populates a JSON payload with product, supplier lot, receipt, sequence", () => {
    const payload = buildRawBagQrPayloadJson({
      inventoryBagId: "11111111-1111-1111-1111-111111111111",
      internalReceiptNumber: "PO123-R1-B2-7",
      supplierLotNumber: "MFG-LOT-1",
      productHint: "Mango Peach 30",
      bagSequence: 7,
    });
    expect(payload).toEqual({
      schema_version: "1.0",
      kind: "RAW_BAG",
      bag_id: "11111111-1111-1111-1111-111111111111",
      internal_receipt_number: "PO123-R1-B2-7",
      supplier_lot_number: "MFG-LOT-1",
      product_hint: "Mango Peach 30",
      bag_sequence: 7,
    });
  });

  it("BAG- raw-bag namespace is distinct from FL- trace-code namespace", () => {
    const rawBag = buildRawBagQrPayload({
      inventoryBagId: "11111111-1111-1111-1111-111111111111",
      internalReceiptNumber: "PO123-R1-1",
      bagSequence: 1,
    });
    const trace = buildFinishedLotTraceCode({ finishedLotNumber: "2026-001" });
    expect(rawBag.startsWith("BAG-")).toBe(true);
    expect(trace.startsWith("FL-")).toBe(true);
    expect(rawBag.startsWith("FL-")).toBe(false);
    expect(trace.startsWith("BAG-")).toBe(false);
  });

  it("rejects missing inventoryBagId / internalReceiptNumber / bagSequence", () => {
    expect(() =>
      buildRawBagQrPayload({
        inventoryBagId: "",
        internalReceiptNumber: "PO-1",
        bagSequence: 1,
      }),
    ).toThrow();
    expect(() =>
      buildRawBagQrPayload({
        inventoryBagId: "11111111-1111-1111-1111-111111111111",
        internalReceiptNumber: "",
        bagSequence: 1,
      }),
    ).toThrow();
    expect(() =>
      buildRawBagQrPayload({
        inventoryBagId: "11111111-1111-1111-1111-111111111111",
        internalReceiptNumber: "PO-1",
        bagSequence: 0,
      }),
    ).toThrow();
  });
});

describe("getRawBagReceiptIdentity", () => {
  it("builds the QR code + internal receipt + normalised supplier lot in one shot", () => {
    const identity = getRawBagReceiptIdentity({
      inventoryBagId: "11111111-1111-1111-1111-111111111111",
      receiveName: "PO123-R1",
      boxNumber: 2,
      bagNumber: 7,
      supplierLotNumber: " abc-123 ",
      productHint: "Mango Peach 30",
    });
    expect(identity.bagQrCode).toBe(
      "BAG-11111111-1111-1111-1111-111111111111",
    );
    expect(identity.internalReceiptNumber).toBe("PO123-R1-B2-7");
    expect(identity.supplierLotNumber).toBe("ABC-123");
    expect(identity.qrPayloadJson).not.toBeNull();
    expect(identity.qrPayloadJson?.product_hint).toBe("Mango Peach 30");
  });

  it("returns a bag_qr_code even when internal_receipt_number can't be built", () => {
    // Legacy bag with no receive_name in scope — bag_qr_code stays
    // valid because it keys on the inventory_bag id, but
    // internal_receipt_number is null so receiving never guesses.
    const identity = getRawBagReceiptIdentity({
      inventoryBagId: "11111111-1111-1111-1111-111111111111",
      receiveName: null,
      bagNumber: 7,
    });
    expect(identity.bagQrCode).toBe(
      "BAG-11111111-1111-1111-1111-111111111111",
    );
    expect(identity.internalReceiptNumber).toBeNull();
    expect(identity.supplierLotNumber).toBeNull();
    expect(identity.qrPayloadJson).toBeNull();
  });
});

describe("buildFinishedLotTraceCode + validateTraceCode", () => {
  it("prefixes finishedLotNumber with FL-", () => {
    expect(buildFinishedLotTraceCode({ finishedLotNumber: "2026-001" })).toBe(
      "FL-2026-001",
    );
  });

  it("does not double-prefix when finishedLotNumber already starts with FL-", () => {
    expect(buildFinishedLotTraceCode({ finishedLotNumber: "FL-2026-001" })).toBe(
      "FL-2026-001",
    );
  });

  it("appends an optional suffix", () => {
    expect(
      buildFinishedLotTraceCode({
        finishedLotNumber: "2026-001",
        suffix: "AB",
      }),
    ).toBe("FL-2026-001-AB");
  });

  it("throws on empty finishedLotNumber", () => {
    expect(() => buildFinishedLotTraceCode({ finishedLotNumber: "" })).toThrow();
    expect(() => buildFinishedLotTraceCode({ finishedLotNumber: "  " })).toThrow();
  });

  it("validateTraceCode accepts the canonical form", () => {
    expect(validateTraceCode("FL-2026-001").ok).toBe(true);
    expect(validateTraceCode("FL-2026-001-AB").ok).toBe(true);
  });

  it("validateTraceCode rejects strings without the FL- prefix", () => {
    expect(validateTraceCode("2026-001").ok).toBe(false);
    expect(validateTraceCode("BAG-uuid").ok).toBe(false);
  });

  it("validateTraceCode rejects unsafe / customer-unsafe characters", () => {
    expect(validateTraceCode("FL-2026/001").ok).toBe(false);
    expect(validateTraceCode("FL-2026 001").ok).toBe(false);
    expect(validateTraceCode("FL-").ok).toBe(false);
    expect(validateTraceCode("FL-x").ok).toBe(false); // too short
  });

  it("validateTraceCode rejects non-strings", () => {
    expect(validateTraceCode(null).ok).toBe(false);
    expect(validateTraceCode(42).ok).toBe(false);
  });
});

describe("shouldExposeSupplierLot", () => {
  it("defaults to false — supplier lot is hidden", () => {
    expect(shouldExposeSupplierLot({})).toBe(false);
    expect(shouldExposeSupplierLot({ customerSupplierLotVisible: null })).toBe(
      false,
    );
    expect(shouldExposeSupplierLot({ customerSupplierLotVisible: false })).toBe(
      false,
    );
  });

  it("returns true only when the customer flag is explicitly true", () => {
    expect(shouldExposeSupplierLot({ customerSupplierLotVisible: true })).toBe(
      true,
    );
  });
});

describe("rollupRecallConfidence", () => {
  it("returns MISSING for an empty chain", () => {
    expect(rollupRecallConfidence([])).toBe("MISSING");
  });

  it("returns the minimum across the chain", () => {
    expect(rollupRecallConfidence(["HIGH", "HIGH", "HIGH"])).toBe("HIGH");
    expect(rollupRecallConfidence(["HIGH", "MEDIUM", "HIGH"])).toBe("MEDIUM");
    expect(rollupRecallConfidence(["HIGH", "LOW", "HIGH"])).toBe("LOW");
    expect(rollupRecallConfidence(["HIGH", "MISSING", "HIGH"])).toBe("MISSING");
    expect(rollupRecallConfidence(["MEDIUM", "LOW"])).toBe("LOW");
  });
});

describe("partial-bag / multi-lot relationships", () => {
  // The schema can persist (finished_lot, inventory_bag, workflow_bag)
  // triples — the helpers don't enforce uniqueness; they only build
  // the identity strings. This test documents that the same
  // inventory_bag can produce multiple QR codes via different splits
  // (the QR is keyed only on the bag's UUID, not the workflow).
  it("one raw bag → multiple finished lots: same bag_qr_code, different trace codes", () => {
    const bagId = "11111111-1111-1111-1111-111111111111";
    const qr1 = buildRawBagQrPayload({
      inventoryBagId: bagId,
      internalReceiptNumber: "PO1-1",
      bagSequence: 1,
    });
    const qr2 = buildRawBagQrPayload({
      inventoryBagId: bagId,
      internalReceiptNumber: "PO1-1",
      bagSequence: 1,
    });
    const trace1 = buildFinishedLotTraceCode({ finishedLotNumber: "2026-001" });
    const trace2 = buildFinishedLotTraceCode({ finishedLotNumber: "2026-002" });
    // Same bag → same QR.
    expect(qr1).toBe(qr2);
    // Different finished lots → different trace codes.
    expect(trace1).not.toBe(trace2);
  });
});
