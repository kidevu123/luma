// STATION-KIND-FIX-1 — One-time data correction.
//
// "Blister Hand Pack Station" was created before the HANDPACK_BLISTER
// station kind was added (migration 0044/0045). Its kind was set to BLISTER
// at creation time and was never corrected.
//
// This script idempotently reclassifies it as HANDPACK_BLISTER so the
// floor UI shows the correct timed-only hand-pack workflow instead of
// the machine blister close-out form.
//
// Safe to run multiple times. Exits non-zero only on DB error.
//
// Run in the LXC:
//   npx tsx scripts/fix-station-kind-handpack-blister.ts

import { db } from "../lib/db";
import { stations } from "../lib/db/schema";
import { and, eq } from "drizzle-orm";

async function main() {
  console.log("STATION-KIND-FIX-1: checking Blister Hand Pack Station kind…");

  const [station] = await db
    .select({ id: stations.id, label: stations.label, kind: stations.kind })
    .from(stations)
    .where(eq(stations.label, "Blister Hand Pack Station"))
    .limit(1);

  if (!station) {
    console.log("  Station not found — nothing to do.");
    return;
  }

  console.log(`  Found: id=${station.id}  kind=${station.kind}  label=${station.label}`);

  if (station.kind === "HANDPACK_BLISTER") {
    console.log("  Already HANDPACK_BLISTER — no change needed.");
    return;
  }

  if (station.kind !== "BLISTER") {
    console.error(`  Unexpected kind: ${station.kind}. Manual review required.`);
    process.exit(1);
  }

  const [updated] = await db
    .update(stations)
    .set({ kind: "HANDPACK_BLISTER" })
    .where(and(eq(stations.id, station.id), eq(stations.kind, "BLISTER")))
    .returning({ id: stations.id, label: stations.label, kind: stations.kind });

  if (!updated) {
    console.error("  UPDATE returned no rows — concurrent modification? Re-run to verify.");
    process.exit(1);
  }

  console.log(`  Updated: id=${updated.id}  kind=${updated.kind}  (was BLISTER)`);
  console.log("  Done. Restart the app container to pick up the change.");
}

main().catch((err) => {
  console.error("STATION-KIND-FIX-1 failed:", err);
  process.exit(1);
});
