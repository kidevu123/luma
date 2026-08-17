import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const inventoryPageSrc = readFileSync(
  join(import.meta.dirname, "page.tsx"),
  "utf8",
);
const outputPageSrc = readFileSync(
  join(import.meta.dirname, "../packaging-output/page.tsx"),
  "utf8",
);
// P6 Task 4 — fireStageEventAction and packagingCompleteAction were
// retired (thin forwarders with zero non-test callers post P4b). The
// scanners below now read the engine sources DIRECTLY instead of splicing
// them back into actions.ts.
const recordStageEventSrc = readFileSync(
  join(
    import.meta.dirname,
    "../../../lib/production/engine/record-stage-event.ts",
  ),
  "utf8",
);
const recordPackagingCompleteSrc = readFileSync(
  join(
    import.meta.dirname,
    "../../../lib/production/engine/record-packaging-complete.ts",
  ),
  "utf8",
);
const materialSrc = readFileSync(
  join(import.meta.dirname, "../../../lib/production/handpack-seal-material.ts"),
  "utf8",
);

describe("PACKAGING-PENDING-CONSUMPTION-HONESTY-1 · admin UI", () => {
  it("packaging inventory shows on hand, pending, and net balance", () => {
    expect(inventoryPageSrc).toMatch(/loadMaterialBalanceSummary/);
    expect(inventoryPageSrc).toMatch(/Pending consumption/);
    expect(inventoryPageSrc).toMatch(/Net balance/);
    expect(inventoryPageSrc).toMatch(/Negative balance/);
    expect(inventoryPageSrc).toMatch(/Needs receipt/);
  });

  it("packaging output highlights estimated-only burn", () => {
    expect(outputPageSrc).toMatch(/Estimated · Needs receipt/);
    expect(outputPageSrc).toMatch(/actual_qty/);
    expect(outputPageSrc).toMatch(/estimated_qty/);
  });
});

describe("PACKAGING-PENDING-CONSUMPTION-HONESTY-1 · packaging close-out (engine)", () => {
  it("persists consumption summary and refreshes read models", () => {
    expect(recordPackagingCompleteSrc).toMatch(
      /buildPackagingConsumptionPayloadSummary/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /patchPackagingCompleteConsumptionSummary/,
    );
    expect(recordPackagingCompleteSrc).toMatch(
      /refreshMaterialReadModelsAfterConsumption/,
    );
    expect(recordPackagingCompleteSrc).not.toMatch(/void consumption/);
  });

  it("does not rename existing PACKAGING_COMPLETE payload keys", () => {
    expect(recordPackagingCompleteSrc).toMatch(/master_cases:/);
    expect(recordPackagingCompleteSrc).toMatch(/displays_made:/);
    expect(recordPackagingCompleteSrc).toMatch(/loose_cards:/);
    expect(recordPackagingCompleteSrc).toMatch(/damaged_packaging:/);
    expect(recordPackagingCompleteSrc).toMatch(/ripped_cards:/);
  });
});

describe("PACKAGING-PENDING-CONSUMPTION-HONESTY-1 · hand-pack seal material", () => {
  it("emits MATERIAL_CONSUMED_ESTIMATED when no lot is available", () => {
    expect(materialSrc).toMatch(/emitHandpackBlisterEstimatedMaterial/);
    expect(materialSrc).toMatch(/MATERIAL_CONSUMED_ESTIMATED/);
    expect(materialSrc).toMatch(/no_lot_reason/);
  });

  it("engine stage-event body emits estimated material on no_available_lot skip", () => {
    expect(recordStageEventSrc).toMatch(/emitHandpackBlisterEstimatedMaterial/);
    expect(recordStageEventSrc).toMatch(
      /handpackMaterialSkip === "no_available_lot"/,
    );
  });

  it("preserves skip audit flags on SEALING_COMPLETE", () => {
    expect(recordStageEventSrc).toMatch(/handpack_blister_material_skipped/);
    expect(recordStageEventSrc).toMatch(
      /handpack_blister_material_skip_reason/,
    );
  });
});
