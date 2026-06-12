/**
 * Backfill a blister bag that was physically run but never recorded.
 *
 * Defaults match bag-card-18 / receipt 1893-26 (2026-06-10).
 *
 *   tsx scripts/apply-missed-blister-bag-backfill.ts
 *   tsx scripts/apply-missed-blister-bag-backfill.ts --apply \
 *     --confirm APPLY_MISSED_BLISTER_BAG_BACKFILL \
 *     --audit-reason "Operator could not record bag on blister PWA"
 */

import {
  formatMissedBlisterBagProposal,
  parseMissedBlisterBagCli,
  runMissedBlisterBagBackfill,
} from "@/lib/ops/missed-blister-bag-backfill";

async function main() {
  const opts = parseMissedBlisterBagCli(process.argv);
  const result = await runMissedBlisterBagBackfill(opts);
  if (result.proposal) {
    console.log(formatMissedBlisterBagProposal(result.proposal, opts.apply ? "APPLY" : "DRY-RUN"));
  }
  if (result.error) {
    console.error("\nBlocked:", result.error);
    process.exit(1);
  }
  if (!opts.apply) {
    console.log("\nNo writes performed (dry-run default).");
  } else if (result.applied) {
    console.log("\nApply complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
