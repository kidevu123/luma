// CASE-ITEM-CHECK-v1.4.1 — source-level contract tests for the
// consolidated path's NEEDS_MAPPING composite-IDs gap fix.
//
// The DB has check constraints on the zoho_production_output_ops
// table:
//
//   case_assembly_quantity = 0 OR zoho_case_composite_item_id IS NOT NULL
//   display_assembly_quantity = 0 OR zoho_display_composite_item_id IS NOT NULL
//   (unit-level check too)
//
// Before v1.4.2 the `!sourceWithPo.ok` partial NEEDS_MAPPING insert
// in upsertConsolidatedProductionOutputOpForLot set the assembly
// quantities (from built.payload.output) but NOT the composite-item
// IDs, so the insert was rejected by the DB whenever the lot had any
// displays or cases produced. Fix: pull the composite IDs through
// from the already-built payload at insert time.
//
// This is a source-level test (greps the file). A runtime DB test
// would require a fixture lot with no allocation ledger plus
// displays > 0, which is heavier than the constraint-fix needs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..");
const src = readFileSync(
  resolve(REPO, "lib/db/queries/zoho-production-output-consolidated.ts"),
  "utf8",
);

describe("Consolidated NEEDS_MAPPING insert satisfies the composite-item check constraints", () => {
  it("the !sourceWithPo.ok partial values include zohoCompositeItemId from built.payload.product", () => {
    expect(src).toMatch(
      /zohoCompositeItemId:\s*built\.payload\.product\.unit_composite_item_id/,
    );
  });

  it("the !sourceWithPo.ok partial values include zohoDisplayCompositeItemId from built.payload.product", () => {
    expect(src).toMatch(
      /zohoDisplayCompositeItemId:\s*built\.payload\.product\.display_composite_item_id/,
    );
  });

  it("the !sourceWithPo.ok partial values include zohoCaseCompositeItemId from built.payload.product", () => {
    expect(src).toMatch(
      /zohoCaseCompositeItemId:\s*built\.payload\.product\.case_composite_item_id/,
    );
  });

  it("the fix is wrapped in the CASE-ITEM-CHECK-v1.4.1 marker comment so future readers find the why", () => {
    expect(src).toMatch(/CASE-ITEM-CHECK-v1\.4\.1/);
  });

  it("the fix does NOT bypass or relax the DB constraint — no DROP CONSTRAINT / NULL / 0 hack near the NEEDS_MAPPING insert", () => {
    // The composite-item lines must read from built.payload.product,
    // not be hard-coded to null or zero. Negative-grep:
    expect(src).not.toMatch(
      /zohoCaseCompositeItemId:\s*null[\s\S]+caseAssemblyQuantity:\s*built\.payload\.output\.cases_produced/,
    );
  });
});

describe("Existing v1.4.0 contract preserved", () => {
  it("opValuesFromPayload still sets all three composite IDs from payload.product", () => {
    expect(src).toMatch(/zohoCompositeItemId:\s*payload\.product\.unit_composite_item_id/);
    expect(src).toMatch(/zohoDisplayCompositeItemId:\s*payload\.product\.display_composite_item_id/);
    expect(src).toMatch(/zohoCaseCompositeItemId:\s*payload\.product\.case_composite_item_id/);
  });
});

describe("Check constraint is satisfied for every consolidated insert site, not bypassed", () => {
  // The DB enforces three invariants on zoho_production_output_ops:
  //
  //   case_assembly_quantity = 0  OR zoho_case_composite_item_id    IS NOT NULL
  //   display_assembly_quantity = 0  OR zoho_display_composite_item_id IS NOT NULL
  //   (unit-level check too)
  //
  // The consolidated path has THREE insert sites that touch these
  // columns. The success branch routes through opValuesFromPayload
  // (which always reads composite IDs from the payload); the two
  // partial NEEDS_MAPPING branches insert directly. v1.4.2 fixed the
  // sourceWithPo-failure branch. The built-failure branch zeroes all
  // quantities so the constraint is vacuously satisfied.

  it("the !built.ok partial values keep all assembly quantities at 0 (vacuously satisfies the constraint)", () => {
    // Match the !built.ok block, then assert each quantity is 0.
    const start = src.indexOf("if (!built.ok) {");
    expect(start).toBeGreaterThan(-1);
    const tail = src.slice(start, start + 2000);
    expect(tail).toMatch(/unitAssemblyQuantity:\s*0,?/);
    expect(tail).toMatch(/displayAssemblyQuantity:\s*0,?/);
    expect(tail).toMatch(/caseAssemblyQuantity:\s*0,?/);
  });

  it("the !sourceWithPo.ok partial values pair each non-zero quantity with its composite ID — no bypass, no relaxation, no constraint drop", () => {
    // Capture the !sourceWithPo.ok block (from the line that closes
    // its check to the closing brace before the next branch).
    const start = src.indexOf("if (!sourceWithPo.ok) {");
    expect(start).toBeGreaterThan(-1);
    const tail = src.slice(start, start + 3000);
    // Each assembly quantity is sourced from built.payload.output
    // (cases_produced / displays_produced / units_produced).
    expect(tail).toMatch(/caseAssemblyQuantity:\s*built\.payload\.output\.cases_produced/);
    expect(tail).toMatch(/displayAssemblyQuantity:\s*built\.payload\.output\.displays_produced/);
    expect(tail).toMatch(/unitAssemblyQuantity:\s*built\.payload\.output\.units_produced/);
    // Each composite ID is sourced from built.payload.product (the
    // v1.4.2 fix). Pair the existence of the assembly-quantity line
    // with the existence of the composite-ID line in the same block.
    expect(tail).toMatch(/zohoCaseCompositeItemId:\s*built\.payload\.product\.case_composite_item_id/);
    expect(tail).toMatch(/zohoDisplayCompositeItemId:\s*built\.payload\.product\.display_composite_item_id/);
    expect(tail).toMatch(/zohoCompositeItemId:\s*built\.payload\.product\.unit_composite_item_id/);
    // Negative-greps: no hardcoded null, no skip-this-constraint comment.
    expect(tail).not.toMatch(/zohoCaseCompositeItemId:\s*null/);
    expect(tail).not.toMatch(/DROP CONSTRAINT/i);
    expect(tail).not.toMatch(/skip.*constraint/i);
    expect(tail).not.toMatch(/disable.*constraint/i);
  });

  it("no occurrence of `zohoCaseCompositeItemId: null` anywhere in the consolidated file (would silently break the constraint)", () => {
    expect(src).not.toMatch(/zohoCaseCompositeItemId:\s*null/);
    expect(src).not.toMatch(/zohoDisplayCompositeItemId:\s*null/);
  });

  it("the table check constraint is referenced in a comment near the fix so future readers see WHY the composite IDs are mandatory", () => {
    expect(src).toMatch(/zoho_prod_output_ops_case_item_check/);
  });
});
