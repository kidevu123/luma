#!/usr/bin/env npx tsx
// Backfill OPEN raw_bag_allocation_sessions for active workflow runs missing
// source linkage. Dry-run by default — pass --apply --yes to write.

import {
  applySafeActiveAllocationBackfill,
  loadActiveWorkflowBagBackfillReport,
  parseBackfillMissingActiveAllocationsCli,
  summarizeBackfillReport,
  validateBackfillApplyGate,
} from "@/lib/production/backfill-missing-active-allocation";

function rowSummary(row: Awaited<
  ReturnType<typeof loadActiveWorkflowBagBackfillReport>
>[number]) {
  return {
    workflowBagId: row.workflowBagId,
    inventoryBagId: row.inventoryBagId,
    bagQrCode: row.bagQrCode,
    qrCardLabel: row.qrCardLabel,
    internalReceiptNumber: row.internalReceiptNumber,
    tabletTypeName: row.tabletTypeName,
    productName: row.productName,
    stage: row.stage,
    startedAt: row.startedAt?.toISOString() ?? null,
    currentStationLabel: row.currentStationLabel,
    inventoryBagStatus: row.inventoryBagStatus,
    declaredPillCount: row.declaredPillCount,
    pillCount: row.pillCount,
    hasAnyAllocationForWorkflow: row.hasAnyAllocationForWorkflow,
    hasAnyAllocationForInventoryBag: row.hasAnyAllocationForInventoryBag,
    hasOpenAllocationOnOtherWorkflow: row.hasOpenAllocationOnOtherWorkflow,
    openAllocationOtherWorkflowBagId: row.openAllocationOtherWorkflowBagId,
    finishedLotId: row.finishedLotId,
    finishedLotStatus: row.finishedLotStatus,
    isFinalized: row.isFinalized,
    zohoOutputOpId: row.zohoOutputOpId,
    zohoOutputStatus: row.zohoOutputStatus,
    zohoOutputCommitted: row.zohoOutputCommitted,
    proposedAction: row.classification.action,
    proposedReason: row.classification.reason,
    startingBalanceQty: row.classification.startingBalanceQty,
    startingBalanceSource: row.classification.startingBalanceSource,
    missingStartingBalance: row.classification.missingStartingBalance,
  };
}

async function main() {
  const opts = parseBackfillMissingActiveAllocationsCli(process.argv);
  const gate = validateBackfillApplyGate(opts);
  if (!gate.ok) {
    console.error(gate.error);
    process.exit(1);
  }

  const workflowBagIds = opts.workflowBagId ? [opts.workflowBagId] : undefined;
  let rows = await loadActiveWorkflowBagBackfillReport(workflowBagIds);
  if (opts.limit != null && opts.limit > 0) {
    rows = rows.slice(0, opts.limit);
  }

  const summary = summarizeBackfillReport(rows);
  const proposed = rows.map(rowSummary);

  if (!opts.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          ...summary,
          skippedByAction: summary.skippedByAction,
          rows: proposed,
        },
        null,
        2,
      ),
    );
    return;
  }

  const safeIds = rows
    .filter((r) => r.classification.action === "SAFE_OPEN_ALLOCATION")
    .map((r) => r.workflowBagId);

  const applyResult = await applySafeActiveAllocationBackfill({
    workflowBagIds: safeIds.length > 0 ? safeIds : undefined,
    limit: opts.limit ?? undefined,
  });

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        dryRunSummary: summary,
        repairedCount: applyResult.repaired.length,
        repaired: applyResult.repaired,
        skipped: applyResult.skipped,
        errors: applyResult.errors,
        sessionIds: applyResult.repaired.map((r) => r.sessionId),
      },
      null,
      2,
    ),
  );

  if (applyResult.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
