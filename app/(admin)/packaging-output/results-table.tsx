// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — search/history results table.
//
// Server component. Renders the unified result rows from
// `listProductionOutputRowsWithFilters` with status badge, drilldown
// links, and the per-row action button (delegated to a small client
// component for stateful actions).

import Link from "next/link";
import { formatDateTimeEst } from "@/lib/ui/luma-display";
import type { ProductionOutputRowRaw } from "@/lib/db/queries/production-output-rows";
import {
  classifyProductionOutputRow,
  type ProductionOutputClassifiedRow,
  type ProductionOutputRowStatus,
} from "@/lib/production/production-output-row-classifier";
import {
  PRODUCTION_OUTPUT_LIMIT_DEFAULT,
  serializeProductionOutputFilters,
  type ProductionOutputFilters,
} from "@/lib/production/production-output-filters";
import { WorkbenchRowActions } from "./workbench-row-actions";

const STATUS_BADGE_STYLES: Record<
  ProductionOutputRowStatus,
  { className: string; label: string }
> = {
  AWAITING_LOT: {
    className: "border-amber-300 bg-amber-50 text-amber-900",
    label: "Awaiting lot",
  },
  READY_TO_AUTO_ISSUE: {
    className: "border-green-300 bg-green-50 text-green-800",
    label: "Ready to auto-issue",
  },
  MISSING_ALLOCATION: {
    className: "border-amber-400 bg-amber-50 text-amber-900",
    label: "Missing allocation",
  },
  BLOCKED: {
    className: "border-red-300 bg-red-50 text-red-800",
    label: "Blocked",
  },
  ISSUED_LOT: {
    className: "border-sky-300 bg-sky-50 text-sky-800",
    label: "Finished lot issued",
  },
  ZOHO_PENDING: {
    className: "border-violet-300 bg-violet-50 text-violet-800",
    label: "Zoho pending",
  },
  ZOHO_COMMITTED: {
    className: "border-emerald-400 bg-emerald-50 text-emerald-800",
    label: "Zoho committed",
  },
  ZOHO_FAILED: {
    className: "border-red-400 bg-red-50 text-red-800",
    label: "Zoho needs review",
  },
  PACKAGED_NOT_FINALIZED: {
    className: "border-sky-300 bg-sky-50 text-sky-800",
    label: "Packaged — awaiting finalization",
  },
  EXCLUDED: {
    className: "border-border bg-surface-2 text-text-muted",
    label: "Excluded",
  },
};

type Props = {
  rows: ProductionOutputRowRaw[];
  totalCount: number;
  filters: ProductionOutputFilters;
  hasMore: boolean;
  canMutate: boolean;
};

