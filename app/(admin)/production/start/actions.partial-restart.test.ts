import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const actionsSrc = readFileSync(join(__dirname, "actions.ts"), "utf8");
const floorActionsSrc = readFileSync(
  join(process.cwd(), "app/(floor)/floor/[token]/actions.ts"),
  "utf8",
);

describe("PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1 · admin start", () => {
  it("allows partial restart QR when canRestartAvailablePartialRawBag", () => {
    expect(actionsSrc).toMatch(/canRestartAvailablePartialRawBag/);
    expect(actionsSrc).toMatch(/allowPartialBagRestart: partialBagRestart/);
  });

  it("validates product against product_allowed_tablets for bag tablet type", () => {
    expect(actionsSrc).toMatch(/productAllowedTablets/);
    expect(actionsSrc).toMatch(/tabletTypeId, bag\.tabletTypeId/);
  });

  it("does not read product_id from a prior workflow_bag row", () => {
    expect(actionsSrc).not.toMatch(
      /select\([\s\S]*productId[\s\S]*from\(workflowBags\)/,
    );
    expect(actionsSrc).toMatch(/insert\(workflowBags\)[\s\S]*productId: product\.id/);
  });
});

describe("PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1 · floor partial resume", () => {
  it("loads allocation sessions by inventoryBagId not old workflowBagId", () => {
    const scanIdx = floorActionsSrc.indexOf("export async function scanCardAction");
    const resumeMarker = floorActionsSrc.indexOf(
      "Partial-bag resume: new workflow_bag",
      scanIdx,
    );
    const block = floorActionsSrc.slice(scanIdx, resumeMarker + 800);
    expect(block).toMatch(/rawBagAllocationSessions\.inventoryBagId/);
    expect(block).not.toMatch(
      /where\(eq\(rawBagAllocationSessions\.workflowBagId, bagId\)\)/,
    );
  });

  it("documents that prior workflow product is not copied on resume insert", () => {
    expect(floorActionsSrc).toMatch(/never copy product_id from/);
  });
});
