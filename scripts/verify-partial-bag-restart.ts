// PARTIAL-BAG-RESTART-PRODUCT-SELECTION-1 — static contracts.
//
//   npx tsx scripts/verify-partial-bag-restart.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-partial-bag-restart] FAIL: ${msg}`);
    process.exit(1);
  }
}

function main(): void {
  const restart = read("lib/production/partial-bag-restart.ts");
  const startProd = read("lib/production/start-production.ts");
  const adminActions = read("app/(admin)/production/start/actions.ts");
  const floorActions = read("app/(floor)/floor/[token]/actions.ts");
  const partialPage = read("app/(admin)/partial-bags/page.tsx");
  const startPage = read("app/(admin)/production/start/page.tsx");

  assert(restart.includes("canRestartAvailablePartialRawBag"), "restart helper");
  assert(
    startProd.includes("allowPartialBagRestart"),
    "validateRawBagQrForStart partial option",
  );
  assert(
    adminActions.includes("canRestartAvailablePartialRawBag"),
    "admin start partial gate",
  );
  assert(
    adminActions.includes("productAllowedTablets"),
    "admin start tablet lineage check",
  );
  assert(
    floorActions.includes("canResumeFinalizedWorkflowOnInventoryBag"),
    "floor resume uses inventory sessions",
  );
  assert(
    floorActions.includes("rawBagAllocationSessions.inventoryBagId"),
    "floor session lookup by inventory bag",
  );
  assert(
    floorActions.includes("never copy product_id"),
    "floor resume does not inherit product",
  );
  assert(
    partialPage.includes("/production/start?inventoryBagId="),
    "partial-bags Start run link",
  );
  assert(startPage.includes("initialInventoryBagId"), "start page prefill param");
  assert(
    floorActions.includes("SEALING_PRODUCT_ALREADY_SAVED_ERROR"),
    "sealing product lock still enforced",
  );

  console.log("[verify-partial-bag-restart] PASS — static contracts OK");
}

main();
