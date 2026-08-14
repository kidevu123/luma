// SEALING-STATION-PICKUP-WORKFLOW-CARD-1 — static contract verification.
//
//   npx tsx scripts/verify-sealing-station-pickup-workflow-card.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-sealing-station-pickup-workflow-card] FAIL: ${msg}`);
    process.exit(1);
  }
}

// P4b Task 5 (THE CUTOVER): the UI assertions below pointed at
// scan-card-form.tsx / stage-action-buttons.tsx and at page.tsx's inline
// resolutions, all of which are DELETED. The SERVER-side assertions in
// this script are the ones that carry the invariant, and they stay.
function main(): void {
  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const resolveMod = read("lib/production/floor-scan-resolve.ts");

  assert(
    resolveMod.includes("pickBestFloorScanCard"),
    "floor-scan-resolve: pickBestFloorScanCard exported",
  );
  assert(
    actions.includes("resolveFloorScanLookupRow"),
    "actions: resolveFloorScanLookupRow helper",
  );
  assert(
    actions.includes("loadAssignedPickupScanCandidates"),
    "actions: assigned pickup scan candidates query",
  );
  assert(
    actions.includes("pickBestFloorScanCard"),
    "actions: uses pickBestFloorScanCard",
  );
  assert(
    actions.includes("isWorkflowBagResumableAtSealingAfterPartialPackaging"),
    "actions: partial packaging resume eligibility",
  );

  console.log("[verify-sealing-station-pickup-workflow-card] PASS — static contracts OK");
}

main();
