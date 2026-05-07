// Phase G — CLI driver for runSubmissionSynthesizer.
//
// Usage:
//   tsx scripts/synthesize-legacy.ts --dry-run   # plan, write nothing
//   tsx scripts/synthesize-legacy.ts             # execute
//
// Idempotent: client_event_id is a UUIDv5 over (kind, ttId), and the
// partial unique index on (workflow_bag_id, event_type, client_event_id)
// rejects duplicates. legacy_tt_id_map records every synthesized
// row so a second run finds them and short-circuits.

import { runSubmissionSynthesizer } from "@/lib/legacy/submission-synthesizer";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log(
    `[synthesize] ${dryRun ? "DRY-RUN — no writes; plan only" : "LIVE — will insert workflow_events + rebuild read models"}`,
  );

  // Synthesizer wants an actor. CLI runs as the system; we inject a
  // system actor. The audit row is skipped in dry-run mode anyway.
  const result = await runSubmissionSynthesizer({
    actor: {
      id: "00000000-0000-0000-0000-000000000000",
      role: "OWNER",
      email: "system@luma",
    },
    dryRun,
  });

  console.log("[synthesize] result:");
  console.log(`  events ${dryRun ? "would be inserted" : "inserted"}: ${result.eventsInserted}`);
  console.log(`  machine_counts processed:                            ${result.machineCountsSynthesized}`);
  console.log(`  warehouse_submissions processed:                      ${result.warehouseSubmissionsSynthesized}`);
  console.log(`  placeholder bags ${dryRun ? "would be created" : "created"}:                   ${result.placeholderBagsCreated}`);
  console.log(`  errors:                                                ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.log("[synthesize] errors:");
    for (const e of result.errors.slice(0, 20)) {
      console.log(`    ${e.source} tt_id=${e.ttId}: ${e.message}`);
    }
    if (result.errors.length > 20) {
      console.log(`    …and ${result.errors.length - 20} more`);
    }
  }
  if (!dryRun && result.readModels) {
    console.log("[synthesize] read-model rebuild:");
    console.log(`  read_bag_state          ${result.readModels.bagStateRows} rows`);
    console.log(`  read_bag_metrics        ${result.readModels.bagMetricsRows} rows`);
    console.log(`  read_daily_throughput   ${result.readModels.dailyThroughputRows} rows`);
    console.log(`  read_operator_daily     ${result.readModels.operatorDailyRows} rows`);
  }
  console.log(`[synthesize] duration: ${result.durationMs}ms`);

  process.exit(result.errors.length > 0 && !dryRun ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
