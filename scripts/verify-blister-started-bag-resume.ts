// BLISTER-STARTED-BAG-RESUME-CLOSEOUT-1 — static contract verification.
//
//   npx tsx scripts/verify-blister-started-bag-resume.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify-blister-started-bag-resume] FAIL: ${msg}`);
    process.exit(1);
  }
}

function main(): void {
  const actions = read("app/(floor)/floor/[token]/actions.ts");
  const page = read("app/(floor)/floor/[token]/page.tsx");
  const progression = read("lib/production/stage-progression.ts");
  const resolveMod = read("lib/production/floor-scan-resolve.ts");

  assert(
    progression.includes("STATION_STARTED_RESUME_FROM_STAGE"),
    "stage-progression: STARTED resume stages",
  );
  assert(
    progression.includes("formatFloorStationBagOpenError"),
    "stage-progression: operator-safe stage mismatch copy",
  );
  assert(
    actions.includes("STATION_STARTED_RESUME_FROM_STAGE"),
    "actions: imports STARTED resume stages",
  );
  assert(
    actions.includes("same_station_resume: true"),
    "actions: same-station STARTED resume path",
  );
  assert(
    !actions.includes("no pickup stages defined"),
    "actions: developer pickup error removed",
  );
  assert(
    actions.includes("formatFloorStationBagOpenError"),
    "actions: uses operator-safe mismatch helper",
  );
  assert(page.includes("eligibleStartedResumes"), "page: STARTED resume dropdown rows");
  assert(
    resolveMod.includes("card\\s*#"),
    "floor-scan-resolve: Card # label normalization",
  );

  console.log("[verify-blister-started-bag-resume] PASS — static contracts OK");
}

main();
