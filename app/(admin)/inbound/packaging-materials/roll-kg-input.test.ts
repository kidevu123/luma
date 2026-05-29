// ROLL-WEIGHT-KG-INPUT-1 — verifies kg input plumbing across the
// receive-roll form, action schema, and recent-receipts display.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const BASE = join(
  import.meta.dirname,
);
const actionsSrc = readFileSync(join(BASE, "actions.ts"), "utf8");
const pageSrc = readFileSync(join(BASE, "page.tsx"), "utf8");

describe("ROLL-WEIGHT-KG-INPUT-1 — form labels no longer say (g)", () => {
  it("grossWeightGrams label is gone from form", () => {
    expect(pageSrc).not.toMatch(/Gross weight \(g\)/);
  });

  it("tareWeightGrams label is gone from form", () => {
    expect(pageSrc).not.toMatch(/Tare weight \(g\)/);
  });

  it("netWeightGrams label is gone from form", () => {
    expect(pageSrc).not.toMatch(/Net weight \(g/);
  });

  it("coreWeightGrams label is gone from form", () => {
    expect(pageSrc).not.toMatch(/Core weight \(g\)/);
  });

  it("form uses kg labels for all weight fields", () => {
    expect(pageSrc).toMatch(/Gross weight \(kg\)/);
    expect(pageSrc).toMatch(/Tare weight \(kg\)/);
    expect(pageSrc).toMatch(/Net weight \(kg/);
    expect(pageSrc).toMatch(/Core weight \(kg\)/);
  });
});

describe("ROLL-WEIGHT-KG-INPUT-1 — form field names are Kg not Grams", () => {
  it("form submits grossWeightKg", () => {
    expect(pageSrc).toMatch(/name="grossWeightKg"/);
  });

  it("form submits tareWeightKg", () => {
    expect(pageSrc).toMatch(/name="tareWeightKg"/);
  });

  it("form submits netWeightKg", () => {
    expect(pageSrc).toMatch(/name="netWeightKg"/);
  });

  it("form submits coreWeightKg", () => {
    expect(pageSrc).toMatch(/name="coreWeightKg"/);
  });

  it("old grams field names are absent from form", () => {
    expect(pageSrc).not.toMatch(/name="grossWeightGrams"/);
    expect(pageSrc).not.toMatch(/name="tareWeightGrams"/);
    expect(pageSrc).not.toMatch(/name="netWeightGrams"/);
    expect(pageSrc).not.toMatch(/name="coreWeightGrams"/);
  });
});

describe("ROLL-WEIGHT-KG-INPUT-1 — weight unit selector removed", () => {
  it("weightUnit select field is gone from form", () => {
    expect(pageSrc).not.toMatch(/name="weightUnit"/);
  });
});

describe("ROLL-WEIGHT-KG-INPUT-1 — action reads Kg fields and converts", () => {
  it("action reads grossWeightKg from FormData", () => {
    expect(actionsSrc).toMatch(/formData\.get\("grossWeightKg"\)/);
  });

  it("action reads tareWeightKg from FormData", () => {
    expect(actionsSrc).toMatch(/formData\.get\("tareWeightKg"\)/);
  });

  it("action reads netWeightKg from FormData", () => {
    expect(actionsSrc).toMatch(/formData\.get\("netWeightKg"\)/);
  });

  it("action reads coreWeightKg from FormData", () => {
    expect(actionsSrc).toMatch(/formData\.get\("coreWeightKg"\)/);
  });

  it("action calls kgToGrams for conversion", () => {
    expect(actionsSrc).toMatch(/kgToGrams/);
  });

  it("action stores weightUnit as kg", () => {
    expect(actionsSrc).toMatch(/weightUnit: "kg"/);
  });
});

describe("ROLL-WEIGHT-KG-INPUT-1 — recent receipts display uses kg", () => {
  it("column header says Net (kg) not Net g", () => {
    expect(pageSrc).toMatch(/Net \(kg\)/);
    expect(pageSrc).not.toMatch(/Net g\b/);
  });

  it("display calls formatGramsAsKg", () => {
    expect(pageSrc).toMatch(/formatGramsAsKg/);
  });
});
