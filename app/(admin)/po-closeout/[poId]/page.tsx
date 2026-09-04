import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowUp, ArrowDown } from "lucide-react";
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
import { deriveGuidedCloseoutQueue, resolveGuidedNav, type GuidedTarget } from "@/lib/production/guided-closeout";
import {
  sortCloseoutRows,
  listDistinctTablets,
  filterRowsByTablet,
  type CloseoutSortKey,
  type CloseoutSortDir,
} from "@/lib/production/closeout-row-sort";
import { deriveCloseoutBucket, summarizeBuckets } from "@/lib/production/po-closeout";
import { recommendCloseoutNextAction } from "@/lib/production/closeout-recommendation";

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

// SIMPLIFY-A — tabs are action-oriented buckets: who/where does the next step.
const TABS = [
  { key: "do-here", label: "Do here", bucket: "DO_HERE" },
  { key: "on-floor", label: "On floor", bucket: "ON_FLOOR" },
  { key: "zoho", label: "Waiting on Zoho", bucket: "WAITING_ZOHO" },
  { key: "done", label: "Done", bucket: "DONE" },
  { key: "all", label: "All", bucket: null },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// BAG-PRODUCTION-SUMMARY-1 — read-only production-data filters. These
// compose with the bucket tabs above and never touch verdict logic.
// SIMPLIFY-A — has-production / no-production / awaiting-lot / zoho-blocked
// are now expressed by the bucket tabs; only the finer-grained production
// refinements remain here.
const SHOW_FILTERS = [
  { key: "any", label: "All production states" },
  { key: "partial", label: "Partial / split" },
  { key: "multi-run", label: "Multiple runs" },
  { key: "over-consumed", label: "Over-consumed" },
] as const;
type ShowKey = (typeof SHOW_FILTERS)[number]["key"];

function matchesShowFilter(
  summary: BagProductionSummary | undefined,
  row: PoCloseoutRow,
  show: ShowKey,
): boolean {
  if (show === "any") return true;
  switch (show) {
    case "partial":
      return summary?.flags.partialRemaining === true || summary?.flags.splitBag === true;
    case "multi-run":
      return summary?.flags.multipleWorkflows === true;
    case "over-consumed":
      return summary?.flags.overConsumed === true;
    default:
      return true;
  }
}

const SORT_OPTIONS: { key: CloseoutSortKey; label: string }[] = [
  { key: "receipt", label: "Bag/receipt" },
  { key: "tablet", label: "Tablet" },
  { key: "started", label: "Date started" },
  { key: "completed", label: "Date completed" },
];

export default async function PoCloseoutDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ poId: string }>;
  searchParams: Promise<{ tab?: string; empty?: string; show?: string; guided?: string; step?: string; bag?: string; sort?: string; dir?: string; tablet?: string }>;
}) {
  const { poId } = await params;
  await requireAdmin({ next: `/po-closeout/${encodeURIComponent(poId)}` });
  // SIMPLIFY-D — `step` is accepted but ignored (stale links from before
  // steps were bag-addressed); `bag` carries the current target.
  const { tab: rawTab, empty: rawEmpty, show: rawShow, guided: rawGuided, bag: rawBag, sort: rawSort, dir: rawDir, tablet: rawTablet } = await searchParams;
  const tab = (TABS.find((t) => t.key === rawTab)?.key ?? "do-here") as TabKey;
  const showEmpty = rawEmpty === "1";
  const show = (SHOW_FILTERS.find((f) => f.key === rawShow)?.key ?? "any") as ShowKey;

  const summary = await loadPoCloseout(poId);
  if (!summary) notFound();

  // Per-bag Received / Produced / Remaining breakdown (read-only).
  const productionByBag = await loadBagProductionSummaries({ poId });

  const c = summary.counts;

  // SIMPLIFY-A — bucket every row by WHERE the next step happens (pure
  // derivation over the row verdict; no policy lives on this page).
  const bucketByBag = new Map(
    summary.rows.map((r) => [
      r.inventoryBagId,
      deriveCloseoutBucket(r, productionByBag.get(r.inventoryBagId)?.producedTablets ?? null),
    ]),
  );
  const bucketCounts = summarizeBuckets([...bucketByBag.values()]);
  const activeBucket = TABS.find((t) => t.key === tab)?.bucket ?? null;
  const shown = summary.rows.filter((r) => {
    const b = bucketByBag.get(r.inventoryBagId) ?? "DO_HERE";
    if (b === "EMPTY" && !showEmpty && activeBucket !== null) return false;
    if (activeBucket === null) return showEmpty || b !== "EMPTY";
    return b === activeBucket || (activeBucket === "DO_HERE" && b === "EMPTY" && showEmpty);
  }).filter((r) => matchesShowFilter(productionByBag.get(r.inventoryBagId), r, show));

  // Only show the "Refine:" row when one of the remaining production flags
  // actually applies to a bag on this PO — otherwise it's an empty control.
  const hasRefinableFlags = [...productionByBag.values()].some(
    (s) => s.flags.partialRemaining || s.flags.splitBag || s.flags.multipleWorkflows || s.flags.overConsumed,
  );

  // Sort + tablet filter (applied after bucket/show filters).
  const sortKey: CloseoutSortKey = (["receipt", "tablet", "started", "completed"] as const).find((k) => k === rawSort) ?? "receipt";
  const sortDir: CloseoutSortDir = rawDir === "desc" ? "desc" : "asc";
  const tablet = rawTablet != null && rawTablet.length > 0 ? rawTablet : null;
  const tablets = listDistinctTablets(summary.rows);
  const visible = sortCloseoutRows(filterRowsByTablet(shown, tablet), sortKey, sortDir);

  // URL helper — preserves tab/show/sort/dir/tablet/empty; guided links remain separate.
  const qs = (over: Partial<Record<"tab" | "empty" | "show" | "sort" | "dir" | "tablet", string>>) => {
    const p = new URLSearchParams({
      tab,
      show,
      sort: sortKey,
      dir: sortDir,
      ...(tablet ? { tablet } : {}),
      ...(showEmpty ? { empty: "1" } : {}),
      ...over,
    });
    return `/po-closeout/${poId}?${p.toString()}`;
  };
  const issueReady = summary.rows.filter(
    (r) =>
      r.status === "READY_FOR_ACTION" &&
      (r.action === "AUTO_ISSUE_FINISHED_LOT" || r.action === "ISSUE_FINISHED_LOT"),
  ).length;
  const releaseReady = summary.rows.filter((r) => r.action === "AUTO_RELEASE_FINISHED_LOT" && r.status === "READY_FOR_ACTION").length;
  const calcReady = summary.rows.filter(
    (r) => r.action === "RECORD_REMAINING_OR_CLOSE_PARTIAL" && r.status === "READY_FOR_ACTION",
  ).length;
  const queueReady = summary.rows.filter((r) => r.zoho === "READY_TO_QUEUE" && r.zohoOpId != null).length;
  const recommendation = recommendCloseoutNextAction({ buckets: bucketCounts, issueReady, releaseReady });

  // GUIDED-CLOSEOUT-1 / SIMPLIFY-D — ?guided=1[&bag=<inventoryBagId|batch|finish>]
  // renders the "Close this PO" overlay. Steps are addressed by bag id (never
  // by index), so the queue derives from the live rows on THIS render and a
  // bag resolved out-of-band shortens the queue instead of desyncing it.
  const guided = rawGuided === "1";
  const { steps: guidedSteps, excluded: guidedExcluded } = deriveGuidedCloseoutQueue(summary.rows, bucketByBag);
  const hasSafeBatch = issueReady + releaseReady > 0;
  const guidedTotalSteps = guidedSteps.length + (hasSafeBatch ? 1 : 0);
  const requestedTarget: GuidedTarget | null =
    rawBag === "batch" || rawBag === "finish" || (typeof rawBag === "string" && rawBag.length > 0)
      ? (rawBag as GuidedTarget)
      : null;
  // Entry: bare ?guided=1 resolves to batch, else the first live bag, else finish.
  const currentTarget: GuidedTarget =
    requestedTarget ?? (hasSafeBatch ? "batch" : guidedSteps[0]?.inventoryBagId ?? "finish");
  // SIMPLIFY-D — a bare ?guided=1 must not stay bare: it re-resolves its
  // target on every render, so a server action that revalidates this page
  // (e.g. safe-batch) can flip `hasSafeBatch` and re-enter at the wrong
  // step, unmounting whatever guided step was showing results. Redirect
  // once to pin the resolved target into the URL — from then on the nav is
  // driven by `bag=...`, which is immune to revalidation-time count flips.
  if (guided && requestedTarget === null) {
    redirect(`/po-closeout/${poId}?guided=1&bag=${currentTarget}`);
  }
  const nav = resolveGuidedNav(guidedSteps, currentTarget, hasSafeBatch);
  const currentGuidedStep = nav.mode === "bag" && nav.index != null ? guidedSteps[nav.index] ?? null : null;
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
    guided && nav.mode === "finish"
      ? {
          done: c.done,
          readyForAction: c.readyForAction,
          needsReview: c.needsReview,
          blocked: c.blocked,
          topBlockers: summary.topBlockers,
        }
      : null;
  const doneReceipt =
    nav.mode === "bag-done"
      ? summary.rows.find((r) => r.inventoryBagId === currentTarget)?.receiptNumber ?? null
      : null;
  const stepNumber =
    nav.mode === "batch"
      ? 1
      : nav.mode === "bag" && nav.index != null
        ? nav.index + 1 + (hasSafeBatch ? 1 : 0)
        : guidedTotalSteps;

  return (
    <div className="space-y-5">
      <AutoRefreshOnFocus />
      {guided ? (
        <GuidedOverlay
          poId={poId}
          poNumber={summary.poNumber}
          mode={nav.mode}
          stepNumber={stepNumber}
          totalSteps={guidedTotalSteps}
          excluded={guidedExcluded}
          issueReady={issueReady}
          releaseReady={releaseReady}
          bagStep={guidedBagStep}
          doneReceipt={doneReceipt}
          finish={guidedFinish}
          prevTarget={nav.prevTarget}
          nextTarget={nav.nextTarget}
        />
      ) : null}
      <div>
        <Link href="/po-closeout" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2">
          <ArrowLeft className="h-3 w-3" /> All POs
        </Link>
        <PageHeader
          title={`${summary.poNumber} — closeout`}
          description={summary.vendorName ?? "Closeout command center"}
          actions={
            <div className="flex items-center gap-2">
              {guidedTotalSteps > 0 ? (
                <Link
                  href={`/po-closeout/${poId}?guided=1`}
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

      {summary.closedInZoho ? (
        <div className="rounded-lg border border-sky-300/50 bg-sky-50/60 px-4 py-2.5 text-[12px] text-sky-900">
          <span className="font-semibold">Closed in Zoho</span>
          {" — this PO is "}
          <span className="font-mono">{summary.zohoStatus}</span>
          {" on Zoho's side, so it counts as Closed here."}
          {summary.outputsNeverPushed > 0
            ? ` ${summary.outputsNeverPushed} output${summary.outputsNeverPushed === 1 ? " was" : "s were"} never pushed to Zoho; auto-commit skips this PO.`
            : null}
        </div>
      ) : null}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {[
          { label: "Do here", value: bucketCounts.DO_HERE, tone: "text-brand-700" },
          { label: "On floor", value: bucketCounts.ON_FLOOR, tone: "text-amber-700" },
          { label: "Waiting on Zoho", value: bucketCounts.WAITING_ZOHO, tone: "text-sky-700" },
          { label: "Done", value: bucketCounts.DONE, tone: "text-green-700" },
          { label: "Empty", value: bucketCounts.EMPTY, tone: "text-text-subtle" },
          { label: "Bags", value: c.total, tone: "text-text-strong" },
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
          {summary.closedInZoho ? (
            <span>
              {" "}These are Zoho op states; this PO is closed in Zoho, so unpushed outputs stay
              unpushed and are not counted as open work.
            </span>
          ) : null}
        </p>
      </div>

      {/* Bulk safe actions */}
      {(issueReady > 0 || releaseReady > 0 || calcReady > 0 || queueReady > 0) && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] text-text-muted mb-2">Safe PO-scoped actions (each re-checks eligibility per row; nothing is committed to Zoho):</p>
          <PoBatchButtons poId={poId} issueReady={issueReady} releaseReady={releaseReady} calcReady={calcReady} queueReady={queueReady} />
        </div>
      )}

      {/* Next-action recommendation */}
      {recommendation ? (
        <div className="rounded-lg border border-brand-300/40 bg-brand-50/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-brand-900">Next: {recommendation.headline}</p>
          {summary.topBlockers.length > 0 ? (
            <details className="text-[11px] text-text-muted">
              <summary className="cursor-pointer">All open reasons</summary>
              <ul className="mt-1 space-y-0.5">
                {summary.topBlockers.map((b) => (
                  <li key={b.reason}>{b.count}× {b.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {(tab === "zoho" || tab === "all") && summary.zohoMapping.skus.length > 0 ? (
        <div className="rounded-lg border border-sky-300/40 bg-sky-50/40 px-4 py-2.5">
          <p className="text-[12px] font-medium text-sky-900">
            {summary.zohoMapping.skus.length} SKU{summary.zohoMapping.skus.length === 1 ? "" : "s"} need{summary.zohoMapping.skus.length === 1 ? "s" : ""} Zoho
            mapping — fixing {summary.zohoMapping.skus.length === 1 ? "it" : "them"} unblocks {summary.zohoMapping.rows} bag
            {summary.zohoMapping.rows === 1 ? "" : "s"}.
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] text-sky-900">
            {summary.zohoMapping.skus.map((s) => (
              <li key={`${s.productId ?? ""}|${s.sku}`} className="flex items-center gap-2">
                <span className="font-mono">{s.sku}</span>
                <span className="text-sky-700">({s.count} bag{s.count === 1 ? "" : "s"})</span>
                {s.productId ? (
                  <Link href={`/products/${s.productId}?from=output-queue`} className="font-medium underline">
                    Fix mapping
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          <Link href={`/zoho-production-operations?po=${poId}`} className="mt-1 inline-block text-[11px] font-medium text-sky-800 underline">
            Open this PO's Zoho operations
          </Link>
        </div>
      ) : null}

      {/* Bucket tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => {
          const count =
            t.bucket === null
              ? c.total - (showEmpty ? 0 : bucketCounts.EMPTY)
              : t.bucket === "DO_HERE" && showEmpty
                ? bucketCounts.DO_HERE + bucketCounts.EMPTY
                : bucketCounts[t.bucket];
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={qs({ tab: t.key })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active ? "border-brand-500 bg-brand-50 text-brand-800" : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {t.label} ({count})
            </Link>
          );
        })}
        {bucketCounts.EMPTY > 0 ? (
          <Link href={qs({ empty: showEmpty ? "" : "1" })} className="text-[11px] text-text-muted underline decoration-dotted">
            {showEmpty ? "Hide" : "Show"} {bucketCounts.EMPTY} empty bag{bucketCounts.EMPTY === 1 ? "" : "s"} (no production)
          </Link>
        ) : null}
      </div>

      {/* Production-data filters (read-only view filters) */}
      {hasRefinableFlags ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-muted font-medium pr-1">Refine:</span>
          {SHOW_FILTERS.map((f) => {
            const active = f.key === show;
            return (
              <Link
                key={f.key}
                href={qs({ show: f.key })}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                  active ? "border-brand-500 bg-brand-50 text-brand-800 font-medium" : "border-border text-text-muted hover:bg-surface-2"
                }`}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
      ) : null}

      {/* Sort controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-text-muted font-medium pr-1">Sort:</span>
        {SORT_OPTIONS.map((opt) => {
          const active = sortKey === opt.key;
          const nextDir = active && sortDir === "asc" ? "desc" : "asc";
          return (
            <Link
              key={opt.key}
              href={qs({ sort: opt.key, dir: nextDir })}
              className={`inline-flex items-center gap-0.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                active ? "border-brand-500 bg-brand-50 text-brand-800 font-medium" : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {opt.label}
              {active ? (
                sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
              ) : null}
            </Link>
          );
        })}
      </div>

      {/* Tablet filter (only when multiple tablets in this PO) */}
      {tablets.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-muted font-medium pr-1">Tablet:</span>
          <Link
            href={qs({ tablet: "" })}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              tablet == null ? "border-brand-500 bg-brand-50 text-brand-800 font-medium" : "border-border text-text-muted hover:bg-surface-2"
            }`}
          >
            All tablets
          </Link>
          {tablets.map((name) => (
            <Link
              key={name}
              href={qs({ tablet: name })}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                tablet === name ? "border-brand-500 bg-brand-50 text-brand-800 font-medium" : "border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {name}
            </Link>
          ))}
        </div>
      ) : null}

      {/* Rows — CLOSEOUT-DRAWER-1: each row expands into the bag drawer
          (verify-in-place + act-in-place). */}
      <CloseoutRows
        poId={poId}
        rows={visible.map((row) => ({
          ...row,
          productionSummary: productionByBag.get(row.inventoryBagId) ?? null,
        }))}
      />
    </div>
  );
}
