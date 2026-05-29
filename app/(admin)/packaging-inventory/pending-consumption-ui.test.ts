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
const actionsSrc = readFileSync(
  join(import.meta.dirname, "../../(floor)/floor/[token]/actions.ts"),
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

describe("PACKAGING-PENDING-CONSUMPTION-HONESTY-1 · packaging close-out", () => {
  it("persists consumption summary and refreshes read models", () => {
    const block = actionsSrc.slice(
      actionsSrc.indexOf("export async function packagingCompleteAction"),
      actionsSrc.indexOf("export async function lookupCardByTokenAction"),
    );
    expect(block).toMatch(/buildPackagingConsumptionPayloadSummary/);
    expect(block).toMatch(/patchPackagingCompleteConsumptionSummary/);
    expect(block).toMatch(/refreshMaterialReadModelsAfterConsumption/);
    expect(block).not.toMatch(/void consumption/);
  });

  it("does not rename existing PACKAGING_COMPLETE payload keys", () => {
    const block = actionsSrc.slice(
      actionsSrc.indexOf("export async function packagingCompleteAction"),
      actionsSrc.indexOf("export async function lookupCardByTokenAction"),
    );
    expect(block).toMatch(/master_cases:/);
    expect(block).toMatch(/displays_made:/);
    expect(block).toMatch(/loose_cards:/);
    expect(block).toMatch(/damaged_packaging:/);
    expect(block).toMatch(/ripped_cards:/);
  });
});

describe("PACKAGING-PENDING-CONSUMPTION-HONESTY-1 · hand-pack seal material", () => {
  it("emits MATERIAL_CONSUMED_ESTIMATED when no lot is available", () => {
    expect(materialSrc).toMatch(/emitHandpackBlisterEstimatedMaterial/);
    expect(materialSrc).toMatch(/MATERIAL_CONSUMED_ESTIMATED/);
    expect(materialSrc).toMatch(/no_lot_reason/);
  });

  it("actions emit estimated material on no_available_lot skip", () => {
    expect(actionsSrc).toMatch(/emitHandpackBlisterEstimatedMaterial/);
    expect(actionsSrc).toMatch(/handpackMaterialSkip === "no_available_lot"/);
  });

  it("preserves skip audit flags on SEALING_COMPLETE", () => {
    expect(actionsSrc).toMatch(/handpack_blister_material_skipped/);
    expect(actionsSrc).toMatch(/handpack_blister_material_skip_reason/);
  });
});
