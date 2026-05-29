import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  calculatePackagingConsumption,
  calculateSpecQty,
  resolvePackagingConsumptionSplit,
} from "./packaging-consumption-hook";

describe("calculatePackagingConsumption", () => {
  it("1 master case × 20 displays/case × 20 units/display = 400 units, 20 displays, 1 case", () => {
    const result = calculatePackagingConsumption({
      masterCases: 1,
      displaysMade: 0,
      looseUnits: 0,
      unitsPerDisplay: 20,
      displaysPerCase: 20,
    });
    expect(result.totalCases).toBe(1);
    expect(result.totalDisplays).toBe(20);
    expect(result.totalUnits).toBe(400);
  });

  it("2 displays_made (no master cases) = 0 cases, 2 displays, N units", () => {
    const result = calculatePackagingConsumption({
      masterCases: 0,
      displaysMade: 2,
      looseUnits: 0,
      unitsPerDisplay: 20,
      displaysPerCase: 20,
    });
    expect(result.totalCases).toBe(0);
    expect(result.totalDisplays).toBe(2);
    expect(result.totalUnits).toBe(40);
  });

  it("loose_cards only = 0 cases, 0 displays, loose_cards units", () => {
    const result = calculatePackagingConsumption({
      masterCases: 0,
      displaysMade: 0,
      looseUnits: 15,
      unitsPerDisplay: 20,
      displaysPerCase: 20,
    });
    expect(result.totalCases).toBe(0);
    expect(result.totalDisplays).toBe(0);
    expect(result.totalUnits).toBe(15);
  });

  it("missing displaysPerCase (null) = totalDisplays = 0 + displaysMade only", () => {
    const result = calculatePackagingConsumption({
      masterCases: 3,
      displaysMade: 2,
      looseUnits: 0,
      unitsPerDisplay: 20,
      displaysPerCase: null,
    });
    expect(result.totalCases).toBe(3);
    expect(result.totalDisplays).toBe(2);
    expect(result.totalUnits).toBe(40);
  });
});

describe("calculateSpecQty", () => {
  const totals = { totalCases: 2, totalDisplays: 10, totalUnits: 200 };

  it("CASE scope: qty = totalCases × qtyPerUnit", () => {
    const qty = calculateSpecQty({ perScope: "CASE", qtyPerUnit: 1 }, totals);
    expect(qty).toBe(2);
  });

  it("DISPLAY scope: qty = totalDisplays × qtyPerUnit", () => {
    const qty = calculateSpecQty({ perScope: "DISPLAY", qtyPerUnit: 2 }, totals);
    expect(qty).toBe(20);
  });

  it("UNIT scope: qty = totalUnits × qtyPerUnit", () => {
    const qty = calculateSpecQty({ perScope: "UNIT", qtyPerUnit: 1 }, totals);
    expect(qty).toBe(200);
  });

  it("0 consumption when totalCases = 0 and perScope = CASE", () => {
    const zeroTotals = { totalCases: 0, totalDisplays: 0, totalUnits: 5 };
    const qty = calculateSpecQty({ perScope: "CASE", qtyPerUnit: 3 }, zeroTotals);
    expect(qty).toBe(0);
  });
});

describe("resolvePackagingConsumptionSplit — PACKAGING-PENDING-CONSUMPTION-HONESTY-1", () => {
  it("no lot path: full qty is estimated when observed on-hand is 0", () => {
    expect(resolvePackagingConsumptionSplit(100, 0)).toEqual({
      actualQty: 0,
      estimatedQty: 100,
    });
  });

  it("sufficient lot: full qty is actual", () => {
    expect(resolvePackagingConsumptionSplit(50, 200)).toEqual({
      actualQty: 50,
      estimatedQty: 0,
    });
  });

  it("insufficient lot: splits ACTUAL + ESTIMATED", () => {
    expect(resolvePackagingConsumptionSplit(100, 30)).toEqual({
      actualQty: 30,
      estimatedQty: 70,
    });
  });

  it("exact on-hand match: all actual", () => {
    expect(resolvePackagingConsumptionSplit(25, 25)).toEqual({
      actualQty: 25,
      estimatedQty: 0,
    });
  });

  it("zero consumption yields zeros", () => {
    expect(resolvePackagingConsumptionSplit(0, 50)).toEqual({
      actualQty: 0,
      estimatedQty: 0,
    });
  });

  it("negative observed on-hand treated as zero available", () => {
    expect(resolvePackagingConsumptionSplit(10, -5)).toEqual({
      actualQty: 0,
      estimatedQty: 10,
    });
  });
});

describe("roll material kind detection", () => {
  const ROLL_KINDS = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"];

  it("PVC_ROLL is in roll kinds (SKIPPED_ROLL rule)", () => {
    expect(ROLL_KINDS.includes("PVC_ROLL")).toBe(true);
  });

  it("FOIL_ROLL is in roll kinds", () => {
    expect(ROLL_KINDS.includes("FOIL_ROLL")).toBe(true);
  });

  it("BLISTER_FOIL is in roll kinds", () => {
    expect(ROLL_KINDS.includes("BLISTER_FOIL")).toBe(true);
  });

  it("CASE material kind is NOT in roll kinds", () => {
    expect(ROLL_KINDS.includes("CASE")).toBe(false);
  });

  it("LABEL material kind is NOT in roll kinds", () => {
    expect(ROLL_KINDS.includes("LABEL")).toBe(false);
  });
});

describe("packaging-consumption-hook source wiring", () => {
  const hookSrc = readFileSync(join(import.meta.dirname, "packaging-consumption-hook.ts"), "utf8");

  it("writes MATERIAL_CONSUMED_ESTIMATED when no lot", () => {
    expect(hookSrc).toMatch(/no_lot_reason: "no_available_lot"/);
    expect(hookSrc).toMatch(/MATERIAL_CONSUMED_ESTIMATED/);
  });

  it("splits insufficient on-hand into ACTUAL + ESTIMATED", () => {
    expect(hookSrc).toMatch(/resolvePackagingConsumptionSplit/);
    expect(hookSrc).toMatch(/insufficient_on_hand: true/);
    expect(hookSrc).toMatch(/observed_qty_on_hand/);
    expect(hookSrc).toMatch(/status = "PARTIAL"/);
  });

  it("selects qty_on_hand from best lot for split decision", () => {
    expect(hookSrc).toMatch(/qty_on_hand::int/);
  });
});
