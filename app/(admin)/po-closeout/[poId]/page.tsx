import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, X, Minus } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guards";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { purchaseOrders } from "@/lib/db/schema";
import { loadPoCloseout, type PoCloseoutRow } from "@/lib/db/queries/po-closeout";
import { loadBagProductionSummaries } from "@/lib/db/queries/bag-production-summary";
import type { BagProductionSummary } from "@/lib/production/bag-production-summary";
import { BagProductionSummaryInline } from "@/components/admin/bag-production-summary-inline";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { RowStatusBadge, OverallStatusBadge } from "../status-badge";
import { PoBatchButtons } from "../batch-buttons";
import { AutoRefreshOnFocus } from "@/components/admin/auto-refresh-on-focus";
import { formatDateTimeEst } from "@/lib/ui/luma-display";

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

function rowLink(row: PoCloseoutRow): { href: string; label: string } | null {
  switch (row.action) {
    case "REPAIR_QR_RESERVATION":
      return row.receiveId ? { href: `/inbound/${row.receiveId}`, label: "Open receive" } : null;
    case "START_OR_FINALIZE_WORKFLOW":
      return { href: "/workflow-submissions", label: "Open workflows" };
    case "CORRECT_STARTING_BALANCE":
    case "RECORD_REMAINING_OR_CLOSE_PARTIAL":
      return { href: "/partial-bags", label: "Partial Bag Workbench" };
    case "AUTO_ISSUE_FINISHED_LOT":
      return { href: "/packaging-output", label: "Production output" };
    case "AUTO_RELEASE_FINISHED_LOT":
    case "REVIEW_QC_HOLD":
      return row.finishedLotId ? { href: `/finished-lots/${row.finishedLotId}`, label: "Open lot" } : { href: "/finished-lots", label: "Finished lots" };
    case "QUEUE_OR_RETRY_ZOHO":
      return { href: "/zoho-production-operations", label: "Zoho output" };
    case "FIX_PRODUCT_SETUP":
      return { href: "/workflow-submissions", label: "Review" };
    default:
      return row.receiveId ? { href: `/inbound/${row.receiveId}`, label: "Open receive" } : null;
  }
}

const ZOHO_LABEL: Record<string, string> = {
  COMMITTED: "Committed",
  QUEUED: "Queued",
  READY_TO_QUEUE: "Ready to queue",
  NOT_READY: "Not ready",
  FAILED: "Failed",
  NOT_APPLICABLE: "Not required",
  UNCLEAR: "Unclear",
};

function Tick({ ok, label }: { ok: boolean | null; label: string }) {
  const Icon = ok === null ? Minus : ok ? Check : X;
  const cls = ok === null ? "text-text-subtle" : ok ? "text-green-600" : "text-amber-600";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] ${cls}`} title={label}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

export default async function PoCloseoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ poId: string }>;
  searchParams: Promise<{ filter?: string; show?: string }>;
}) {
  await requireAdmin();
  const { poId } = await params;
  const { filter: rawFilter, show: rawShow } = await searchParams;
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

  return (
    <div className="space-y-5">
      <AutoRefreshOnFocus />
      <div>
        <Link href="/po-closeout" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2">
          <ArrowLeft className="h-3 w-3" /> All POs
        </Link>
        <PageHeader
          title={`PO ${summary.poNumber} — closeout`}
          description={summary.vendorName ?? "Closeout command center"}
          actions={<OverallStatusBadge status={summary.overallStatus} />}
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

      {/* Rows */}
      <DataTable>
        <THead>
          <TR>
            <TH>Bag / receipt</TH>
            <TH>Flavor</TH>
            <TH>Production</TH>
            <TH>Status</TH>
            <TH>What&apos;s next</TH>
            <TH>Checklist</TH>
            <TH>{" "}</TH>
          </TR>
        </THead>
        <tbody>
          {shown.length === 0 ? (
            <TR>
              <TD className="text-sm text-text-muted">No bags in this filter.</TD>
            </TR>
          ) : (
            shown.map((row) => {
              const link = rowLink(row);
              return (
                <TR key={row.inventoryBagId}>
                  <TD>
                    <div className="font-mono text-xs font-semibold">{row.receiptNumber ?? "—"}</div>
                    <div className="text-[10px] text-text-subtle">Bag {row.bagNumber ?? "?"} · {row.bagQrCode ?? "no QR"}</div>
                  </TD>
                  <TD className="text-xs">{row.tabletName ?? "—"}</TD>
                  <TD>
                    {productionByBag.get(row.inventoryBagId) ? (
                      <BagProductionSummaryInline
                        summary={productionByBag.get(row.inventoryBagId)!}
                        variant="row"
                      />
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </TD>
                  <TD><RowStatusBadge status={row.status} /></TD>
                  <TD>
                    <div className="text-xs font-medium text-text-strong">{row.actionLabel}</div>
                    <div className="text-[10px] text-text-muted">{row.reason}</div>
                  </TD>
                  <TD>
                    <div className="flex flex-col gap-0.5">
                      <Tick ok={row.checklist.received} label="Received" />
                      <Tick ok={row.checklist.floorFinalizedOrExcluded} label="Finalized" />
                      <Tick ok={row.checklist.finishedLotIssued} label="Lot issued" />
                      <Tick ok={row.checklist.finishedLotReleasedOrHeld} label="Released/held" />
                      <Tick
                        ok={row.checklist.zohoQueuedOrCommittedOrNa}
                        label={`Zoho: ${ZOHO_LABEL[row.zoho] ?? row.zoho}`}
                      />
                    </div>
                  </TD>
                  <TD className="text-right">
                    {link ? (
                      <Link href={link.href} className="text-xs font-medium text-brand-700 hover:underline whitespace-nowrap">
                        {link.label}
                      </Link>
                    ) : null}
                  </TD>
                </TR>
              );
            })
          )}
        </tbody>
      </DataTable>
    </div>
  );
}
