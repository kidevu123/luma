// SPLIT-BAG-1 — structural coverage of the system-derived closeout wiring.
// The DB paths are exercised by the pure calculator tests
// (system-derived-allocation.test.ts) + these source assertions, since the
// default vitest run has no Postgres harness (see vitest.config.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const serviceSrc = repo("lib/production/system-derived-allocation-resolution.ts");
const actionSrc = repo("app/(admin)/partial-bags/actions.ts");
const pageSrc = repo("app/(admin)/partial-bags/page.tsx");
const buttonSrc = repo("app/(admin)/partial-bags/use-calculated-remaining-button.tsx");
const lifecycleSrc = repo("lib/production/raw-bag-allocation-lifecycle.ts");

describe("service — resolves via the proven close path, honest + audited", () => {
  it("closes through closeAllocationSessionInTx with no finished lot and OUTPUT_DERIVED source", () => {
    expect(serviceSrc).toMatch(/closeAllocationSessionInTx/);
    expect(serviceSrc).toMatch(/finishedLotId: null/);
    expect(serviceSrc).toMatch(/endingBalanceSource: "OUTPUT_DERIVED"/);
    // derived remaining/consumed drive the close (not a manual entry).
    expect(serviceSrc).toMatch(/consumedQty: resolution\.derivedConsumedTablets/);
    expect(serviceSrc).toMatch(/endingBalanceQty: resolution\.derivedRemainingTablets/);
  });

  it("writes an explicit SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT audit with full provenance", () => {
    expect(serviceSrc).toMatch(/raw_bag_allocation\.system_derived_resolution/);
    expect(serviceSrc).toMatch(/resolution_source: SYSTEM_DERIVED_SOURCE/);
    expect(serviceSrc).toMatch(/starting_tablet_count:/);
    expect(serviceSrc).toMatch(/derived_consumed_tablets:/);
    expect(serviceSrc).toMatch(/derived_remaining_tablets:/);
    expect(serviceSrc).toMatch(/source_workflow_bag_id:/);
    expect(serviceSrc).toMatch(/output_stage:/);
    // Supporting evidence is recorded but never replaces the derived value.
    expect(serviceSrc).toMatch(/operator_remaining_estimate:/);
    expect(serviceSrc).toMatch(/weigh_back_grams:/);
    expect(serviceSrc).toMatch(/not physically counted/i);
  });

  it("derives units live from production output (works before finalize)", () => {
    expect(serviceSrc).toMatch(/deriveStageOutputForBag/);
    expect(serviceSrc).toMatch(/pickDeepestOutput/);
    expect(serviceSrc).toMatch(/deriveSystemRemainingFromOutput/);
  });
});

describe("close helper — finishedLotId is now optional (mid-run has no lot)", () => {
  it("accepts an optional finishedLotId and only sets it when present", () => {
    expect(lifecycleSrc).toMatch(/finishedLotId\?: string \| null/);
    expect(lifecycleSrc).toMatch(/\.\.\.\(input\.finishedLotId \? \{ finishedLotId: input\.finishedLotId \} : \{\}\)/);
  });
  it("still clears assignedWorkflowBagId when the bag empties (IDLE invariant preserved)", () => {
    expect(lifecycleSrc).toMatch(/status: "IDLE", assignedWorkflowBagId: null/);
  });
});

describe("admin action — lead-guarded one-click", () => {
  it("requires a lead and delegates to the resolution service", () => {
    expect(actionSrc).toMatch(/export async function useCalculatedRemainingAction/);
    expect(actionSrc).toMatch(/const actor = await requireLead\(\)/);
    expect(actionSrc).toMatch(/resolveAllocationFromProductionOutput/);
    expect(actionSrc).toMatch(/revalidatePath\("\/partial-bags"\)/);
  });
});

describe("workbench UI — calculated remaining state + button, manual preserved", () => {
  it("page shows the formula and reason, and keeps manual closeout links", () => {
    expect(pageSrc).toMatch(/Calculated remaining available/);
    expect(pageSrc).toMatch(/start −/); // starting − consumed = remaining formula
    expect(pageSrc).toMatch(/not a physical count/i);
    expect(pageSrc).toMatch(/Calculated remaining unavailable/);
    // Manual paths still present.
    expect(pageSrc).toMatch(/Record closeout/);
    expect(pageSrc).toMatch(/Resolve inventory/);
    expect(pageSrc).toMatch(/PartialBagCorrectionMenu/);
    expect(pageSrc).toMatch(/UseCalculatedRemainingButton/);
  });
  it("button confirms it is system-derived, not a physical count", () => {
    expect(buttonSrc).toMatch(/useCalculatedRemainingAction/);
    expect(buttonSrc).toMatch(/system-derived from production output/i);
    expect(buttonSrc).toMatch(/not a physical count/i);
  });
});

describe("floor blocker — actionable, not a dead-end", () => {
  it("names the calculated-remaining resolution instead of a bare 'session open' error", () => {
    expect(lifecycleSrc).toMatch(/Use calculated remaining/);
    expect(lifecycleSrc).not.toMatch(/Close it before starting again\./);
  });
});
