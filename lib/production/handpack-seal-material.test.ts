import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const materialSrc = readFileSync(
  join(__dirname, "handpack-seal-material.ts"),
  "utf8",
);
const actionsSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/actions.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/page.tsx"),
  "utf8",
);
const stageSrc = readFileSync(
  join(__dirname, "../../app/(floor)/floor/[token]/stage-action-buttons.tsx"),
  "utf8",
);

describe("SEALING-FLOW-CLARITY-2 · hand-pack seal material helper", () => {
  it("detects HANDPACK_BLISTER_COMPLETE in bag history", () => {
    expect(materialSrc).toMatch(/workflowBagHasHandpackBlisterComplete/);
    expect(materialSrc).toMatch(/HANDPACK_BLISTER_COMPLETE/);
  });

  it("issues BLISTER_CARD lot with handpack_seal reason", () => {
    expect(materialSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    expect(materialSrc).toMatch(/handpack_seal/);
    expect(materialSrc).toMatch(/PACKAGING_MATERIAL_ISSUED/);
  });
});

describe("SEALING-FLOW-CLARITY-2 · unified sealing completion path", () => {
  it("fireStageEventAction uses hand-pack material helper on SEALING_COMPLETE", () => {
    expect(actionsSrc).toMatch(/from "@\/lib\/production\/handpack-seal-material"/);
    expect(actionsSrc).toMatch(/workflowBagHasHandpackBlisterComplete/);
    expect(actionsSrc).toMatch(/issueHandpackBlisterCardMaterial/);
  });

  it("sealHandpackBagAction removed — single completion path", () => {
    expect(actionsSrc).not.toMatch(/export async function sealHandpackBagAction/);
  });

  it("page no longer renders SealHandpackForm", () => {
    expect(pageSrc).not.toMatch(/SealHandpackForm/);
    expect(pageSrc).not.toMatch(/seal-handpack-form/);
    expect(pageSrc).not.toMatch(/bagIsHandpacked/);
  });

  it("stage-action-buttons always exposes SEALING_COMPLETE — no hand-pack filter", () => {
    expect(stageSrc).not.toMatch(/bagIsHandpacked/);
    expect(stageSrc).not.toMatch(/SealHandpackForm/);
    expect(stageSrc).toMatch(/SealingCompleteForm/);
    expect(stageSrc).toMatch(/Counter presses/);
  });

  it("scan-card-form unchanged", () => {
    const scanSrc = readFileSync(
      join(__dirname, "../../app/(floor)/floor/[token]/scan-card-form.tsx"),
      "utf8",
    );
    expect(scanSrc).not.toMatch(/SealHandpackForm/);
    expect(scanSrc).not.toMatch(/handpack-seal-material/);
  });

  it("stage-progression unchanged", () => {
    const progressionSrc = readFileSync(
      join(__dirname, "stage-progression.ts"),
      "utf8",
    );
    expect(progressionSrc).not.toMatch(/handpack-seal-material/);
    expect(progressionSrc).not.toMatch(/issueHandpackBlisterCardMaterial/);
  });
});
