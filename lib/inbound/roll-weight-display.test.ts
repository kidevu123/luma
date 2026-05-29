// ROLL-WEIGHT-DISPLAY-KG-1 — roll management UI shows kg, not raw grams.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { formatGramsAsKg } from "./roll-weight";

const ROOT = join(import.meta.dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("ROLL-WEIGHT-DISPLAY-KG-1 — formatGramsAsKg acceptance examples", () => {
  it("formats legacy roll net weights as kg with trimmed decimals", () => {
    expect(formatGramsAsKg(6120)).toBe("6.12 kg");
    expect(formatGramsAsKg(9280)).toBe("9.28 kg");
  });
});

describe("ROLL-WEIGHT-DISPLAY-KG-1 — floor roll management surfaces", () => {
  const rollsForms = read("app/(floor)/floor/[token]/rolls-forms.tsx");
  const rollsPage = read("app/(floor)/floor/[token]/rolls/page.tsx");
  const stationPanel = read("app/(floor)/floor/[token]/station-roll-panel.tsx");

  it("mount and change roll dropdowns use formatGramsAsKg", () => {
    expect(rollsForms).toMatch(/formatGramsAsKg\(lot\.netWeightGrams\)/);
    expect(rollsForms).not.toMatch(/netWeightGrams\} g/);
  });

  it("floor rolls page active roll estimate uses formatGramsAsKg", () => {
    expect(rollsPage).toMatch(/formatGramsAsKg\(r\.currentWeightEstimateGrams\)/);
    expect(rollsPage).not.toMatch(/currentWeightEstimateGrams\} g/);
  });

  it("station roll panel shows estimated weight in kg", () => {
    expect(stationPanel).toMatch(
      /formatGramsAsKg\(activeRoll\.currentWeightEstimateGrams\)/,
    );
    expect(stationPanel).not.toMatch(/currentWeightEstimateGrams\} g/);
  });
});

describe("ROLL-WEIGHT-DISPLAY-KG-1 — admin roll panels", () => {
  const activeRolls = read("app/(admin)/active-rolls/page.tsx");
  const rollVariance = read("app/(admin)/roll-variance/page.tsx");

  it("active rolls table and badges use formatGramsAsKg", () => {
    expect(activeRolls).toMatch(/formatGramsAsKg\(r\.currentWeightGramsEstimate\)/);
    expect(activeRolls).toMatch(/formatGramsAsKg\(roll\.currentWeightGramsEstimate\)/);
    expect(activeRolls).not.toMatch(/currentWeightGramsEstimate\} g/);
    expect(activeRolls).not.toMatch(/startingWeightGrams\} g/);
  });

  it("roll variance summary and detail use formatGramsAsKg", () => {
    expect(rollVariance).toMatch(/formatGramsAsKg\(s\.totalVarianceGrams\)/);
    expect(rollVariance).toMatch(/formatGramsAsKg\(r\.expectedUsedGrams\)/);
    expect(rollVariance).toMatch(/formatGramsAsKg\(r\.actualUsedGrams\)/);
    expect(rollVariance).toMatch(/formatGramsAsKg\(r\.varianceGrams\)/);
    expect(rollVariance).not.toMatch(/expectedUsedGrams\} g/);
    expect(rollVariance).not.toMatch(/actualUsedGrams\} g/);
    expect(rollVariance).not.toMatch(/varianceGrams\} g/);
  });
});
