// ROLL-INTAKE-UX-LEGACY-1 — verifies simplified roll receive UX plumbing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const BASE = join(import.meta.dirname);
const actionsSrc = readFileSync(join(BASE, "actions.ts"), "utf8");
const pageSrc = readFileSync(join(BASE, "page.tsx"), "utf8");
const formSrc = readFileSync(join(BASE, "roll-receive-form.tsx"), "utf8");
const rollsFormsSrc = readFileSync(
  join(BASE, "../../../(floor)/floor/[token]/rolls-forms.tsx"),
  "utf8",
);
const rollActionsSrc = readFileSync(
  join(BASE, "../../../(floor)/floor/[token]/roll-actions.ts"),
  "utf8",
);

describe("ROLL-INTAKE-UX-LEGACY-1 — simplified roll tab", () => {
  it("page uses RollReceiveForm instead of inline verbose form", () => {
    expect(pageSrc).toMatch(/RollReceiveForm/);
    expect(pageSrc).not.toMatch(/name="grossWeightKg"/);
    expect(pageSrc).not.toMatch(/name="widthMm"/);
  });

  it("batch form exposes receipt type and roll count", () => {
    expect(formSrc).toMatch(/Legacy opening balance/);
    expect(formSrc).toMatch(/Number of rolls/);
    expect(formSrc).toMatch(/Net weight \(kg\)/);
    expect(formSrc).toMatch(/Advanced details/);
  });

  it("batch action reads rollsJson and converts kg", () => {
    expect(actionsSrc).toMatch(/receiveRollsBatchAction/);
    expect(actionsSrc).toMatch(/rollsJson/);
    expect(actionsSrc).toMatch(/kgToGrams/);
    expect(actionsSrc).toMatch(/adminMountRollLot/);
  });

  it("recent receipts still display net weight in kg", () => {
    expect(pageSrc).toMatch(/Net \(kg\)/);
    expect(pageSrc).toMatch(/formatGramsAsKg/);
  });
});

describe("ROLL-INTAKE-UX-LEGACY-1 — spent roll / core weight in kg", () => {
  it("unmount form labels spent roll weight in kg", () => {
    expect(rollsFormsSrc).toMatch(/Spent roll \/ core weight \(kg/);
    expect(rollsFormsSrc).toMatch(/name="endingWeightKg"/);
  });

  it("unmount action accepts endingWeightKg", () => {
    expect(rollActionsSrc).toMatch(/endingWeightKg/);
    expect(rollActionsSrc).toMatch(/kgToGrams/);
  });
});
