// P1-PARTIAL — Partial Bag Workbench (replaces "Available Partial Bags").
//
// Partial bags are part of the production ledger, not a side feature.
// The workbench splits bags into explicit lifecycle sections so a
// "needs closeout" row can never be mistaken for reusable inventory:
//   1. Active runs missing source allocation (lead repair surface).
//   2. Ready to reuse        — trusted remaining qty; can start a run.
//   3. Needs closeout        — partial use, no reliable ending balance.
//   4. Missing linkage       — packaging evidence, no allocation ledger.
//   5. On hold / quarantined — blocked until QA review (incl. void).
//   6. Recently depleted     — emptied in the last 14 days (reference).

import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guards";
import { AutoRefreshOnFocus } from "@/components/admin/auto-refresh-on-focus";
import {
  loadActiveRunsMissingAllocation,
  loadHeldAndDepletedPartialBags,
  loadHeldFinalizedPartialBottleBags,
  loadPartialBagAdminRows,
  type PartialBagAdminRow,
} from "@/lib/production/partial-bags";
import { derivePartialBagAttention } from "@/lib/production/partial-bag-attention";
import {
  computeSystemDerivedResolutionForBag,
  type SystemDerivedResolution,
} from "@/lib/production/system-derived-allocation-resolution";
import { labelSystemDerivedStage } from "@/lib/production/system-derived-allocation";
import { UseCalculatedRemainingButton } from "./use-calculated-remaining-button";
import {
  labelPartialBagConfidence,
  labelPartialBagEndingBalanceSource,
} from "@/lib/production/partial-bag-resolution-constants";
import { formatRemainingEstimate } from "@/lib/production/partial-bag-lifecycle";
import { loadBagProductionSummaries } from "@/lib/db/queries/bag-production-summary";
import type { BagProductionSummary } from "@/lib/production/bag-production-summary";
import { BagProductionSummaryInline } from "@/components/admin/bag-production-summary-inline";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { PartialBagCorrectionMenu } from "./correction-menu";
import { BackfillSafeAllocationsButton } from "./backfill-allocations-button";

export const dynamic = "force-dynamic";

export const metadata = { title: "Partial Bag Workbench" };

