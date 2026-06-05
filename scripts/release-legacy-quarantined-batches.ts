#!/usr/bin/env npx tsx
/**
 * Release quarantined input lots that look like legacy default quarantine
 * (eligible per assessBulkReleaseEligibility). Dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/release-legacy-quarantined-batches.ts
 *   npx tsx scripts/release-legacy-quarantined-batches.ts --apply
 *   npx tsx scripts/release-legacy-quarantined-batches.ts --apply --actor-id=<uuid>
 */

import { assessBulkReleaseCandidates, bulkReleaseQuarantinedBatches } from "@/lib/db/queries/batches";

async function main() {
  const apply = process.argv.includes("--apply");
  const actorArg = process.argv.find((a) => a.startsWith("--actor-id="));
  const actorId = actorArg?.split("=")[1];

  const assessment = await assessBulkReleaseCandidates();

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Eligible to release: ${assessment.eligible.length}`);
  for (const row of assessment.eligible) {
    console.log(`  RELEASE  ${row.batchNumber} (${row.id})`);
  }

  console.log(`Skipped: ${assessment.skipped.length}`);
  for (const row of assessment.skipped) {
    console.log(`  SKIP     ${row.batchNumber} — ${row.reason}`);
  }

  if (!apply) {
    console.log("\nNo changes made. Pass --apply to release eligible lots.");
    return;
  }

  if (!actorId) {
    console.error("--apply requires --actor-id=<user uuid> for audit trail.");
    process.exit(1);
  }

  const result = await bulkReleaseQuarantinedBatches(
    {
      id: actorId,
      role: "ADMIN",
      email: "release-script@local",
      employeeId: null,
    },
  );
  console.log(`\nReleased: ${result.releasedCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
