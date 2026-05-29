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

describe("ROLL-INTAKE-NUMBER-INPUT-FIX-1 — text numeric fields (no wheel mutation)", () => {
  it("roll count uses text input with inputMode numeric, not type number", () => {
    expect(formSrc).toMatch(/Number of rolls[\s\S]{0,400}inputMode="numeric"/);
    expect(formSrc).not.toMatch(/Number of rolls[\s\S]{0,200}type="number"/);
  });

  it("net weight rows use text decimal input, not type number", () => {
    expect(formSrc).toMatch(/Net weight \(kg\)[\s\S]{0,300}inputMode="decimal"/);
    expect(formSrc).not.toMatch(/netWeightKg[\s\S]{0,200}type="number"/);
  });

  it("advanced numeric fields use text inputMode not type number", () => {
    expect(formSrc).not.toMatch(/type="number"/);
    expect(formSrc).toMatch(/name="widthMm"/);
    expect(formSrc).toMatch(/name="grossWeightKg"/);
    expect(formSrc).toMatch(/inputMode="numeric"/);
    expect(formSrc).toMatch(/inputMode="decimal"/);
  });

  it("roll count defaults to string 1 and parses without || 1 coercion", () => {
    expect(formSrc).toMatch(/useState\("1"\)/);
    expect(formSrc).not.toMatch(/Number\(e\.target\.value\) \|\| 1/);
    expect(formSrc).toMatch(/parseRollCountInput/);
    expect(formSrc).toMatch(/rollCountError/);
  });

  it("uses shared roll-receive-input helpers", () => {
    const helpers = readFileSync(
      join(BASE, "../../../../lib/inbound/roll-receive-input.ts"),
      "utf8",
    );
    expect(helpers).toMatch(/parseRollCountInput/);
    expect(helpers).toMatch(/parseDecimalKgInput/);
    expect(formSrc).toMatch(/sanitizeRollCountTyping/);
    expect(formSrc).toMatch(/resizeRollRows/);
  });
});

describe("ROLL-INTAKE-NUMBER-INPUT-POLISH-1 — scroll safety and editable roll count", () => {
  it("roll count input uses type=text not type=number (no wheel mutation)", () => {
    // NumericTextInput always renders type="text"
    expect(formSrc).toMatch(/type="text"/);
    expect(formSrc).not.toMatch(/type="number"/);
  });

  it("roll count state is a string (allows temporary empty while editing)", () => {
    expect(formSrc).toMatch(/rollCountText/);
    expect(formSrc).toMatch(/useState.*"1"/);
  });

  it("sanitizeRollCountTyping allows empty string (backspace works)", () => {
    expect(formSrc).toMatch(/sanitizeRollCountTyping/);
  });

  it("roll count commits on blur, not on every keystroke", () => {
    expect(formSrc).toMatch(/onBlur.*handleRollCountBlur|handleRollCountBlur.*onBlur/);
  });

  it("form is noValidate (browser validation suppressed, JS handles it)", () => {
    expect(formSrc).toMatch(/noValidate/);
  });

  it("action schema allows optional receiptNumber at receive", () => {
    expect(actionsSrc).toMatch(/receiptNumber: z\.string\(\)\.max\(60\)\.optional\(\)\.nullable\(\)/);
  });

  it("form marks receiptNumber as required in UI", () => {
    expect(formSrc).toMatch(/name="receiptNumber"[\s\S]{0,200}required/);
  });

  it("form defaults receiptType to NORMAL", () => {
    expect(formSrc).toMatch(/useState.*"NORMAL"/);
  });
});

describe("ROLL-INTAKE-AUTO-NUMBER-1 — generated roll numbers", () => {
  it("form tracks material and receipt reference for automatic roll labels", () => {
    expect(formSrc).toMatch(/selectedMaterialId/);
    expect(formSrc).toMatch(/receiptNumber/);
    expect(formSrc).toMatch(/applyGeneratedRollNumbers/);
    expect(formSrc).toMatch(/materialKind:\s*selectedMaterial\.kind/);
    expect(formSrc).toMatch(/receiptReference:\s*receiptNumber/);
  });

  it("manual roll number edits are marked manual so generation will not overwrite them", () => {
    expect(formSrc).toMatch(/rollNumberSource:\s*"manual"/);
    expect(formSrc).toMatch(/rollNumber:\s*ev\.target\.value/);
  });

  it("receive button still reflects the committed roll count, including 58", () => {
    expect(formSrc).toMatch(/`Receive \$\{committedRollCount\} roll/);
  });

  it("roll count and weight fields remain text/inputMode (no type=number regression)", () => {
    expect(formSrc).not.toMatch(/type="number"/);
    expect(formSrc).toMatch(/inputMode="numeric"/);
    expect(formSrc).toMatch(/inputMode="decimal"/);
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
