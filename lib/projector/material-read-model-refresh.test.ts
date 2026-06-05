import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd());

describe("material read model refresh wiring", () => {
  it("projectEvent refreshes after BLISTER_COMPLETE segments", () => {
    const src = readFileSync(
      join(root, "lib/projector/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/refreshMaterialReadModelsAfterBlister/);
  });

  it("consumption refresh rebuilds burn and optional recommendations", () => {
    const src = readFileSync(
      join(root, "lib/projector/material-read-model-refresh.ts"),
      "utf8",
    );
    expect(src).toMatch(/rebuildMaterialBurn/);
    expect(src).toMatch(/rebuildMaterialReconciliationV2ForLot/);
    expect(src).toMatch(/rebuildMaterialRecommendations/);
  });

  it("blister refresh rebuilds roll usage for active station lots", () => {
    const src = readFileSync(
      join(root, "lib/projector/material-read-model-refresh.ts"),
      "utf8",
    );
    expect(src).toMatch(/refreshMaterialReadModelsAfterBlister/);
    expect(src).toMatch(/refreshRollDerivedReadModels/);
    expect(src).toMatch(/getActiveRollLotIdsForStation/);
  });

  it("roll-actions use refreshMaterialReadModelsAfterConsumption", () => {
    const src = readFileSync(
      join(root, "app/(floor)/floor/[token]/roll-actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/refreshMaterialReadModelsAfterConsumption/);
    expect(src).not.toMatch(/refreshRollDerivedReadModels/);
  });
});
