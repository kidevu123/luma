import { describe, it, expect } from "vitest";
import { validateBagEditFields, type BagSnapshot, type BagEditInput } from "./bag-edits";

const baseBag: BagSnapshot = {
  id: "bag-1",
  weightGrams: 1000,
  notes: null,
  internalReceiptNumber: "PO123-R1-B1-001",
  bagQrCode: "bag-card-001",
  batchId: "batch-1",
  status: "AVAILABLE",
};

describe("validateBagEditFields", () => {
  it("allows weight + notes edit on non-production bag", () => {
    expect(
      validateBagEditFields(baseBag, { weightGrams: 1200, notes: "ok" }, false),
    ).toEqual({ ok: true });
  });

  it("allows notes-only edit on in-production bag", () => {
    expect(
      validateBagEditFields(baseBag, { notes: "updated" }, true),
    ).toEqual({ ok: true });
  });

  it("blocks weight edit on in-production bag", () => {
    const r = validateBagEditFields(baseBag, { weightGrams: 1200 }, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/in production/);
  });

  it("blocks receipt# change on in-production bag", () => {
    const r = validateBagEditFields(
      baseBag,
      { internalReceiptNumber: "NEW-R1" },
      true,
    );
    expect(r.ok).toBe(false);
  });

  it("blocks QR change on in-production bag", () => {
    const r = validateBagEditFields(baseBag, { bagQrCode: "bag-card-002" }, true);
    expect(r.ok).toBe(false);
  });

  it("blocks lot change on in-production bag", () => {
    const r = validateBagEditFields(
      baseBag,
      { supplierLotNumber: "LOT-999" },
      true,
    );
    expect(r.ok).toBe(false);
  });

  it("requires reason for QR change", () => {
    const r = validateBagEditFields(baseBag, { bagQrCode: "bag-card-002" }, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reason/i);
  });

  it("requires reason for receipt# change", () => {
    const r = validateBagEditFields(
      baseBag,
      { internalReceiptNumber: "NEW-001" },
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reason/i);
  });

  it("requires reason for supplier lot change", () => {
    const r = validateBagEditFields(
      baseBag,
      { supplierLotNumber: "LOT-X" },
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reason/i);
  });

  it("allows QR change with reason provided", () => {
    expect(
      validateBagEditFields(
        baseBag,
        { bagQrCode: "bag-card-002", editReason: "card damaged" },
        false,
      ),
    ).toEqual({ ok: true });
  });

  it("allows receipt# change with reason provided", () => {
    expect(
      validateBagEditFields(
        baseBag,
        { internalReceiptNumber: "NEW-001", editReason: "typo at intake" },
        false,
      ),
    ).toEqual({ ok: true });
  });

  it("allows weight + QR + reason together", () => {
    expect(
      validateBagEditFields(
        baseBag,
        { weightGrams: 900, bagQrCode: "bag-card-003", editReason: "swapped" },
        false,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects whitespace-only reason as empty", () => {
    const r = validateBagEditFields(
      baseBag,
      { bagQrCode: "bag-card-002", editReason: "   " },
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reason/i);
  });

  it("allows empty input (no-op)", () => {
    expect(validateBagEditFields(baseBag, {}, false)).toEqual({ ok: true });
  });
});
