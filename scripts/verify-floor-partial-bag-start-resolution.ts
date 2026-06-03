// FLOOR-PARTIAL-BAG-START-RESOLUTION-1 — static contracts.
//
//   npx tsx scripts/verify-floor-partial-bag-start-resolution.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-floor-partial-bag-start-resolution] FAIL: ${msg}`);
    process.exit(1);
  }
}

function main(): void {
  const resolution = read("lib/production/floor-partial-bag-start-resolution.ts");
  const resolutionTest = read("lib/production/floor-partial-bag-start-resolution.test.ts");
  const floorActions = read("app/(floor)/floor/[token]/actions.ts");
  const adminActions = read("app/(admin)/production/start/actions.ts");
  const partialBags = read("lib/production/partial-bags.ts");

  assert(
    resolution.includes("PARTIAL_NEEDS_REVIEW"),
    "structured PARTIAL_NEEDS_REVIEW status",
  );
  assert(
    resolution.includes("classifyPartialBagInventoryEligibility"),
    "reuses /partial-bags eligibility classifier",
  );
  assert(
    resolution.includes("canRestartAvailablePartialRawBag"),
    "reuses partial restart rules",
  );
  assert(
    resolution.includes(RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW),
    "partial review operator message",
  );
  assert(
    !resolution.includes("sealedPartialCount") &&
      !resolution.includes("sealed_card"),
    "no sealed-card-count inference",
  );

  assert(
    floorActions.includes("loadRawBagStartClassificationForScan"),
    "floor lookup + scan call classifier before receive-first",
  );
  assert(
    adminActions.includes("loadRawBagStartClassificationForScan"),
    "admin start calls classifier",
  );
  assert(
    resolutionTest.includes("bag-card-104 class"),
    "unit test for Needs review vs receive-first",
  );
  assert(
    partialBags.includes("classifyPartialBagInventoryEligibility"),
    "single eligibility source in partial-bags",
  );

  console.log(
    "[verify-floor-partial-bag-start-resolution] PASS — static contracts OK",
  );
}

const RAW_BAG_START_OPERATOR_MESSAGES = {
  PARTIAL_NEEDS_REVIEW:
    "This partial bag needs inventory review before it can be started. Ask a lead/admin to resolve remaining tablets on Available Partial Bags.",
};

main();
