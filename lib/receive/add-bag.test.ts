import { describe, it, expect } from "vitest";
import {
  validateAddBagInput,
  resolveTargetBoxId,
  nextBagNumber,
  DEFAULT_ADD_BAG_REASON,
} from "./add-bag";

describe("add-bag — validation", () => {
  it("requires add reason", () => {
    expect(validateAddBagInput({ addReason: "" }, 1)).toEqual({
      ok: false,
      error: "Add reason is required.",
    });
    expect(validateAddBagInput({ addReason: "  " }, 1)).toEqual({
      ok: false,
      error: "Add reason is required.",
    });
  });

  it("requires box selection when receive has multiple boxes", () => {
    expect(validateAddBagInput({ addReason: "Migration" }, 2)).toEqual({
      ok: false,
      error: "Select which box this bag belongs to.",
    });
    expect(
      validateAddBagInput(
        { addReason: "Migration", smallBoxId: "box-1" },
        2,
      ).ok,
    ).toBe(true);
  });

  it("allows single-box receive without explicit box id", () => {
    expect(validateAddBagInput({ addReason: "Migration" }, 1).ok).toBe(true);
  });

  it("exports default migration reason copy", () => {
    expect(DEFAULT_ADD_BAG_REASON).toBe(
      "Historical migration / manual correction",
    );
  });
});

describe("add-bag — box resolution", () => {
  const boxes = [{ id: "box-a" }, { id: "box-b" }];

  it("rejects receive with no boxes", () => {
    expect(resolveTargetBoxId([])).toEqual({
      ok: false,
      error: "This receive has no boxes — cannot add a bag.",
    });
  });

  it("auto-selects sole box", () => {
    expect(resolveTargetBoxId([{ id: "only" }])).toEqual({
      ok: true,
      boxId: "only",
    });
  });

  it("requires explicit box when multiple exist", () => {
    expect(resolveTargetBoxId(boxes)).toEqual({
      ok: false,
      error: "Select which box this bag belongs to.",
    });
  });

  it("rejects box id not on receive", () => {
    expect(resolveTargetBoxId(boxes, "other")).toEqual({
      ok: false,
      error: "Selected box does not belong to this receive.",
    });
  });
});

describe("add-bag — bag numbering", () => {
  it("increments from max bag number in box", () => {
    expect(nextBagNumber(0)).toBe(1);
    expect(nextBagNumber(3)).toBe(4);
    expect(nextBagNumber(null)).toBe(1);
  });
});

describe("add-bag — summary count helpers", () => {
  function summarizeBags(
    bags: Array<{ status: string; declaredPillCount?: number | null; weightGrams?: number | null }>,
  ) {
    return {
      total: bags.length,
      available: bags.filter((b) => b.status === "AVAILABLE").length,
      pills: bags.reduce((s, b) => s + (b.declaredPillCount ?? 0), 0),
      weightKg:
        bags.reduce((s, b) => s + (b.weightGrams ?? 0), 0) / 1000,
    };
  }

  it("updates totals when a bag is appended", () => {
    const before = summarizeBags([
      { status: "AVAILABLE", declaredPillCount: 1000, weightGrams: 5000 },
    ]);
    const after = summarizeBags([
      ...[
        { status: "AVAILABLE", declaredPillCount: 1000, weightGrams: 5000 },
      ],
      { status: "AVAILABLE", declaredPillCount: 800, weightGrams: 4200 },
    ]);
    expect(after.total).toBe(before.total + 1);
    expect(after.available).toBe(before.available + 1);
    expect(after.pills).toBe(1800);
    expect(after.weightKg).toBeCloseTo(9.2);
  });
});
