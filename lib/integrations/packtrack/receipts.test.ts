import { describe, it, expect } from "vitest";
import { validatePackTrackReceiptPayload } from "./receipts";

const VALID_DECLARED = {
  source_system: "PACKTRACK" as const,
  packtrack_po_id: "PT-PO-1",
  packtrack_receipt_id: "PT-RCPT-1",
  material_code: "PVC-123",
  material_name: "PVC Roll",
  supplier: "Acme",
  supplier_lot_number: "SUP-LOT-A",
  box_number: "BOX-001",
  declared_quantity: 1000,
  counted_quantity: null,
  unit_of_measure: "EACH",
  received_at: "2026-05-08T14:30:00Z",
  received_by: "user@example.com",
};

describe("PT-3: validatePackTrackReceiptPayload", () => {
  it("accepts a complete declared-only payload", () => {
    const r = validatePackTrackReceiptPayload(VALID_DECLARED);
    expect(r.ok).toBe(true);
  });

  it("accepts a payload with both declared + counted", () => {
    const r = validatePackTrackReceiptPayload({
      ...VALID_DECLARED,
      counted_quantity: 1000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects payload missing both declared and counted", () => {
    // Schema requires declared_quantity to be present; this builds a
    // payload that omits it entirely so we hit the "must have at
    // least one" branch via the schema guard. Even if a future
    // change makes declared optional, the post-validation check
    // covers it.
    const { declared_quantity: _omit, ...rest } = VALID_DECLARED;
    const r = validatePackTrackReceiptPayload({
      ...rest,
      counted_quantity: null,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects payload with wrong source_system", () => {
    const r = validatePackTrackReceiptPayload({
      ...VALID_DECLARED,
      source_system: "MANUAL_LUMA",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects negative declared_quantity", () => {
    const r = validatePackTrackReceiptPayload({
      ...VALID_DECLARED,
      declared_quantity: -1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty box_number", () => {
    const r = validatePackTrackReceiptPayload({
      ...VALID_DECLARED,
      box_number: "",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing packtrack_receipt_id", () => {
    const { packtrack_receipt_id: _omit, ...rest } = VALID_DECLARED;
    const r = validatePackTrackReceiptPayload(rest);
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer declared_quantity", () => {
    const r = validatePackTrackReceiptPayload({
      ...VALID_DECLARED,
      declared_quantity: 100.5,
    });
    expect(r.ok).toBe(false);
  });

  it("preserves the typed payload on success", () => {
    const r = validatePackTrackReceiptPayload(VALID_DECLARED);
    if (r.ok) {
      expect(r.data.packtrack_receipt_id).toBe("PT-RCPT-1");
      expect(r.data.box_number).toBe("BOX-001");
      expect(r.data.declared_quantity).toBe(1000);
    }
  });
});
