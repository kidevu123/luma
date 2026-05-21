// PBOM-1 — pure tests for the scope/kind filter.

import { describe, expect, it } from "vitest";
import {
  MACHINE_CONSUMABLE_KINDS,
  allowedKindsForScope,
  describeRejection,
  isKindAllowedAtScope,
  isMachineConsumableKind,
} from "./packaging-bom-kinds";

describe("MACHINE_CONSUMABLE_KINDS", () => {
  it("lists exactly the three blister-machine consumables", () => {
    expect([...MACHINE_CONSUMABLE_KINDS].sort()).toEqual(
      ["BLISTER_FOIL", "FOIL_ROLL", "PVC_ROLL"].sort(),
    );
  });
});

describe("isMachineConsumableKind", () => {
  it("returns true for PVC roll", () => {
    expect(isMachineConsumableKind("PVC_ROLL")).toBe(true);
  });
  it("returns true for FOIL roll", () => {
    expect(isMachineConsumableKind("FOIL_ROLL")).toBe(true);
  });
  it("returns true for BLISTER_FOIL", () => {
    expect(isMachineConsumableKind("BLISTER_FOIL")).toBe(true);
  });
  it("returns false for DISPLAY / CASE / BOTTLE / LABEL", () => {
    expect(isMachineConsumableKind("DISPLAY")).toBe(false);
    expect(isMachineConsumableKind("CASE")).toBe(false);
    expect(isMachineConsumableKind("BOTTLE")).toBe(false);
    expect(isMachineConsumableKind("LABEL")).toBe(false);
  });
});

describe("allowedKindsForScope — UNIT", () => {
  const allowed = allowedKindsForScope("UNIT");
  it("includes BOTTLE / CAP / LABEL / INDUCTION_SEAL (bottle-route per-unit packaging)", () => {
    expect(allowed).toContain("BOTTLE");
    expect(allowed).toContain("CAP");
    expect(allowed).toContain("LABEL");
    expect(allowed).toContain("INDUCTION_SEAL");
  });
  it("includes DESICCANT / COTTON / INSERT / HEAT_SEAL_FILM / SHRINK_BAND", () => {
    expect(allowed).toContain("DESICCANT");
    expect(allowed).toContain("COTTON");
    expect(allowed).toContain("INSERT");
    expect(allowed).toContain("HEAT_SEAL_FILM");
    expect(allowed).toContain("SHRINK_BAND");
  });
  it("excludes machine consumables (PVC / FOIL / BLISTER_FOIL)", () => {
    expect(allowed).not.toContain("PVC_ROLL");
    expect(allowed).not.toContain("FOIL_ROLL");
    expect(allowed).not.toContain("BLISTER_FOIL");
  });
  it("excludes DISPLAY and CASE (those belong at higher scopes, not per-unit)", () => {
    expect(allowed).not.toContain("DISPLAY");
    expect(allowed).not.toContain("CASE");
  });
});

describe("allowedKindsForScope — DISPLAY", () => {
  const allowed = allowedKindsForScope("DISPLAY");
  it("includes DISPLAY (the display box itself)", () => {
    expect(allowed).toContain("DISPLAY");
  });
  it("allows INSERT (per-display inserts)", () => {
    expect(allowed).toContain("INSERT");
  });
  it("excludes per-unit kinds (BOTTLE / CAP / LABEL / DESICCANT)", () => {
    expect(allowed).not.toContain("BOTTLE");
    expect(allowed).not.toContain("CAP");
    expect(allowed).not.toContain("LABEL");
    expect(allowed).not.toContain("DESICCANT");
  });
  it("excludes CASE (master case is not consumed per-display)", () => {
    expect(allowed).not.toContain("CASE");
  });
  it("excludes machine consumables", () => {
    expect(allowed).not.toContain("PVC_ROLL");
    expect(allowed).not.toContain("FOIL_ROLL");
    expect(allowed).not.toContain("BLISTER_FOIL");
  });
});

