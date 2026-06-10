import { describe, it, expect } from "vitest";
import {
  validateBagEditFields,
  validateQrCardForRawBag,
  shouldReleaseQrAtBagEdit,
  type BagSnapshot,
  type BagEditInput,
  type QrCardForValidation,
} from "./bag-edits";

const baseBag: BagSnapshot = {
  id: "bag-1",
  weightGrams: 1000,
  declaredPillCount: 5000,
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

  it("blocks declared pill count edit on in-production bag", () => {
    const r = validateBagEditFields(
      baseBag,
      { declaredPillCount: 6000 },
      true,
    );
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

describe("validateQrCardForRawBag", () => {
  const idleRawBag: QrCardForValidation = {
    cardType: "RAW_BAG",
    status: "IDLE",
    assignedWorkflowBagId: null,
  };

  it("allows idle RAW_BAG card", () => {
    expect(validateQrCardForRawBag(idleRawBag)).toEqual({ ok: true });
  });

  it("allows intake-reserved RAW_BAG card (ASSIGNED + null workflowBagId)", () => {
    // Same-bag no-op is caught by the caller before reaching this helper.
    // A different-bag intake-reserved card passes pure validation — the
    // uniqueness DB check in editInventoryBag catches the cross-bag case.
    expect(
      validateQrCardForRawBag({
        cardType: "RAW_BAG",
        status: "ASSIGNED",
        assignedWorkflowBagId: null,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects VARIETY_PACK card with specific message", () => {
    const r = validateQrCardForRawBag({
      cardType: "VARIETY_PACK",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/variety pack/i);
  });

  it("rejects WORKFLOW_TRAVELER card", () => {
    const r = validateQrCardForRawBag({
      cardType: "WORKFLOW_TRAVELER",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/RAW_BAG/);
  });

  it("rejects UNKNOWN card type", () => {
    const r = validateQrCardForRawBag({
      cardType: "UNKNOWN",
      status: "IDLE",
      assignedWorkflowBagId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/RAW_BAG/);
  });

  it("rejects RETIRED RAW_BAG card", () => {
    const r = validateQrCardForRawBag({
      cardType: "RAW_BAG",
      status: "RETIRED",
      assignedWorkflowBagId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/retired/i);
  });

  it("rejects RAW_BAG card active in production (ASSIGNED + non-null workflowBagId)", () => {
    const r = validateQrCardForRawBag({
      cardType: "RAW_BAG",
      status: "ASSIGNED",
      assignedWorkflowBagId: "wfb-uuid-123",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/production/i);
  });
});

describe("shouldReleaseQrAtBagEdit", () => {
  const intakeReserved = {
    cardType: "RAW_BAG" as const,
    status: "ASSIGNED" as const,
    assignedWorkflowBagId: null,
  };

  it("returns false while bag remains AVAILABLE — intake reservation persists", () => {
    expect(shouldReleaseQrAtBagEdit(intakeReserved, "AVAILABLE")).toBe(false);
  });

  it("returns true for intake-reserved card when bag is no longer AVAILABLE", () => {
    expect(shouldReleaseQrAtBagEdit(intakeReserved, "DEPLETED")).toBe(true);
  });

  it("returns false for IDLE card — not yet linked, nothing to release", () => {
    expect(
      shouldReleaseQrAtBagEdit(
        {
          cardType: "RAW_BAG",
          status: "IDLE",
          assignedWorkflowBagId: null,
        },
        "AVAILABLE",
      ),
    ).toBe(false);
  });

  it("returns false for mid-production card (ASSIGNED + workflowBagId) — must not touch", () => {
    expect(
      shouldReleaseQrAtBagEdit(
        {
          cardType: "RAW_BAG",
          status: "ASSIGNED",
          assignedWorkflowBagId: "wfb-uuid-123",
        },
        "DEPLETED",
      ),
    ).toBe(false);
  });

  it("returns false for RETIRED card", () => {
    expect(
      shouldReleaseQrAtBagEdit(
        {
          cardType: "RAW_BAG",
          status: "RETIRED",
          assignedWorkflowBagId: null,
        },
        "DEPLETED",
      ),
    ).toBe(false);
  });
});
