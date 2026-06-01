#!/usr/bin/env npx tsx
/**
 * P0 Phase 2 — Bag 45 PVC-1 mount + Bag 24 645 attribution correction.
 *
 * Dry-run by default. Apply requires:
 *   --apply
 *   --confirm APPLY_BAG45_PHASE2_PVC_TIMELINE
 *   --audit-reason "..."
 *
 * Usage:
 *   npx tsx scripts/apply-bag45-phase2-pvc-timeline.ts
 *   npx tsx scripts/apply-bag45-phase2-pvc-timeline.ts \
 *     --audit-reason "PM approved Bag 45 phase 2 PVC timeline repair" \
 *     --apply --confirm APPLY_BAG45_PHASE2_PVC_TIMELINE
 */

import {
  parseBag45Phase2Cli,
  runBag45Phase2Apply,
} from "@/lib/ops/bag45-phase2-pvc-timeline-apply";

async function main() {
  const opts = parseBag45Phase2Cli(process.argv);
  const result = await runBag45Phase2Apply(opts);
  if (result.error) {
    console.error(`[bag45-phase2] ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[bag45-phase2] fatal:", err);
  process.exit(1);
});
