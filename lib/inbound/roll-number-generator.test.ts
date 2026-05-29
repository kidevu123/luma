import { describe, expect, it } from "vitest";
import {
  applyGeneratedRollNumbers,
  generateRollNumber,
  rollNumberPrefixForMaterial,
} from "./roll-number-generator";

describe("ROLL-INTAKE-AUTO-NUMBER-1 — roll number generation", () => {
  it("generates normal receipt labels from material kind and reference", () => {
    expect(
      generateRollNumber({
        materialKind: "FOIL_ROLL",
        receiptType: "NORMAL",
        receiptReference: "221",
        sequence: 1,
      }),
    ).toBe("FOIL-221-001");
    expect(
      generateRollNumber({
        materialKind: "FOIL_ROLL",
        receiptType: "NORMAL",
        receiptReference: "221",
        sequence: 2,
      }),
    ).toBe("FOIL-221-002");
    expect(
      generateRollNumber({
        materialKind: "PVC_ROLL",
        receiptType: "NORMAL",
        receiptReference: "shipment 58",
        sequence: 58,
      }),
    ).toBe("PVC-SHIPMENT-58-058");
  });

  it("generates legacy opening-balance labels without using the receipt reference", () => {
    expect(
      generateRollNumber({
        materialKind: "FOIL_ROLL",
        receiptType: "LEGACY_OPENING_BALANCE",
        receiptReference: "LEGACY-FOIL-01",
        sequence: 2,
      }),
    ).toBe("Legacy FOIL-002");
    expect(
      generateRollNumber({
        materialKind: "PVC_ROLL",
        receiptType: "LEGACY_OPENING_BALANCE",
        sequence: 1,
      }),
    ).toBe("Legacy PVC-001");
  });

  it("uses material kind safely beyond hardcoded IDs", () => {
    expect(rollNumberPrefixForMaterial({ materialKind: "BLISTER_FOIL" })).toBe("FOIL");
    expect(rollNumberPrefixForMaterial({ materialKind: "CLEAR_PVC_FILM" })).toBe("PVC");
    expect(
      rollNumberPrefixForMaterial({
        materialKind: "LAMINATE_ROLL",
        materialName: "Cold form laminate",
      }),
    ).toBe("COLD-FORM-LAMINATE");
  });

  it("fills generated rows while preserving manual overrides", () => {
    const rows = applyGeneratedRollNumbers(
      [
        { rollNumber: "", netWeightKg: "5.2", rollNumberSource: "auto" as const },
        {
          rollNumber: "CUSTOM-ROLL-A",
          netWeightKg: "5.4",
          rollNumberSource: "manual" as const,
        },
        { rollNumber: "", netWeightKg: "5.6", rollNumberSource: "auto" as const },
      ],
      {
        materialKind: "PVC_ROLL",
        receiptType: "NORMAL",
        receiptReference: "PO-123",
      },
    );

    expect(rows.map((row) => row.rollNumber)).toEqual([
      "PVC-PO-123-001",
      "CUSTOM-ROLL-A",
      "PVC-PO-123-003",
    ]);
  });

  it("generates 58 roll numbers for a bulk PVC receipt", () => {
    const rows = applyGeneratedRollNumbers(
      Array.from({ length: 58 }, () => ({
        rollNumber: "",
        netWeightKg: "",
        rollNumberSource: "auto" as const,
      })),
      {
        materialKind: "PVC_ROLL",
        receiptType: "NORMAL",
        receiptReference: "221",
      },
    );

    expect(rows).toHaveLength(58);
    expect(rows[0]?.rollNumber).toBe("PVC-221-001");
    expect(rows[57]?.rollNumber).toBe("PVC-221-058");
  });

  it("leaves normal receipt rows blank until a reference exists", () => {
    expect(
      generateRollNumber({
        materialKind: "FOIL_ROLL",
        receiptType: "NORMAL",
        receiptReference: "",
        sequence: 1,
      }),
    ).toBeNull();
  });
});
