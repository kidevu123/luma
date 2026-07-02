// Regression guard for digest 3975426362 — the Partial Bag Workbench
// Server-Component render crashed with a Postgres error because
// deriveStageOutputForBag (reached via the workbench's system-derived
// resolution) referenced columns that do not exist:
//   • finished_lots.units_finished        → real column is units_produced
//   • finished_lot_inputs.workflow_bag_id → that table is batch-scoped;
//                                            the link is finished_lots.workflow_bag_id
// Both errored at SQL parse time, so every caller hard-crashed. Structural
// (no Postgres harness in the default vitest run); the corrected query was
// verified read-only against production.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const reconSrc = repo("lib/production/output-reconciliation.ts");
const pageSrc = repo("app/(admin)/partial-bags/page.tsx");

describe("output-reconciliation — finished-units query uses real columns", () => {
  it("never references the non-existent units_finished column", () => {
    // (Ignore the explanatory comment — assert no live column reference.)
    expect(reconSrc).not.toMatch(/fl\.units_finished/);
    expect(reconSrc).not.toMatch(/SUM\(fl\.units_finished\)/);
  });

  it("sums finished_lots.units_produced linked directly by workflow_bag_id", () => {
    expect(reconSrc).toMatch(/SUM\(fl\.units_produced\)/);
    expect(reconSrc).toMatch(/FROM finished_lots fl\s*\n?\s*WHERE fl\.workflow_bag_id/);
  });

  it("no longer joins finished_lot_inputs on a workflow_bag_id it doesn't have", () => {
    expect(reconSrc).not.toMatch(/finished_lot_inputs fli/);
    expect(reconSrc).not.toMatch(/fli\.workflow_bag_id/);
  });
});

describe("Partial Bag Workbench — resilient to a single bad row", () => {
  it("wraps per-bag system-derived resolution so one failure can't crash the page", () => {
    // The Promise.all over needs-closeout / missing-linkage rows must not
    // reject as a whole when one bag's resolution throws.
    expect(pageSrc).toMatch(/try \{\s*\n?\s*systemDerived\.set\(r\.bagId, await computeSystemDerivedResolutionForBag/);
    expect(pageSrc).toMatch(/catch \{/);
    expect(pageSrc).toMatch(/reason: "COMPUTE_FAILED"/);
    expect(pageSrc).toMatch(/Calculation unavailable for this bag\./);
  });

  it("the unavailable branch already renders a safe fallback message", () => {
    // available:false resolutions (including COMPUTE_FAILED) render text,
    // never dereference calc numbers.
    expect(pageSrc).toMatch(/Calculated remaining unavailable: \{sd\.message\}/);
  });
});
