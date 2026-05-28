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

describe("SEALING-MATERIAL-NONBLOCKING-1 · product-matched non-blocking lot lookup", () => {
  it("uses product BOM to find BLISTER_CARD lots — not global oldest", () => {
    expect(materialSrc).toMatch(/lookupProductMatchedBlisterCardLot/);
    expect(materialSrc).toMatch(/productPackagingSpecs/);
    expect(materialSrc).toMatch(/eq\(productPackagingSpecs\.productId, bag\.productId\)/);
    expect(materialSrc).toMatch(/inArray\(packagingLots\.packagingMaterialId, materialIds\)/);
    expect(materialSrc).not.toMatch(/findOldestAvailableBlisterCardLot/);
  });

  it("returns skipped status instead of throwing when no lot", () => {
    expect(materialSrc).toMatch(/status: "skipped"/);
    expect(materialSrc).toMatch(/no_product_id/);
    expect(materialSrc).toMatch(/no_bom_blister_card/);
    expect(materialSrc).toMatch(/no_available_lot/);
  });

  it("fireStageEventAction does not block SEALING_COMPLETE on missing lot", () => {
    expect(actionsSrc).toMatch(/lookupProductMatchedBlisterCardLot/);
    expect(actionsSrc).not.toMatch(
      /No available pre-made blister lot found/,
    );
    expect(actionsSrc).not.toMatch(/Receive stock first/);
  });

  it("records skip reason on SEALING_COMPLETE payload when lot unavailable", () => {
    expect(actionsSrc).toMatch(/handpack_blister_material_skipped/);
    expect(actionsSrc).toMatch(/handpack_blister_material_skip_reason/);
  });

  it("still issues material only when product-matched lot is found", () => {
    expect(actionsSrc).toMatch(/lotLookup\.status === "found"/);
    expect(actionsSrc).toMatch(/issueHandpackBlisterCardMaterial/);
    const issueIdx = actionsSrc.indexOf("await issueHandpackBlisterCardMaterial");
    const issueBlock = actionsSrc.slice(issueIdx - 120, issueIdx + 40);
    expect(issueBlock).toMatch(/handpackBlisterLot/);
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

describe("SEALING-MATERIAL-NONBLOCKING-1 · counter presses scroll-safe input", () => {
  function sealingFormBlock(): string {
    const formIdx = stageSrc.indexOf("function SealingCompleteForm");
    const blisterIdx = stageSrc.indexOf("function BlisterCompleteForm");
    return stageSrc.slice(formIdx, blisterIdx);
  }

  it("Counter presses NumField uses scrollSafe to prevent wheel changes", () => {
    const block = sealingFormBlock();
    expect(block).toMatch(/label="Counter presses"/);
    expect(block).toMatch(/scrollSafe/);
    const numFieldIdx = stageSrc.indexOf("function NumField");
    expect(stageSrc.slice(numFieldIdx, numFieldIdx + 900)).toMatch(/onWheel/);
  });
});
