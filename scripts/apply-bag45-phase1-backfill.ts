#!/usr/bin/env npx tsx
/**
 * P0 — Bag Card 45 Phase 1 apply script (187 shift_end + 18 machine_jam only).
 *
 * Dry-run by default. Apply requires --apply --confirm APPLY_BAG45_PHASE1
 * plus --shift-end-at, --machine-jam-at, and --audit-reason.
 *
 * Usage:
 *   npx tsx scripts/apply-bag45-phase1-backfill.ts
 *   npx tsx scripts/apply-bag45-phase1-backfill.ts \
 *     --shift-end-at 2026-06-01T18:00:00.000Z \
 *     --machine-jam-at 2026-06-01T18:30:00.000Z \
 *     --audit-reason "PM approved Bag 45 phase 1 backfill" \
 *     --apply --confirm APPLY_BAG45_PHASE1
 */

import {
  parseBag45Phase1Cli,
  runBag45Phase1Backfill,
} from "@/lib/ops/bag45-phase1-backfill";

async function main() {
  const opts = parseBag45Phase1Cli(process.argv);
  const result = await runBag45Phase1Backfill(opts);
  if (result.error) {
    console.error(`[bag45-phase1] ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[bag45-phase1] fatal:", err);
  process.exit(1);
});