describe("allowedKindsForScope — CASE", () => {
  const allowed = allowedKindsForScope("CASE");
  it("includes CASE (the master case box)", () => {
    expect(allowed).toContain("CASE");
  });
  it("allows LABEL + INSERT (case-level outer labels / inserts)", () => {
    expect(allowed).toContain("LABEL");
    expect(allowed).toContain("INSERT");
  });
  it("excludes DISPLAY and per-unit kinds", () => {
    expect(allowed).not.toContain("DISPLAY");
    expect(allowed).not.toContain("BOTTLE");
    expect(allowed).not.toContain("CAP");
  });
  it("excludes machine consumables", () => {
    expect(allowed).not.toContain("PVC_ROLL");
    expect(allowed).not.toContain("FOIL_ROLL");
    expect(allowed).not.toContain("BLISTER_FOIL");
  });
});

describe("isKindAllowedAtScope", () => {
  it("allows DISPLAY at DISPLAY scope", () => {
    expect(isKindAllowedAtScope("DISPLAY", "DISPLAY")).toBe(true);
  });
  it("allows CASE at CASE scope", () => {
    expect(isKindAllowedAtScope("CASE", "CASE")).toBe(true);
  });
  it("allows BOTTLE at UNIT scope", () => {
    expect(isKindAllowedAtScope("BOTTLE", "UNIT")).toBe(true);
  });
  it("rejects PVC_ROLL at every scope", () => {
    expect(isKindAllowedAtScope("PVC_ROLL", "UNIT")).toBe(false);
    expect(isKindAllowedAtScope("PVC_ROLL", "DISPLAY")).toBe(false);
    expect(isKindAllowedAtScope("PVC_ROLL", "CASE")).toBe(false);
  });
  it("rejects FOIL_ROLL at every scope", () => {
    expect(isKindAllowedAtScope("FOIL_ROLL", "UNIT")).toBe(false);
    expect(isKindAllowedAtScope("FOIL_ROLL", "DISPLAY")).toBe(false);
    expect(isKindAllowedAtScope("FOIL_ROLL", "CASE")).toBe(false);
  });
  it("rejects BLISTER_FOIL at every scope", () => {
    expect(isKindAllowedAtScope("BLISTER_FOIL", "UNIT")).toBe(false);
    expect(isKindAllowedAtScope("BLISTER_FOIL", "DISPLAY")).toBe(false);
    expect(isKindAllowedAtScope("BLISTER_FOIL", "CASE")).toBe(false);
  });
  it("rejects DISPLAY at UNIT scope (cross-level not allowed)", () => {
    expect(isKindAllowedAtScope("DISPLAY", "UNIT")).toBe(false);
  });
  it("rejects CASE at DISPLAY scope (cross-level not allowed)", () => {
    expect(isKindAllowedAtScope("CASE", "DISPLAY")).toBe(false);
  });
  it("rejects DISPLAY at CASE scope (cross-level not allowed)", () => {
    expect(isKindAllowedAtScope("DISPLAY", "CASE")).toBe(false);
  });
});

describe("describeRejection", () => {
  it("steers operators to blister material standards for PVC/FOIL/BLISTER_FOIL", () => {
    const msg = describeRejection("PVC_ROLL", "UNIT");
    expect(msg).toMatch(/blister/i);
    expect(msg).toMatch(/standards/i);
  });
  it("lists allowed kinds in the cross-scope rejection message", () => {
    const msg = describeRejection("CASE", "UNIT");
    expect(msg).toMatch(/CASE/);
    expect(msg).toMatch(/UNIT/);
    expect(msg).toMatch(/BOTTLE/);
  });
});

describe("PBOM-1 banned-language scan stays clean for this file", () => {
  it("does not use 'production loss' or 'supplier shortage' phrasings", () => {
    const src = describeRejection("PVC_ROLL", "UNIT");
    expect(src).not.toMatch(/production loss/i);
    expect(src).not.toMatch(/supplier shortage/i);
  });
});
