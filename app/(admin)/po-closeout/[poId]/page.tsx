import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { loadPoCloseout, type PoCloseoutRow } from "@/lib/db/queries/po-closeout";
import { loadBagProductionSummaries } from "@/lib/db/queries/bag-production-summary";
import type { BagProductionSummary } from "@/lib/production/bag-production-summary";
import { PageHeader } from "@/components/ui/page-header";
import { OverallStatusBadge } from "../status-badge";
import { PoBatchButtons } from "../batch-buttons";
import { AutoRefreshOnFocus } from "@/components/admin/auto-refresh-on-focus";
import { formatDateTimeEst } from "@/lib/ui/luma-display";
import { CloseoutRows } from "../_drawer/closeout-rows";
import { GuidedOverlay, type GuidedBagStep } from "../_guided/guided-overlay";
import { deriveGuidedCloseoutQueue } from "@/lib/production/guided-closeout";

export const dynamic = "force-dynamic";
// CLOSEOUT-FRESHNESS-1 — operational page: never statically cached.
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ poId: string }>;
}) {
  // Cheap title lookup — never runs the full closeout loader twice.
  const { poId } = await params;
  const [po] = await db
    .select({ poNumber: purchaseOrders.poNumber })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  return { title: po ? `PO Closeout ${po.poNumber}` : "PO Closeout" };
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready actions" },
  { key: "review", label: "Needs review" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matchesFilter(row: PoCloseoutRow, filter: FilterKey): boolean {
  switch (filter) {
    case "ready": return row.status === "READY_FOR_ACTION";
    case "review": return row.status === "NEEDS_REVIEW";
    case "blocked": return row.status === "BLOCKED";
    case "done": return row.status === "DONE";
    default: return true;
  }
}

// BAG-PRODUCTION-SUMMARY-1 — read-only production-data filters. These
// compose with the status filter above and never touch verdict logic.
const SHOW_FILTERS = [
  { key: "any", label: "All production states" },
  { key: "has-production", label: "Has production" },
  { key: "no-production", label: "No production yet" },
  { key: "partial", label: "Partial / split" },
  { key: "multi-run", label: "Multiple runs" },
  { key: "over-consumed", label: "Over-consumed" },
  { key: "awaiting-lot", label: "Awaiting lot" },
  { key: "zoho-blocked", label: "Zoho blocked" },
] as const;
type ShowKey = (typeof SHOW_FILTERS)[number]["key"];

function matchesShowFilter(
  summary: BagProductionSummary | undefined,
  row: PoCloseoutRow,
  show: ShowKey,
): boolean {
  if (show === "any") return true;
  switch (show) {
    case "has-production":
      return (summary?.producedTablets ?? 0) > 0 || summary?.flags.consumptionUnknown === true;
    case "no-production":
      return summary != null && summary.producedTablets === 0;
    case "partial":
      return summary?.flags.partialRemaining === true || summary?.flags.splitBag === true;
    case "multi-run":
      return summary?.flags.multipleWorkflows === true;
    case "over-consumed":
      return summary?.flags.overConsumed === true;
    case "awaiting-lot":
      return summary?.workflow?.finalized === true && summary.finishedLot == null;
    case "zoho-blocked":
      return row.zoho === "FAILED" || row.zoho === "NOT_READY" || summary?.zoho.status === "NEEDS_MAPPING";
    default:
      return true;
  }
}

export default async function PoCloseoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ poId: string }>;
  searchParams: Promise<{ filter?: string; show?: string; guided?: string; step?: string }>;
}) {
  await requireAdmin();
  const { poId } = await params;
  const { filter: rawFilter, show: rawShow, guided: rawGuided, step: rawStep } = await searchParams;
  const filter = (FILTERS.find((f) => f.key === rawFilter)?.key ?? "all") as FilterKey;
  const show = (SHOW_FILTERS.find((f) => f.key === rawShow)?.key ?? "any") as ShowKey;

  const summary = await loadPoCloseout(poId);
  if (!summary) notFound();

  // Per-bag Received / Produced / Remaining breakdown (read-only).
  const productionByBag = await loadBagProductionSummaries({ poId });

  const c = summary.counts;
  const shown = summary.rows.filter(
    (r) =>
      matchesFilter(r, filter) &&
      matchesShowFilter(productionByBag.get(r.inventoryBagId), r, show),
  );
  const issueReady = summary.rows.filter((r) => r.action === "AUTO_ISSUE_FINISHED_LOT" && r.status === "READY_FOR_ACTION").length;
  const releaseReady = summary.rows.filter((r) => r.action === "AUTO_RELEASE_FINISHED_LOT" && r.status === "READY_FOR_ACTION").length;

  // GUIDED-CLOSEOUT-1 — ?guided=1&step=n renders the "Close this PO"
  // overlay. The queue derives from the live rows on THIS render, so every
  // step advance (a plain navigation) recomputes it — never snapshotted.
  const guided = rawGuided === "1";
  const parsedStep = Number.parseInt(rawStep ?? "0", 10);
  const guidedStep = Number.isFinite(parsedStep) && parsedStep >= 0 ? parsedStep : 0;
  const guidedQueue = deriveGuidedCloseoutQueue(summary.rows);
  const hasSafeBatch = issueReady + releaseReady > 0;
  const guidedTotalSteps = guidedQueue.length + (hasSafeBatch ? 1 : 0);
  const bagIndex = guidedStep - (hasSafeBatch ? 1 : 0);
  const currentGuidedStep = guided && bagIndex >= 0 && bagIndex < guidedQueue.length
    ? guidedQueue[bagIndex]
    : null;
  const currentGuidedRow = currentGuidedStep
    ? summary.rows.find((r) => r.inventoryBagId === currentGuidedStep.inventoryBagId) ?? null
    : null;
  const guidedBagStep: GuidedBagStep | null =
    currentGuidedStep && currentGuidedRow
      ? {
          ...currentGuidedStep,
          rowFacts: {
            status: currentGuidedRow.status,
            action: currentGuidedRow.action,
            zoho: currentGuidedRow.zoho,
            workflowBagId: currentGuidedRow.workflowBagId,
            finishedLotId: currentGuidedRow.finishedLotId,
            lotStatus: currentGuidedRow.lotStatus,
            receiveId: currentGuidedRow.receiveId,
          },
        }
      : null;
  const guidedFinish =
    guided && guidedStep >= guidedTotalSteps
      ? {
          done: c.done,
          readyForAction: c.readyForAction,
          needsReview: c.needsReview,
          blocked: c.blocked,
          topBlockers: summary.topBlockers,
        }
      : null;

  return (
    <div className="space-y-5">
      <AutoRefreshOnFocus />
      {guided ? (
        <GuidedOverlay
          poId={poId}
          poNumber={summary.poNumber}
          step={guidedStep}
          totalSteps={guidedTotalSteps}
          hasSafeBatch={hasSafeBatch}
          issueReady={issueReady}
          releaseReady={releaseReady}
          bagStep={guidedBagStep}
          finish={guidedFinish}
        />
      ) : null}
      <div>
        <Link href="/po-closeout" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2">
          <ArrowLeft className="h-3 w-3" /> All POs
        </Link>
        <PageHeader
          title={`PO ${summary.poNumber} — closeout`}
          description={summary.vendorName ?? "Closeout command center"}
          actions={
            <div className="flex items-center gap-2">
              {guidedTotalSteps > 0 ? (
                <Link
                  href={`/po-closeout/${poId}?guided=1&step=0`}
                  className="rounded bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-800"
                >
                  Close this PO ({guidedTotalSteps} step{guidedTotalSteps === 1 ? "" : "s"})
                </Link>
              ) : null}
              <OverallStatusBadge status={summary.overallStatus} />
            </div>
          }
        />
        <p className="mt-1 text-[10px] text-text-subtle">
          Data as of {formatDateTimeEst(summary.evaluatedAt.toISOString())} —
          reloads automatically when you return to this tab.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {[
          { label: "Bags", value: c.total, tone: "text-text-strong" },
          { label: "Done", value: c.done, tone: "text-green-700" },
          { label: "Ready for action", value: c.readyForAction, tone: "text-brand-700" },
          { label: "Needs review", value: c.needsReview, tone: "text-amber-700" },
          { label: "Blocked", value: c.blocked, tone: "text-red-700" },
          { label: "Lots issued", value: c.lotsIssued, tone: "text-text-strong" },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">{card.label}</p>
            <p className={`text-xl font-mono tabular-nums ${card.tone}`}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* Zoho + release rollup */}
      <div className="rounded-xl border border-border bg-surface-2/40 px-4 py-3 text-[11px] text-text-muted space-y-1">
        <p>
          <span className="font-medium text-text-strong">Finalized</span> means floor work is complete.{" "}
          <span className="font-medium text-text-strong">Finished lot issued</span> means output was converted into inventory.{" "}
          <span className="font-medium text-text-strong">Released</span> means QC approved internally.{" "}
          <span className="font-medium text-text-strong">Done</span> means no manual Luma action remains for this bag.
        </p>
        <p>
          <span className="font-medium text-text-strong">Ready to queue</span> means an admin still needs to queue the Zoho
          output. <span className="font-medium text-text-strong">Zoho queued</span> means it&apos;s ready for the worker.{" "}
          <span className="font-medium text-text-strong">Zoho committed</span> means it was sent to Zoho.{" "}
          {summary.zohoRequired
            ? "Zoho output is required for released lots here, so a released lot without a queued/committed op is not done."
            : "Zoho output is currently disabled, so it is not required for done."}{" "}
          Zoho output is never queued or committed from this page.
        </p>
        <p>
          Released lots: <span className="font-medium text-text-strong">{c.released}</span> · Zoho committed:{" "}
          <span className="font-medium text-green-700">{c.zohoCommitted}</span> · queued:{" "}
          <span className="font-medium">{c.zohoQueued}</span> · ready to queue:{" "}
          <span className="font-medium text-brand-700">{c.zohoReadyToQueue}</span> · failed:{" "}
          <span className="font-medium text-red-700">{c.zohoFailed}</span>.
        </p>
      </div>

      {/* Bulk safe actions */}
      {(issueReady > 0 || releaseReady > 0) && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] text-text-muted mb-2">Safe PO-scoped actions (each re-checks eligibility per row; nothing is committed to Zoho):</p>
          <PoBatchButtons poId={poId} issueReady={issueReady} releaseReady={releaseReady} />
        </div>
      )}

      {/* Top blockers */}
      {summary.topBlockers.length > 0 && (
        <div className="rounded-lg border border-amber-300/40 bg-amber-50/40 px-4 py-2">
          <p className="text-[10px] uppercase tracking-wider text-amber-700 font-medium mb-1">Top open reasons</p>
          <ul className="text-[11px] text-amber-900 space-y-0.5">
            {summary.topBlockers.map((b) => (
              <li key={b.reason}>{b.count}× {b.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const count =
            f.key === "all" ? c.total :
            f.key === "ready" ? c.readyForAction :
            f.key === "review" ? c.needsReview :
            f.key === "blocked" ? c.blocked : c.done;
          const active = f.key === filter;
          return (
            <Link
              key={f.key}
              href={`/po-closeout/${poId}?filter=${f.key}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active ? "border-brand-500 bg-brand-50 text-brand-800" : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {f.label} ({count})
            </Link>
          );
        })}
      </div>

      {/* Production-data filters (read-only view filters) */}
      <div className="flex flex-wrap gap-1.5">
        {SHOW_FILTERS.map((f) => {
          const active = f.key === show;
          return (
            <Link
              key={f.key}
              href={`/po-closeout/${poId}?filter=${filter}&show=${f.key}`}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                active ? "border-brand-500 bg-brand-50 text-brand-800 font-medium" : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {/* Rows — CLOSEOUT-DRAWER-1: each row expands into the bag drawer
          (verify-in-place + act-in-place). */}
      <CloseoutRows
        poId={poId}
        rows={shown.map((row) => ({
          ...row,
          productionSummary: productionByBag.get(row.inventoryBagId) ?? null,
        }))}
      />
    </div>
  );
}
