// READY-PARTIAL-FLOOR-START-1 — static contracts for Ready partial floor restart.
//
//   npx tsx scripts/verify-ready-partial-floor-start.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-ready-partial-floor-start] FAIL: ${msg}`);
    process.exit(1);
  }
}

function main(): void {
  const resolution = read("lib/production/floor-partial-bag-start-resolution.ts");
  const resolutionTest = read("lib/production/floor-partial-bag-start-resolution.test.ts");
  const floorActions = read("app/(floor)/floor/[token]/actions.ts");

  assert(
    resolution.includes("hasPartialPackagingWorkflow") &&
      resolution.indexOf("hasPartialPackagingWorkflow") <
        resolution.indexOf("hasActiveNonFinalizedWorkflow"),
    "partial eligibility checked before active-workflow gate",
  );
  assert(
    resolutionTest.includes("stale non-finalized legacy workflow"),
    "unit test for Ready partial with stale workflow",
  );
  assert(
    floorActions.includes('partialStart.status === "PARTIAL_READY"'),
    "floor scan handles PARTIAL_READY on ASSIGNED cards",
  );
  assert(
    floorActions.includes("partial_bag_restart: true"),
    "floor restart marks partial_bag_restart on CARD_ASSIGNED",
  );
  assert(
    floorActions.includes("prior_workflow_bag_id: bagId"),
    "floor restart records prior workflow bag",
  );
  assert(
    floorActions.includes("allowPartialBagRestart: true"),
    "floor partial restart bypasses stale ASSIGNED readiness block",
  );
  assert(
    !floorActions.includes("not ready for this station yet") ||
      floorActions.includes("formatFloorStationBagOpenError"),
    "generic station error only via stage progression helper",
  );

  console.log("[verify-ready-partial-floor-start] PASS — static contracts OK");
}

main();