function SectionTable({
  rows,
  variant,
  systemDerived,
  productionSummaries,
}: {
  rows: PartialBagAdminRow[];
  variant: "ready" | "needs_closeout" | "missing_linkage";
  /** Per-bag system-derived resolution (from production output), keyed by bagId. */
  systemDerived?: Map<string, SystemDerivedResolution>;
  /** BAG-PRODUCTION-SUMMARY-1 — read-only per-bag breakdown, keyed by bagId. */
  productionSummaries?: Map<string, BagProductionSummary>;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-text-muted italic">
        {variant === "ready"
          ? "No partial bags are ready to reuse."
          : variant === "needs_closeout"
            ? "No bags awaiting closeout."
            : "No bags with missing linkage."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
          <tr>
            <th className="text-left py-2 pr-3">QR token</th>
            <th className="text-left py-2 pr-3">Receipt #</th>
            <th className="text-left py-2 pr-3">Supplier lot</th>
            <th className="text-left py-2 pr-3">Tablet type</th>
            <th className="text-right py-2 pr-3">Declared</th>
            <th className="text-right py-2 pr-3">Last consumed</th>
            <th className="text-left py-2 pr-3">Remaining</th>
            <th className="text-left py-2 pr-3">Last product / run</th>
            <th className="text-left py-2 pr-3">Action needed</th>
            <th className="text-left py-2">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((row) => {
            const remainingText = formatRemainingEstimate({
              remainingEstimate: row.remainingEstimate,
              confidence: row.remainingConfidence,
              source: row.remainingSource,
            });
            const sourceLabel = labelPartialBagEndingBalanceSource(
              row.remainingSource,
            );
            const confidenceLabel = labelPartialBagConfidence(
              row.remainingConfidence,
            );
            const receiptLabel =
              row.internalReceiptNumber ??
              (row.receiveId ? row.receiveId.slice(0, 8) : "—");
            return (
              <tr
                key={`${row.bagId}-${row.eligibility}`}
                className="hover:bg-surface-2 transition-colors"
              >
                <td className="py-2 pr-3 font-mono text-[11px] text-text-strong align-top">
                  {row.bagQrCode ?? "—"}
                </td>
                <td className="py-2 pr-3 align-top">
                  {row.receiveId ? (
                    <Link
                      href={`/inbound/${row.receiveId}`}
                      className="underline underline-offset-2 hover:text-brand-700"
                    >
                      {receiptLabel}
                    </Link>
                  ) : (
                    receiptLabel
                  )}
                </td>
                <td className="py-2 pr-3 font-mono text-[11px] align-top">
                  {row.supplierLot ?? "—"}
                </td>
                <td className="py-2 pr-3 align-top">{row.tabletTypeName ?? "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums align-top">
                  {row.declaredPillCount != null
                    ? row.declaredPillCount.toLocaleString()
                    : "—"}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums align-top">
                  {row.lastConsumedQty != null
                    ? row.lastConsumedQty.toLocaleString()
                    : "—"}
                </td>
                <td className="py-2 pr-3 align-top">
                  <span
                    className={
                      row.remainingEstimate == null
                        ? "text-amber-700 font-medium"
                        : row.remainingConfidence === "HIGH"
                          ? "tabular-nums"
                          : "tabular-nums text-text-strong"
                    }
                  >
                    {remainingText}
                  </span>
                  {row.remainingEstimate != null && confidenceLabel ? (
                    <p
                      className={`mt-0.5 text-[10px] ${
                        row.remainingConfidence === "LOW"
                          ? "text-amber-700 font-medium"
                          : "text-text-muted"
                      }`}
                    >
                      {confidenceLabel}
                      {sourceLabel ? ` · ${sourceLabel}` : ""}
                    </p>
                  ) : null}
                  {/* Operator-entered estimate — shown separately from the
                      system-calculated remaining above, never merged. If the
                      two disagree, both are visible so the discrepancy is
                      obvious rather than silently overwritten. */}
                  {row.operatorRemainingEstimate != null ? (
                    <p
                      className={`mt-0.5 text-[10px] ${
                        row.remainingEstimate != null &&
                        row.operatorRemainingEstimate !== row.remainingEstimate
                          ? "text-amber-700 font-medium"
                          : "text-text-muted"
                      }`}
                      title="Operator's guess at run close — not an inventory count."
                    >
                      Operator est. ~
                      {row.operatorRemainingEstimate.toLocaleString()}
                      {row.remainingEstimate != null &&
                      row.operatorRemainingEstimate !== row.remainingEstimate
                        ? " · differs from system"
                        : ""}
                    </p>
                  ) : null}
                </td>
                <td className="py-2 pr-3 align-top">
                  <div>{row.lastUsedProductName ?? "—"}</div>
                  <div className="text-[10px] text-text-muted">
                    {row.lastUsedAt
                      ? row.lastUsedAt.toLocaleDateString("en-CA")
                      : ""}
                    {row.activeWorkflowBagId ? (
                      <span className="font-mono">
                        {" "}
                        · run {row.activeWorkflowBagId.slice(0, 8)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="py-2 pr-3 align-top max-w-[16rem]">
                  <p className="text-[10.5px] text-text-muted leading-snug">
                    {row.eligibilityNote}
                  </p>
                  {variant === "needs_closeout" ? (
                    <p className="mt-1 rounded border border-amber-200 bg-amber-50/70 px-1.5 py-1 text-[10px] font-medium leading-snug text-amber-800">
                      Open allocation session — close it here to reuse this bag:
                      Use calculated remaining, Correct remaining (manual count),
                      or Mark depleted. No floor step needed.
                    </p>
                  ) : null}
                  {(() => {
                    const sd = systemDerived?.get(row.bagId);
                    if (!sd) return null;
                    if (sd.available) {
                      return (
                        <div className="mt-1 rounded border border-emerald-200 bg-emerald-50/60 px-1.5 py-1 text-[10px] leading-snug text-emerald-900">
                          <p className="font-semibold">Calculated remaining available</p>
                          <p className="tabular-nums">
                            {sd.startingTabletCount.toLocaleString()} start −{" "}
                            {sd.derivedConsumedTablets.toLocaleString()} consumed ={" "}
                            <span className="font-semibold">
                              {sd.derivedRemainingTablets.toLocaleString()} remaining
                            </span>
                          </p>
                          <p className="text-emerald-700/80">
                            System-derived from {labelSystemDerivedStage(sd.outputStage)} — not a physical count.
                          </p>
                        </div>
                      );
                    }
                    return (
                      <p className="mt-1 text-[10px] leading-snug text-amber-700">
                        Calculated remaining unavailable: {sd.message}
                      </p>
                    );
                  })()}
                  {productionSummaries?.get(row.bagId) ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] font-medium text-brand-700 hover:underline">
                        Production summary
                      </summary>
                      <div className="mt-1">
                        <BagProductionSummaryInline
                          summary={productionSummaries.get(row.bagId)!}
                          variant="panel"
                        />
                      </div>
                    </details>
                  ) : null}
                </td>
                <td className="py-2 align-top">
                  <div className="flex flex-col gap-1.5">
                    {variant === "ready" ? (
                      <Link
                        href={`/production/start?inventoryBagId=${row.bagId}`}
                        className="inline-flex w-fit items-center px-2 py-1 rounded border border-brand-300 bg-brand-50 text-brand-700 text-[11px] font-medium hover:bg-brand-100 transition-colors"
                      >
                        Start run
                      </Link>
                    ) : (
                      <>
                        {(() => {
                          const sd = systemDerived?.get(row.bagId);
                          return sd?.available ? (
                            <UseCalculatedRemainingButton
                              inventoryBagId={row.bagId}
                              remaining={sd.derivedRemainingTablets}
                            />
                          ) : null;
                        })()}
                        <Link
                          href={`/partial-bags/${row.bagId}/resolve`}
                          className="inline-flex w-fit items-center px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[11px] font-medium hover:bg-amber-100 transition-colors"
                        >
                          {variant === "missing_linkage"
                            ? "Resolve inventory"
                            : "Record closeout"}
                        </Link>
                      </>
                    )}
                    <PartialBagCorrectionMenu
                      inventoryBagId={row.bagId}
                      inventoryStatus={row.inventoryStatus}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function PartialBagWorkbenchPage() {
  await requireAdmin();
  const [rows, missingAllocationRuns, heldAndDepleted, heldFinalized] =
    await Promise.all([
      loadPartialBagAdminRows(),
      loadActiveRunsMissingAllocation(),
      loadHeldAndDepletedPartialBags(),
      loadHeldFinalizedPartialBottleBags(),
    ]);
  // BAG-PRODUCTION-SUMMARY-1 — read-only expected-vs-recorded remaining
  // context for every bag on the workbench.
  const productionSummaries = await loadBagProductionSummaries({
    inventoryBagIds: rows.map((r) => r.bagId),
  });

  const ready = rows.filter((r) => r.eligibility === "ready");
  const needsCloseout = rows.filter(
    (r) => r.eligibility === "needs_allocation_closeout",
  );
  const missingLinkage = rows.filter((r) => r.eligibility === "missing_linkage");
  const { held, depleted } = heldAndDepleted;

  // SPLIT-BAG-1 — for bags that need closeout/linkage, check whether their OPEN
  // allocation can be resolved from production output (one-click instead of a
  // manual count). Bounded to the (small) blocked set, one query each.
  // Defensive: a single bag's resolution failing (legacy/malformed data, a bad
  // query) must NOT crash the whole workbench — it degrades to "Calculation
  // unavailable" for that row while every other row still renders.
  const systemDerived = new Map<string, SystemDerivedResolution>();
  await Promise.all(
    [...needsCloseout, ...missingLinkage].map(async (r) => {
      try {
        systemDerived.set(r.bagId, await computeSystemDerivedResolutionForBag(r.bagId));
      } catch {
        systemDerived.set(r.bagId, {
          available: false,
          sessionId: null,
          workflowBagId: null,
          previousProductName: null,
          reason: "COMPUTE_FAILED",
          message: "Calculation unavailable for this bag.",
        });
      }
    }),
  );

  return (
    <div className="space-y-5">
      <AutoRefreshOnFocus />
      <PageHeader
        title="Partial Bag Workbench"
        description="Every partially used raw bag, split by lifecycle state. Only 'Ready to reuse' rows are valid inventory — needs-closeout and missing-linkage rows are blocked from new runs until resolved."
      />

      {/* 1 · Active runs missing source allocation */}
      {missingAllocationRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-amber-800">
              {missingAllocationRuns.length} active run
              {missingAllocationRuns.length === 1 ? "" : "s"} missing source
              allocation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BackfillSafeAllocationsButton />
            <p className="text-xs text-text-muted mb-3">
              These in-flight runs have no allocation session on their raw bag,
              so consumption is not landing on the ledger. A lead can repair
              each one from the station screen (yellow warning → Repair
              allocation), bulk-backfill safe rows above, or force closeout at
              run end.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">Bag QR</th>
                    <th className="text-left py-2 pr-3">Receipt #</th>
                    <th className="text-left py-2 pr-3">Tablet type</th>
                    <th className="text-left py-2 pr-3">Product</th>
                    <th className="text-left py-2 pr-3">Stage</th>
                    <th className="text-left py-2">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {missingAllocationRuns.map((run) => (
                    <tr key={run.workflowBagId}>
                      <td className="py-2 pr-3 font-mono text-[11px]">
                        {run.bagQrCode ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {run.internalReceiptNumber ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{run.tabletTypeName ?? "—"}</td>
                      <td className="py-2 pr-3">{run.productName ?? "—"}</td>
                      <td className="py-2 pr-3">{run.stage ?? "—"}</td>
                      <td className="py-2">
                        {run.startedAt
                          ? run.startedAt.toLocaleDateString("en-CA")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 1b · Held finalized partial bottle bags (QR-keyed) — these can be
          invisible to the allocation-session sections below, so they are
          surfaced from the QR card itself. */}
      {heldFinalized.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-amber-800">
              Held finalized partial bottle bags ({heldFinalized.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-text-muted mb-3">
              These bottle runs finished but the QR is still kept on the
              physical bag for reuse. Healthy held partials need no action; rows
              flagged <span className="font-semibold text-red-700">Needs
              review</span> have an unknown or disputed remaining count —
              confirm the bag before the next run.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">QR card</th>
                    <th className="text-left py-2 pr-3">Last run product</th>
                    <th className="text-right py-2 pr-3">System remaining</th>
                    <th className="text-right py-2 pr-3">Operator est.</th>
                    <th className="text-left py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {heldFinalized.map((row) => {
                    const attention = derivePartialBagAttention({
                      isHeldPartial: true,
                      systemRemainingQty: row.systemRemainingQty,
                      operatorRemainingEstimate: row.operatorRemainingEstimate,
                    });
                    return (
                      <tr key={row.cardId}>
                        <td className="py-2 pr-3 font-mono text-[11px] text-text-strong">
                          {row.cardLabel}
                        </td>
                        <td className="py-2 pr-3">
                          {row.lastProductName ?? "—"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {row.systemRemainingQty != null
                            ? row.systemRemainingQty.toLocaleString()
                            : "unknown"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {row.operatorRemainingEstimate != null
                            ? `~${row.operatorRemainingEstimate.toLocaleString()}`
                            : "—"}
                        </td>
                        <td className="py-2">
                          {attention.needsReview ? (
                            <span
                              className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800 ring-1 ring-red-300"
                              title={attention.reason ?? undefined}
                            >
                              Needs review
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                              Held · reusable
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2 · Ready to reuse */}
      <Card>
        <CardHeader>
          <CardTitle className="text-emerald-800">
            Ready to reuse ({ready.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SectionTable rows={ready} variant="ready" productionSummaries={productionSummaries} />
        </CardContent>
      </Card>

      {/* 3 · Needs closeout */}
      <Card>
        <CardHeader>
          <CardTitle className="text-amber-800">
            Needs closeout ({needsCloseout.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-text-muted mb-2">
            Partial use indicated but no reliable ending balance. These are NOT
            reusable inventory until the remaining count is recorded.
          </p>
          <SectionTable rows={needsCloseout} variant="needs_closeout" systemDerived={systemDerived} productionSummaries={productionSummaries} />
        </CardContent>
      </Card>

      {/* 4 · Missing linkage */}
      <Card>
        <CardHeader>
          <CardTitle>Missing linkage ({missingLinkage.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-text-muted mb-2">
            Packaging evidence exists but no allocation ledger links the bag to
            its run. Resolve to reconstruct the ledger before reuse.
          </p>
          <SectionTable rows={missingLinkage} variant="missing_linkage" systemDerived={systemDerived} productionSummaries={productionSummaries} />
        </CardContent>
      </Card>

      {/* 5 · On hold / quarantined / void */}
      <Card>
        <CardHeader>
          <CardTitle className="text-red-800">
            On hold / quarantined ({held.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {held.length === 0 ? (
            <p className="py-4 text-center text-sm text-text-muted italic">
              No bags on hold.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">QR token</th>
                    <th className="text-left py-2 pr-3">Receipt #</th>
                    <th className="text-left py-2 pr-3">Supplier lot</th>
                    <th className="text-left py-2 pr-3">Tablet type</th>
                    <th className="text-left py-2 pr-3">Last note</th>
                    <th className="text-left py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {held.map((row) => (
                    <tr key={row.bagId}>
                      <td className="py-2 pr-3">
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                            row.inventoryStatus === "VOID"
                              ? "bg-surface-2 text-text-muted border-border"
                              : "bg-red-50 text-red-800 border-red-200"
                          }`}
                        >
                          {row.inventoryStatus === "VOID"
                            ? "Void / bad linkage"
                            : "On hold"}
                        </span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px]">
                        {row.bagQrCode ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.internalReceiptNumber ?? "—"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px]">
                        {row.supplierLot ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{row.tabletTypeName ?? "—"}</td>
                      <td className="py-2 pr-3 max-w-[18rem] text-[10.5px] text-text-muted">
                        {row.lastNote ?? "—"}
                      </td>
                      <td className="py-2">
                        <PartialBagCorrectionMenu
                          inventoryBagId={row.bagId}
                          inventoryStatus={row.inventoryStatus}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 6 · Recently depleted (reference only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-text-muted">
            Recently depleted — last 14 days ({depleted.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {depleted.length === 0 ? (
            <p className="py-4 text-center text-sm text-text-muted italic">
              No bags depleted in the last 14 days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase text-[10px] tracking-wide border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">QR token</th>
                    <th className="text-left py-2 pr-3">Receipt #</th>
                    <th className="text-left py-2 pr-3">Tablet type</th>
                    <th className="text-left py-2">Depleted at</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {depleted.map((row) => (
                    <tr key={row.bagId}>
                      <td className="py-2 pr-3 font-mono text-[11px]">
                        {row.bagQrCode ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.internalReceiptNumber ?? "—"}
                      </td>
                      <td className="py-2 pr-3">{row.tabletTypeName ?? "—"}</td>
                      <td className="py-2">
                        {row.lastClosedAt
                          ? row.lastClosedAt.toLocaleDateString("en-CA")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
