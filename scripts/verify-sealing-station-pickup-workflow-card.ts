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

function main(): void {
  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const form = read("app/(floor)/floor/[token]/scan-card-form.tsx");
  const page = read("app/(floor)/floor/[token]/page.tsx");
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
  assert(form.includes('fd.set("stationId", stationId)'), "scan form passes stationId to lookup");
  assert(
    page.includes("partialSealingCloseoutByBag"),
    "page: partial sealing close-out per pickup bag",
  );
  assert(
    !page.includes("hasPartialSealingCloseout: false"),
    "page: no hardcoded hasPartialSealingCloseout false",
  );

  console.log("[verify-sealing-station-pickup-workflow-card] PASS — static contracts OK");
}

main();
