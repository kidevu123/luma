import { describe, it, expect } from "vitest";
import {
  validateRollReceiveBatch,
  parseRollReceiveRowsJson,
  rollRoleForMaterialKind,
} from "./roll-receive-batch";

describe("roll-receive-batch — validation", () => {
  it("rejects duplicate roll numbers within a batch", () => {
    expect(
      validateRollReceiveBatch([
        { rollNumber: "FOIL-1", netWeightKg: 5 },
        { rollNumber: "FOIL-1", netWeightKg: 4 },
      ]),
    ).toMatch(/Duplicate roll number/i);
  });

  it("rejects zero or missing net weight", () => {
    expect(
      validateRollReceiveBatch([{ rollNumber: "FOIL-2", netWeightKg: 0 }]),
    ).toMatch(/Net weight must be > 0/);
  });

  it("accepts a valid multi-roll batch", () => {
    expect(
      validateRollReceiveBatch([
        { rollNumber: "FOIL-1", netWeightKg: 5.2 },
        { rollNumber: "FOIL-2", netWeightKg: 4.8 },
      ]),
    ).toBeNull();
  });

  it("parseRollReceiveRowsJson handles valid JSON", () => {
    const r = parseRollReceiveRowsJson(
      JSON.stringify([{ rollNumber: "A", netWeightKg: 1.5 }]),
    );
    expect("rows" in r && r.rows).toEqual([{ rollNumber: "A", netWeightKg: 1.5 }]);
  });

  it("rollRoleForMaterialKind maps PVC vs foil kinds", () => {
    expect(rollRoleForMaterialKind("PVC_ROLL")).toBe("PVC");
    expect(rollRoleForMaterialKind("FOIL_ROLL")).toBe("FOIL");
    expect(rollRoleForMaterialKind("BLISTER_FOIL")).toBe("FOIL");
  });
});