export function ProductionOutputResultsTable({
  rows,
  totalCount,
  filters,
  hasMore,
  canMutate,
}: Props) {
  const classified = rows.map((r) => ({
    raw: r,
    cls: classifyProductionOutputRow({
      finalizedAt: r.finalizedAt,
      startedAt: r.startedAt,
      stage: r.stage,
      excludedFromOutput: r.excludedFromOutput,
      // We don't run the full backlog evaluator here — the workbench
      // results surface uses the raw zoho-op/finished-lot lifecycle
      // for status. The backlog evaluator stays the source of truth
      // for the default queue rendered by the legacy block below.
      backlogActionCode: null,
      backlogActionLabel: null,
      finishedLotId: r.finishedLotId,
      finishedLotNumber: r.finishedLotNumber,
      finishedLotStatus: r.finishedLotStatus,
      genealogyLinkCount: r.genealogyLinkCount,
      productZohoItemIdUnit: r.productZohoItemIdUnit,
      productZohoItemIdDisplay: r.productZohoItemIdDisplay,
      productZohoItemIdCase: r.productZohoItemIdCase,
      productTabletsPerUnit: r.productTabletsPerUnit,
      casesProduced: r.masterCases,
      displaysProduced: r.displaysMade,
      zohoOpId: r.zohoOpId,
      zohoOpStatus: r.zohoOpStatus,
      zohoOpCommittedAt: r.zohoOpCommittedAt,
    }),
  }));

  const nextPage = filters.page + 1;
  const prevPage = Math.max(1, filters.page - 1);

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-border/60 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">
            Production output search results
          </p>
          <h2 className="text-sm font-semibold text-text-strong">
            {totalCount === 0
              ? "No matching rows"
              : `${rows.length} of ${totalCount} row${totalCount === 1 ? "" : "s"}`}
            {filters.q ? (
              <>
                {" "}
                <span className="text-text-muted text-[12.5px] font-normal">
                  matching <span className="font-mono">{filters.q}</span>
                </span>
              </>
            ) : null}
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Includes finalized backlog, issued finished lots, and Zoho
            production-output ops. Date range matches against{" "}
            <span className="font-mono">finalized_at</span> with{" "}
            <span className="font-mono">started_at</span> as a fallback
            for PACKAGED rows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PaginationLink
            page={prevPage}
            filters={filters}
            disabled={filters.page === 1}
            label="Prev"
          />
          <span className="text-[11px] text-text-muted tabular-nums">
            Page {filters.page}
          </span>
          <PaginationLink
            page={nextPage}
            filters={filters}
            disabled={!hasMore}
            label="Next"
          />
        </div>
      </div>
      <div className="px-4 py-4">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-text-muted text-sm">
            No production output rows match these filters. Try
            status=all or widening the date range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-[12.5px] w-full">
              <thead>
                <tr className="border-b border-border/60">
                  <Th>Receipt</Th>
                  <Th>Product</Th>
                  <Th align="right">Cases</Th>
                  <Th align="right">Displays</Th>
                  <Th align="right">Loose</Th>
                  <Th align="right">Units</Th>
                  <Th>Finalized</Th>
                  <Th>Finished lot</Th>
                  <Th>Status</Th>
                  <Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {classified.map(({ raw, cls }) => (
                  <ResultRow
                    key={raw.workflowBagId}
                    raw={raw}
                    cls={cls}
                    canMutate={canMutate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({
  raw,
  cls,
  canMutate,
}: {
  raw: ProductionOutputRowRaw;
  cls: ProductionOutputClassifiedRow;
  canMutate: boolean;
}) {
  const badge = STATUS_BADGE_STYLES[cls.status];
  return (
    <tr className="border-b border-border/30 last:border-0 align-top">
      <td className="py-2 pr-4 font-mono text-[11.5px] text-text-strong">
        {raw.receiptNumber ?? <span className="text-text-subtle">—</span>}
        {raw.poNumber ? (
          <div className="text-[10.5px] text-text-muted">
            <Link
              className="underline-offset-2 hover:underline"
              href={`/po-reconciliation/${raw.poId}`}
            >
              {raw.poNumber}
            </Link>
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-4">
        <div className="text-text-strong">
          {raw.productName ?? <span className="text-text-subtle text-[11px]">—</span>}
        </div>
        {raw.productSku ? (
          <div className="font-mono text-[10.5px] text-text-muted">
            {raw.productSku}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums">
        {raw.masterCases ?? "—"}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums">
        {raw.displaysMade ?? "—"}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums">
        {raw.looseCards ?? "—"}
      </td>
      <td className="py-2 pr-4 text-right tabular-nums font-medium">
        {raw.unitsYielded ?? "—"}
      </td>
      <td className="py-2 pr-4 text-[11.5px] text-text-muted tabular-nums whitespace-nowrap">
        {raw.finalizedAt ? (
          formatDateTimeEst(raw.finalizedAt)
        ) : raw.startedAt ? (
          <span className="text-text-subtle">
            (started {formatDateTimeEst(raw.startedAt)})
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="py-2 pr-4">
        {raw.finishedLotId && raw.finishedLotNumber ? (
          <Link
            className="font-mono text-[11.5px] text-brand-700 hover:text-brand-800 underline-offset-2 hover:underline"
            href={`/finished-lots/${raw.finishedLotId}`}
          >
            {raw.finishedLotNumber}
          </Link>
        ) : (
          <span className="text-text-subtle text-[11px]">—</span>
        )}
        {raw.finishedLotStatus ? (
          <div className="text-[10.5px] text-text-muted">
            {raw.finishedLotStatus}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-4">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
        {!cls.zohoPush.enabled && cls.status === "ISSUED_LOT" ? (
          <div
            className="mt-1 text-[10px] text-text-subtle"
            title={cls.zohoPush.message}
          >
            {cls.zohoPush.blocker.replaceAll("_", " ").toLowerCase()}
          </div>
        ) : null}
      </td>
      <td className="py-2">
        <WorkbenchRowActions
          workflowBagId={raw.workflowBagId}
          finishedLotId={raw.finishedLotId}
          finishedLotNumber={raw.finishedLotNumber}
          zohoOpId={raw.zohoOpId}
          poId={raw.poId}
          primaryAction={cls.primaryAction}
          zohoPush={cls.zohoPush}
          canMutate={canMutate}
        />
      </td>
    </tr>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function PaginationLink({
  page,
  filters,
  disabled,
  label,
}: {
  page: number;
  filters: ProductionOutputFilters;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="h-7 px-2 rounded border border-border bg-surface-2 text-text-subtle text-[11px] inline-flex items-center">
        {label}
      </span>
    );
  }
  const qs = serializeProductionOutputFilters({
    ...filters,
    page,
    // Don't suppress limit in URL during pagination — preserves
    // operator's explicit choice even when it equals the default.
    limit:
      filters.limit !== PRODUCTION_OUTPUT_LIMIT_DEFAULT
        ? filters.limit
        : filters.limit,
  });
  return (
    <Link
      className="h-7 px-2 rounded border border-border bg-surface text-text text-[11px] inline-flex items-center hover:bg-surface-2"
      href={`/packaging-output${qs ? `?${qs}` : ""}#output-queue`}
    >
      {label}
    </Link>
  );
}
