// COMMERCIAL-TRACE-5 → LUMA-UI-REBUILD-1
//
// Server component. Loads:
//   - summary counts from finished_lot_invoice_allocations
//   - invoice-line list with filter support
//   - selected invoice line detail (?invoice_line=<uuid>)
//
// UI rebuilt on the standard design system. Data loading + filter
// logic unchanged from CT-5 shipping version — only chrome rebuilt.

import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  customers,
  finishedLotInvoiceAllocations,
  finishedLots,
  shipmentFinishedLots,
  zohoInvoiceLines,
  zohoInvoices,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Filter,
  Inbox,
  Receipt,
  ShieldAlert,
  Slash,
  Sparkles,
} from "lucide-react";
import { InvoiceAllocationActions } from "./invoice-allocation-actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  invoice?: string;
  customer?: string;
  sku?: string;
  status?: string;
  confidence?: string;
  needs_review?: string;
  unconfirmed?: string;
  invoice_line?: string;
}>;

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[date.getUTCMonth()] ?? "?"} ${date.getUTCDate()} ${date.getUTCFullYear()}`;
}

export default async function InvoiceAllocationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const filters = {
    invoice: sp.invoice?.trim() ?? "",
    customer: sp.customer?.trim() ?? "",
    sku: sp.sku?.trim() ?? "",
    status: sp.status?.trim() ?? "",
    confidence: sp.confidence?.trim() ?? "",
    needsReview: sp.needs_review === "true",
    unconfirmed: sp.unconfirmed === "true",
  };
  const selectedInvoiceLineId = sp.invoice_line?.trim() || null;

  // Summary counts (unchanged from CT-5).
  const summaryRows = await db
    .select({
      status: finishedLotInvoiceAllocations.status,
      confidence: finishedLotInvoiceAllocations.confidence,
      confirmed: finishedLotInvoiceAllocations.confirmed,
      count: sql<string>`COUNT(*)`,
    })
    .from(finishedLotInvoiceAllocations)
    .groupBy(
      finishedLotInvoiceAllocations.status,
      finishedLotInvoiceAllocations.confidence,
      finishedLotInvoiceAllocations.confirmed,
    );

  const summary = {
    needsReview: 0,
    suggested: 0,
    confirmed: 0,
    rejected: 0,
    missing: 0,
  };
  for (const r of summaryRows) {
    const c = Number(r.count);
    if (r.status === "SUGGESTED" && !r.confirmed) summary.suggested += c;
    if (r.status === "NEEDS_REVIEW") summary.needsReview += c;
    if (r.status === "REJECTED") summary.rejected += c;
    if (r.confirmed) summary.confirmed += c;
    if (r.confidence === "MISSING") summary.missing += c;
  }
  const totalRows =
    summary.needsReview + summary.suggested + summary.confirmed + summary.rejected;

  // Invoice-line list (unchanged from CT-5).
  const wherePieces = [] as Array<ReturnType<typeof eq>>;
  if (filters.invoice) {
    wherePieces.push(
      ilike(zohoInvoices.invoiceNumber, `%${filters.invoice}%`) as unknown as ReturnType<typeof eq>,
    );
  }
  if (filters.sku) {
    wherePieces.push(
      ilike(zohoInvoiceLines.sku, `%${filters.sku}%`) as unknown as ReturnType<typeof eq>,
    );
  }

  const lineRows = await db
    .select({
      lineId: zohoInvoiceLines.id,
      invoiceNumber: zohoInvoices.invoiceNumber,
      customerName: customers.name,
      customerId: zohoInvoices.customerId,
      invoiceDate: zohoInvoices.invoiceDate,
      itemName: zohoInvoiceLines.itemName,
      sku: zohoInvoiceLines.sku,
      zohoItemId: zohoInvoiceLines.zohoItemId,
      quantity: zohoInvoiceLines.quantity,
      unit: zohoInvoiceLines.unit,
    })
    .from(zohoInvoiceLines)
    .leftJoin(zohoInvoices, eq(zohoInvoices.id, zohoInvoiceLines.zohoInvoiceId))
    .leftJoin(customers, eq(customers.id, zohoInvoices.customerId))
    .where(
      wherePieces.length === 0
        ? sql`TRUE`
        : (and(...wherePieces) as unknown as ReturnType<typeof eq>),
    )
    .orderBy(desc(zohoInvoices.invoiceDate), desc(zohoInvoiceLines.createdAt))
    .limit(200);

  const lineIds = lineRows.map((r) => r.lineId);
  const allocAggRows =
    lineIds.length === 0
      ? []
      : await db
          .select({
            invoiceLineId: finishedLotInvoiceAllocations.invoiceLineId,
            confirmed: finishedLotInvoiceAllocations.confirmed,
            status: finishedLotInvoiceAllocations.status,
            confidence: finishedLotInvoiceAllocations.confidence,
            sumQty: sql<string>`SUM(${finishedLotInvoiceAllocations.quantityAllocated})`,
            count: sql<string>`COUNT(*)`,
          })
          .from(finishedLotInvoiceAllocations)
          .where(
            sql`${finishedLotInvoiceAllocations.invoiceLineId} IN (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})`,
          )
          .groupBy(
            finishedLotInvoiceAllocations.invoiceLineId,
            finishedLotInvoiceAllocations.confirmed,
            finishedLotInvoiceAllocations.status,
            finishedLotInvoiceAllocations.confidence,
          );

  type Agg = {
    suggestedQty: number;
    confirmedQty: number;
    hasNeedsReview: boolean;
    rowCount: number;
    confirmedCount: number;
  };
  const aggByLine = new Map<string, Agg>();
  for (const r of allocAggRows) {
    const key = r.invoiceLineId;
    const a =
      aggByLine.get(key) ??
      ({ suggestedQty: 0, confirmedQty: 0, hasNeedsReview: false, rowCount: 0, confirmedCount: 0 } as Agg);
    const qty = Number(r.sumQty ?? 0);
    a.rowCount += Number(r.count);
    if (r.confirmed) {
      a.confirmedQty += qty;
      a.confirmedCount += Number(r.count);
    } else if (r.status !== "REJECTED") {
      a.suggestedQty += qty;
    }
    if (r.status === "NEEDS_REVIEW") a.hasNeedsReview = true;
    aggByLine.set(key, a);
  }

  const filteredLines = lineRows.filter((r) => {
    if (filters.customer) {
      const v = (r.customerName ?? "").toLowerCase();
      if (!v.includes(filters.customer.toLowerCase())) return false;
    }
    const a = aggByLine.get(r.lineId);
    const hasAny = a != null && a.rowCount > 0;
    if (filters.needsReview && !(a?.hasNeedsReview === true)) return false;
    if (filters.unconfirmed && a != null && a.confirmedCount > 0 && a.rowCount === a.confirmedCount)
      return false;
    if (filters.status) {
      const want = filters.status.toUpperCase();
      const lineStatus = !hasAny
        ? "UNALLOCATED"
        : a!.confirmedCount === a!.rowCount
          ? "CONFIRMED"
          : a!.hasNeedsReview
            ? "NEEDS_REVIEW"
            : "SUGGESTED";
      if (lineStatus !== want) return false;
    }
    return true;
  });

  // Detail block for selected line (unchanged from CT-5).
  type DetailRow = {
    id: string;
    finishedLotNumber: string | null;
    traceCode: string | null;
    shipmentFinishedLotId: string | null;
    packedAt: Date | null;
    shippedAt: Date | null;
    quantityAllocated: string;
    unit: string | null;
    confidence: string;
    source: string;
    status: string;
    confirmed: boolean;
    confirmedAt: Date | null;
    notes: string | null;
  };
  const detail: { line: (typeof lineRows)[number] | null; rows: DetailRow[] } = {
    line: null,
    rows: [],
  };

  if (selectedInvoiceLineId) {
    detail.line = lineRows.find((r) => r.lineId === selectedInvoiceLineId) ?? null;
    if (!detail.line) {
      const [extra] = await db
        .select({
          lineId: zohoInvoiceLines.id,
          invoiceNumber: zohoInvoices.invoiceNumber,
          customerName: customers.name,
          customerId: zohoInvoices.customerId,
          invoiceDate: zohoInvoices.invoiceDate,
          itemName: zohoInvoiceLines.itemName,
          sku: zohoInvoiceLines.sku,
          zohoItemId: zohoInvoiceLines.zohoItemId,
          quantity: zohoInvoiceLines.quantity,
          unit: zohoInvoiceLines.unit,
        })
        .from(zohoInvoiceLines)
        .leftJoin(zohoInvoices, eq(zohoInvoices.id, zohoInvoiceLines.zohoInvoiceId))
        .leftJoin(customers, eq(customers.id, zohoInvoices.customerId))
        .where(eq(zohoInvoiceLines.id, selectedInvoiceLineId))
        .limit(1);
      if (extra) detail.line = extra;
    }
    if (detail.line) {
      const allocRows = await db
        .select({
          id: finishedLotInvoiceAllocations.id,
          finishedLotId: finishedLotInvoiceAllocations.finishedLotId,
          shipmentFinishedLotId: finishedLotInvoiceAllocations.shipmentFinishedLotId,
          quantityAllocated: finishedLotInvoiceAllocations.quantityAllocated,
          unit: finishedLotInvoiceAllocations.unit,
          confidence: finishedLotInvoiceAllocations.confidence,
          source: finishedLotInvoiceAllocations.source,
          status: finishedLotInvoiceAllocations.status,
          confirmed: finishedLotInvoiceAllocations.confirmed,
          confirmedAt: finishedLotInvoiceAllocations.confirmedAt,
          notes: finishedLotInvoiceAllocations.notes,
          finishedLotNumber: finishedLots.finishedLotNumber,
          traceCode: finishedLots.traceCode,
          packedAt: finishedLots.packedAt,
          sflShippedAt: shipmentFinishedLots.shippedAt,
        })
        .from(finishedLotInvoiceAllocations)
        .leftJoin(finishedLots, eq(finishedLots.id, finishedLotInvoiceAllocations.finishedLotId))
        .leftJoin(
          shipmentFinishedLots,
          eq(shipmentFinishedLots.id, finishedLotInvoiceAllocations.shipmentFinishedLotId),
        )
        .where(eq(finishedLotInvoiceAllocations.invoiceLineId, selectedInvoiceLineId))
        .orderBy(desc(finishedLotInvoiceAllocations.confirmed), desc(finishedLotInvoiceAllocations.confidence));
      detail.rows = allocRows.map((r) => ({
        id: r.id,
        finishedLotNumber: r.finishedLotNumber,
        traceCode: r.traceCode,
        shipmentFinishedLotId: r.shipmentFinishedLotId,
        packedAt: r.packedAt,
        shippedAt: r.sflShippedAt,
        quantityAllocated: r.quantityAllocated,
        unit: r.unit,
        confidence: r.confidence,
        source: r.source,
        status: r.status,
        confirmed: r.confirmed,
        confirmedAt: r.confirmedAt,
        notes: r.notes,
      }));
    }
  }

  const hasAnyData = totalRows > 0 || filteredLines.length > 0;

  const statusBadgeClasses: Record<string, string> = {
    good: "inline-flex items-center h-5 px-1.5 rounded border border-good-500/30 bg-good-50/80 text-good-700 text-[10px] font-semibold uppercase tracking-wider",
    warn: "inline-flex items-center h-5 px-1.5 rounded border border-warn-500/30 bg-warn-50/80 text-warn-700 text-[10px] font-semibold uppercase tracking-wider",
    info: "inline-flex items-center h-5 px-1.5 rounded border border-info-500/30 bg-info-50/80 text-info-700 text-[10px] font-semibold uppercase tracking-wider",
    muted: "inline-flex items-center h-5 px-1.5 rounded border border-border bg-surface-2 text-text-muted text-[10px] font-semibold uppercase tracking-wider",
    crit: "inline-flex items-center h-5 px-1.5 rounded border border-crit-500/30 bg-crit-50/80 text-crit-700 text-[10px] font-semibold uppercase tracking-wider",
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoice Allocations"
        description="Confirm which Luma finished lots fulfilled each Zoho invoice line. Only confirmed allocations power the Nexus invoice / batch lookup — suggestions are engine-generated and require your explicit confirmation."
      />

      {/* Info panel */}
      <div className="rounded-xl border border-info-200 bg-info-50/60 px-4 py-3 text-[12px] text-info-800 flex items-start gap-2.5">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Only confirmed allocations should be used for Nexus invoice/batch lookup.</p>
          <p className="mt-0.5">
            Suggestions may be wrong. Confirm only when the finished lot truly
            fulfilled the invoice line. Customer-scope Nexus responses always
            hide supplier lot, internal receipt, raw bag QR, operator, and
            machine details — regardless of confirmation.
          </p>
        </div>
      </div>

      {/* Stats ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Needs review</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{summary.needsReview.toLocaleString()}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Lines with at least one unresolved row</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Suggested</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{summary.suggested.toLocaleString()}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Engine output, awaiting confirm</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Confirmed</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{summary.confirmed.toLocaleString()}</p>
          <p className="text-[11px] text-text-muted mt-0.5">HIGH confidence, in Nexus</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Rejected / Missing data</p>
          <p className="text-2xl font-mono tabular-nums text-text-strong mt-1">{summary.rejected.toLocaleString()} / {summary.missing.toLocaleString()}</p>
          <p className="text-[11px] text-text-muted mt-0.5">Kept for audit trail / quantity absent</p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Filters</p>
            <h2 className="text-sm font-semibold text-text-strong">Narrow the queue</h2>
            <p className="text-[11px] text-text-muted mt-0.5">All filters are query-string driven and bookmarkable.</p>
          </div>
          <Link href="/invoice-allocations" className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline">
            Reset
          </Link>
        </div>
        <div className="px-4 py-4">
          <form className="rounded-xl border border-border bg-surface px-4 py-3 flex flex-wrap items-end gap-3" method="get">
            <FilterField name="invoice" label="Invoice #" defaultValue={filters.invoice} placeholder="INV-…" />
            <FilterField name="customer" label="Customer" defaultValue={filters.customer} placeholder="customer name" />
            <FilterField name="sku" label="SKU" defaultValue={filters.sku} placeholder="SKU-…" mono />
            <FilterSelect
              name="status"
              label="Line status"
              defaultValue={filters.status}
              options={[
                { value: "", label: "Any" },
                { value: "UNALLOCATED", label: "Unallocated" },
                { value: "SUGGESTED", label: "Suggested" },
                { value: "NEEDS_REVIEW", label: "Needs review" },
                { value: "CONFIRMED", label: "Confirmed" },
              ]}
            />
            <FilterSelect
              name="confidence"
              label="Confidence"
              defaultValue={filters.confidence}
              options={[
                { value: "", label: "Any" },
                { value: "HIGH", label: "HIGH (confirmed)" },
                { value: "MEDIUM", label: "MEDIUM" },
                { value: "LOW", label: "LOW" },
                { value: "MISSING", label: "MISSING" },
              ]}
            />
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-2 text-[11px]">
                <ToggleCheckbox name="needs_review" label="Needs review" defaultChecked={filters.needsReview} />
                <ToggleCheckbox name="unconfirmed" label="Unconfirmed" defaultChecked={filters.unconfirmed} />
              </div>
              <button
                type="submit"
                className="ml-auto inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-[12.5px] font-medium tracking-tight shadow-card transition-colors"
              >
                <Filter className="h-3.5 w-3.5" />
                Apply
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Master-detail grid: queue on the left, review panel on the right. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-6 items-start">
        {/* Queue */}
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
            <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Queue</p>
            <h2 className="text-sm font-semibold text-text-strong">Invoice lines</h2>
            {filteredLines.length > 0 && (
              <p className="text-[11px] text-text-muted mt-0.5">
                Showing {filteredLines.length} of {lineRows.length} line{lineRows.length === 1 ? "" : "s"}.
              </p>
            )}
            {filteredLines.length === 0 && hasAnyData && (
              <p className="text-[11px] text-text-muted mt-0.5">No invoice lines match the current filters.</p>
            )}
          </div>
          <div>
            {filteredLines.length === 0 ? (
              hasAnyData ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm font-medium text-text-muted">No invoice lines match these filters</p>
                  <p className="text-[12px] text-text-subtle mt-1">Adjust the filters above, or reset to see every invoice line.</p>
                  <Link
                    href="/invoice-allocations"
                    className="mt-2 inline-block text-[12px] font-medium text-brand-800 hover:text-brand-700 underline-offset-2 hover:underline"
                  >
                    Reset filters →
                  </Link>
                </div>
              ) : (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm font-medium text-text-muted">No Zoho invoice lines available yet. Invoice rows arrive via the apply phase</p>
                  <p className="text-[12px] text-text-subtle mt-1">Once invoice lines are seeded, every line surfaces here and the suggestion engine can be invoked per-line.</p>
                </div>
              )
            ) : (
              <ul className="divide-y divide-border/70">
                {filteredLines.map((r) => {
                  const a = aggByLine.get(r.lineId);
                  const lineStatus =
                    !a
                      ? "Unallocated"
                      : a.confirmedCount === a.rowCount
                        ? "Confirmed by operator"
                        : a.hasNeedsReview
                          ? "Needs review"
                          : "Suggested";
                  const statusTone =
                    lineStatus === "Confirmed by operator"
                      ? "good"
                      : lineStatus === "Needs review"
                        ? "warn"
                        : lineStatus === "Suggested"
                          ? "info"
                          : "muted";
                  const warnings: string[] = [];
                  if (!r.zohoItemId && !r.sku) warnings.push("Missing item id / SKU");
                  if (!r.customerId) warnings.push("Missing customer");
                  if (r.quantity == null) warnings.push("Missing quantity");
                  const isSelected = selectedInvoiceLineId === r.lineId;
                  return (
                    <li key={r.lineId}>
                      <Link
                        href={`/invoice-allocations?invoice_line=${r.lineId}`}
                        className={
                          "group block py-3 pl-3 pr-4 transition-colors " +
                          (isSelected ? "bg-surface-2/70" : "hover:bg-surface-2/40")
                        }
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-[12px] text-text-strong tabular">
                                {r.invoiceNumber ?? "(no invoice number)"}
                              </span>
                              <span className={statusBadgeClasses[statusTone]}>
                                {lineStatus}
                              </span>
                              <span className="text-[10.5px] text-text-subtle font-mono uppercase tracking-[0.08em]">
                                {fmtDate(r.invoiceDate)}
                              </span>
                            </div>
                            <div className="mt-1 text-[13px] text-text-strong font-medium tracking-tight truncate">
                              {r.itemName}
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-[11px] text-text-muted">
                              <span className="truncate">{r.customerName ?? "Missing customer"}</span>
                              {r.sku ? <span className="font-mono text-text-subtle">{r.sku}</span> : null}
                            </div>
                            {warnings.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {warnings.map((w) => (
                                  <span key={w} className={statusBadgeClasses["warn"]}>
                                    <AlertTriangle className="h-3 w-3 mr-1" />
                                    {w}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="text-right shrink-0 flex flex-col items-end gap-1">
                            <div className="font-mono text-[13px] tabular text-text-strong">
                              {r.quantity ?? "?"} <span className="text-text-subtle">{r.unit ?? ""}</span>
                            </div>
                            <div className="text-[10.5px] uppercase tracking-[0.10em] text-text-subtle">
                              {a ? (
                                <>
                                  <span className="text-good-700 font-mono tabular">{a.confirmedQty}</span>
                                  <span className="text-text-subtle"> / </span>
                                  <span className="text-info-700 font-mono tabular">{a.suggestedQty}</span>
                                </>
                              ) : (
                                <span className="text-text-subtle">No suggestions</span>
                              )}
                            </div>
                            <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-brand-800 transition-colors" />
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Review panel — sticky on the right at lg+, full-width below. */}
        <div className="lg:sticky lg:top-6">
          {detail.line ? (
            <div className="rounded-xl border border-border bg-surface overflow-hidden">
              <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40 flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">
                    Review · {detail.line.invoiceNumber ?? "(no number)"}
                  </p>
                  <h2 className="text-sm font-semibold text-text-strong">{detail.line.itemName}</h2>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    Confirmed rows become the bridge for Nexus invoice → batch lookup. Customer-scope responses never expose supplier lot, internal receipt, raw bag QR, operator, or machine details.
                  </p>
                </div>
                <Link
                  href="/invoice-allocations"
                  className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline shrink-0"
                >
                  Close
                </Link>
              </div>
              <div className="px-4 py-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[12px]">
                  <dt className="text-text-muted">Invoice</dt>
                  <dd className="font-medium text-text-strong font-mono">{detail.line.invoiceNumber ?? "—"}</dd>
                  <dt className="text-text-muted">Invoice date</dt>
                  <dd className="font-medium text-text-strong font-mono">{fmtDate(detail.line.invoiceDate)}</dd>
                  <dt className="text-text-muted">Customer</dt>
                  <dd className="font-medium text-text-strong">{detail.line.customerName ?? "—"}</dd>
                  <dt className="text-text-muted">Invoice qty</dt>
                  <dd className="font-medium text-text-strong font-mono">{detail.line.quantity ?? "?"} {detail.line.unit ?? ""}</dd>
                  <dt className="text-text-muted">SKU</dt>
                  <dd className="font-medium text-text-strong font-mono">{detail.line.sku ?? "—"}</dd>
                  <dt className="text-text-muted">Zoho item id</dt>
                  <dd className="font-medium text-text-strong font-mono">{detail.line.zohoItemId ?? "—"}</dd>
                </dl>

                <div className="mt-4">
                  <InvoiceAllocationActions
                    invoiceLineId={detail.line.lineId}
                    rows={detail.rows.map((row) => ({
                      id: row.id,
                      finishedLotNumber: row.finishedLotNumber,
                      traceCode: row.traceCode,
                      shipmentFinishedLotId: row.shipmentFinishedLotId,
                      packedAt: row.packedAt ? row.packedAt.toISOString() : null,
                      shippedAt: row.shippedAt ? row.shippedAt.toISOString() : null,
                      quantityAllocated: row.quantityAllocated,
                      unit: row.unit,
                      confidence: row.confidence,
                      source: row.source,
                      status: row.status,
                      confirmed: row.confirmed,
                      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
                      notes: row.notes,
                    }))}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-surface px-5 py-6">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-2 border border-border">
                  <ClipboardList className="h-4 w-4 text-text-muted" />
                </span>
                <div>
                  <p className="text-[13px] font-semibold tracking-tight text-text-strong">
                    Select an invoice line to review
                  </p>
                  <p className="mt-1 text-[12px] text-text-muted leading-relaxed">
                    Pick a row on the left. The review panel will load the
                    engine&apos;s suggested finished lots, their confidence, and
                    the Confirm / Reject actions.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page-local form bits ────────────────────────────────────────────

function FilterField({
  name,
  label,
  defaultValue,
  placeholder,
  mono,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="block eyebrow mb-1">{label}</span>
      <input
        name={name}
        type="text"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={
          "w-full h-9 px-2.5 rounded-md border border-border bg-surface text-[12.5px] " +
          "focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-500/15 " +
          (mono ? "font-mono text-[12px] tracking-normal" : "")
        }
      />
    </label>
  );
}

function FilterSelect({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="block eyebrow mb-1">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
        className="w-full h-9 px-2.5 rounded-md border border-border bg-surface text-[12.5px] focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleCheckbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <span className="relative inline-flex h-4 w-4">
        <input
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={defaultChecked}
          className="peer absolute inset-0 h-full w-full appearance-none rounded-[4px] border border-border bg-surface checked:border-brand-accent checked:bg-brand-accent transition-colors"
        />
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto h-3 w-3 stroke-white opacity-0 peer-checked:opacity-100"
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5L20 7" />
        </svg>
      </span>
      <span className="text-[11.5px] text-text-muted">{label}</span>
    </label>
  );
}
