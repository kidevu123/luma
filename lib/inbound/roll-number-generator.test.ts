import { describe, expect, it } from "vitest";
import {
  assignRollNumbersForBatch,
  formatRollNumber,
  maxSequenceInGroup,
  rollNumberGroupPrefix,
  rollNumberPrefixForMaterial,
} from "./roll-number-generator";

describe("ROLL-INTAKE-AUTO-NUMBER-INTEGRATION-1 — roll number formats", () => {
  it("generates normal FOIL labels with reference 221", () => {
    expect(
      formatRollNumber(
        {
          materialKind: "FOIL_ROLL",
          receiptType: "NORMAL",
          receiptReference: "221",
        },
        1,
      ),
    ).toBe("FOIL-221-001");
    expect(
      formatRollNumber(
        {
          materialKind: "FOIL_ROLL",
          receiptType: "NORMAL",
          receiptReference: "221",
        },
        58,
      ),
    ).toBe("FOIL-221-058");
  });

  it("generates normal PVC labels with reference 221", () => {
    expect(
      formatRollNumber(
        {
          materialKind: "PVC_ROLL",
          receiptType: "NORMAL",
          receiptReference: "221",
        },
        1,
      ),
    ).toBe("PVC-221-001");
    expect(
      formatRollNumber(
        {
          materialKind: "PVC_ROLL",
          receiptType: "NORMAL",
          receiptReference: "221",
        },
        2,
      ),
    ).toBe("PVC-221-002");
  });

  it("generates legacy labels without reference token", () => {
    expect(
      formatRollNumber(
        {
          materialKind: "FOIL_ROLL",
          receiptType: "LEGACY_OPENING_BALANCE",
          receiptReference: "ignored",
        },
        1,
      ),
    ).toBe("Legacy FOIL-001");
    expect(
      formatRollNumber(
        {
          materialKind: "PVC_ROLL",
          receiptType: "LEGACY_OPENING_BALANCE",
        },
        2,
      ),
    ).toBe("Legacy PVC-002");
  });

  it("derives prefix from material kind, not hardcoded IDs", () => {
    expect(rollNumberPrefixForMaterial({ materialKind: "BLISTER_FOIL" })).toBe("FOIL");
    expect(rollNumberPrefixForMaterial({ materialKind: "CLEAR_PVC_FILM" })).toBe("PVC");
  });
});

describe("ROLL-INTAKE-AUTO-NUMBER-INTEGRATION-1 — collision handling", () => {
  it("assigns 58 unique FOIL-221 numbers on a clean group", () => {
    const result = assignRollNumbersForBatch({
      materialKind: "FOIL_ROLL",
      receiptType: "NORMAL",
      receiptReference: "221",
      count: 58,
      existingRollNumbers: [],
    });
    expect("rollNumbers" in result && result.rollNumbers).toHaveLength(58);
    if ("rollNumbers" in result) {
      expect(result.rollNumbers[0]).toBe("FOIL-221-001");
      expect(result.rollNumbers[57]).toBe("FOIL-221-058");
      expect(new Set(result.rollNumbers).size).toBe(58);
    }
  });

  it("continues from the next free sequence when prior numbers exist", () => {
    const prefix = rollNumberGroupPrefix({
      materialKind: "FOIL_ROLL",
      receiptType: "NORMAL",
      receiptReference: "221",
    })!;
    expect(maxSequenceInGroup(["FOIL-221-001", "FOIL-221-010"], prefix)).toBe(10);

    const result = assignRollNumbersForBatch({
      materialKind: "FOIL_ROLL",
      receiptType: "NORMAL",
      receiptReference: "221",
      count: 2,
      existingRollNumbers: ["FOIL-221-001", "FOIL-221-010"],
    });
    expect("rollNumbers" in result && result.rollNumbers).toEqual([
      "FOIL-221-011",
      "FOIL-221-012",
    ]);
  });

  it("isolates legacy FOIL sequences from normal FOIL-221", () => {
    const result = assignRollNumbersForBatch({
      materialKind: "FOIL_ROLL",
      receiptType: "LEGACY_OPENING_BALANCE",
      receiptReference: "221",
      count: 2,
      existingRollNumbers: ["FOIL-221-001", "Legacy FOIL-003"],
    });
    expect("rollNumbers" in result && result.rollNumbers).toEqual([
      "Legacy FOIL-004",
      "Legacy FOIL-005",
    ]);
  });

  it("requires reference for normal receipts", () => {
    const result = assignRollNumbersForBatch({
      materialKind: "PVC_ROLL",
      receiptType: "NORMAL",
      receiptReference: "",
      count: 1,
      existingRollNumbers: [],
    });
    expect("error" in result && result.error).toMatch(/reference is required/i);
  });
});
