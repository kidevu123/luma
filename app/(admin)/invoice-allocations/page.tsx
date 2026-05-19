// COMMERCIAL-TRACE-5 → LUMA-UI-REBUILD-1
//
// Server component. Loads:
//   - summary counts from finished_lot_invoice_allocations
//   - invoice-line list with filter support
//   - selected invoice line detail (?invoice_line=<uuid>)
//
// UI built on the new Luma command-surface primitive library
// (components/production/luma-ui). Data loading + filter logic
// unchanged from CT-5 shipping version — only chrome rebuilt.

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
import {
  ActionPanel,
  CommandShell,
  DataEmptyState,
  FieldGroup,
  PageHero,
  RecordCard,
  RibbonStrip,
  SectionCard,
  StatusBadge,
  type FieldRow,
  type RibbonSegmentData,
} from "@/components/production/luma-ui";
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

  return (
    <CommandShell density="wide">
      <PageHero
        eyebrow="Commercial trace · Operator review"
        title="Invoice Allocations"
        description={
          <>
            Confirm which Luma finished lots fulfilled each Zoho invoice line.
            Only <strong className="text-text-strong">confirmed allocations</strong> power the
            Nexus invoice / batch lookup — suggestions are engine-generated and
            require your explicit confirmation.
          </>
        }
        badges={[
          { label: `${totalRows} allocation row${totalRows === 1 ? "" : "s"}`, tone: "info", mono: true },
          { label: `${filteredLines.length} line${filteredLines.length === 1 ? "" : "s"} shown`, tone: "muted", mono: true },
        ]}
      />

      <ActionPanel
        tone="info"
        icon={ShieldAlert}
        title="Only confirmed allocations should be used for Nexus invoice/batch lookup."
        body={
          <>
            Suggestions may be wrong. Confirm only when the finished lot truly
            fulfilled the invoice line. Customer-scope Nexus responses always
            hide supplier lot, internal receipt, raw bag QR, operator, and
            machine details — regardless of confirmation.
          </>
        }
      />

      {/* Signature ribbon — one unified inverse band carrying the five
          allocation statuses as proportional segments. The accent pip
          only pulses on the live tone (Confirmed > 0). */}
      <RibbonStrip
        reveal="reveal-2"
        segments={
          [
            { label: "Needs review",  value: summary.needsReview.toLocaleString(), tone: "warn", icon: AlertTriangle, hint: "Lines with at least one unresolved row" },
            { label: "Suggested",     value: summary.suggested.toLocaleString(),   tone: "info", icon: Sparkles,       hint: "Engine output, awaiting confirm" },
            { label: "Confirmed",     value: summary.confirmed.toLocaleString(),   tone: "good", icon: CheckCircle2,   hint: "HIGH confidence, in Nexus",        live: summary.confirmed > 0 },
            { label: "Rejected",      value: summary.rejected.toLocaleString(),    tone: "muted", icon: Slash,         hint: "Kept for audit trail" },
            { label: "Missing data",  value: summary.missing.toLocaleString(),     tone: "crit", icon: Receipt,        hint: "Quantity / mapping absent" },
          ] satisfies RibbonSegmentData[]
        }
      />

      {/* Filters — toolbar pattern, denser than a free-floating form. */}
      <SectionCard
        eyebrow="Filters"
        title="Narrow the queue"
        subtitle="All filters are query-string driven and bookmarkable."
        tone="muted"
        actions={
          <Link href="/invoice-allocations" className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline">
            Reset
          </Link>
        }
      >
        <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end" method="get">
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
      </SectionCard>

      {/* Master-detail grid: queue on the left, review panel on the right. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-6 items-start">
        <SectionCard
          eyebrow="Queue"
          title="Invoice lines"
          subtitle={
            filteredLines.length === 0
              ? hasAnyData
                ? "No invoice lines match the current filters."
                : undefined
              : `Showing ${filteredLines.length} of ${lineRows.length} line${lineRows.length === 1 ? "" : "s"}.`
          }
          tone="muted"
          pad="tight"
        >
          {filteredLines.length === 0 ? (
            hasAnyData ? (
              <DataEmptyState
                icon={Filter}
                title="No invoice lines match these filters"
                body="Adjust the filters above, or reset to see every invoice line."
                action={
                  <Link
                    href="/invoice-allocations"
                    className="text-[12px] font-medium text-brand-800 hover:text-brand-700 underline-offset-2 hover:underline"
                  >
                    Reset filters →
                  </Link>
                }
              />
            ) : (
              <DataEmptyState
                icon={Inbox}
                title="No Zoho invoice lines available yet. Invoice rows arrive via the apply phase."
                body="Once invoice lines are seeded, every line surfaces here and the suggestion engine can be invoked per-line."
                tone="muted"
              />
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
                            <StatusBadge tone={statusTone as "good" | "warn" | "info" | "muted"}>
                              {lineStatus}
                            </StatusBadge>
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
                                <StatusBadge key={w} tone="warn" icon={AlertTriangle}>
                                  {w}
                                </StatusBadge>
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
        </SectionCard>

        {/* Review panel — sticky on the right at lg+, full-width below. */}
        <div className="lg:sticky lg:top-6">
          {detail.line ? (
            <SectionCard
              eyebrow={`Review · ${detail.line.invoiceNumber ?? "(no number)"}`}
              title={detail.line.itemName}
              subtitle={
                <>
                  Confirmed rows become the bridge for Nexus invoice → batch lookup.
                  Customer-scope responses never expose supplier lot, internal
                  receipt, raw bag QR, operator, or machine details.
                </>
              }
              tone="info"
              actions={
                <Link
                  href="/invoice-allocations"
                  className="text-[11px] font-medium text-text-muted hover:text-text underline-offset-2 hover:underline"
                >
                  Close
                </Link>
              }
            >
              <FieldGroup
                columns={2}
                rows={
                  [
                    { label: "Invoice", value: detail.line.invoiceNumber, mono: true },
                    { label: "Invoice date", value: fmtDate(detail.line.invoiceDate), mono: true },
                    { label: "Customer", value: detail.line.customerName },
                    {
                      label: "Invoice qty",
                      value: `${detail.line.quantity ?? "?"} ${detail.line.unit ?? ""}`,
                      mono: true,
                    },
                    { label: "SKU", value: detail.line.sku, mono: true },
                    { label: "Zoho item id", value: detail.line.zohoItemId, mono: true },
                  ] satisfies FieldRow[]
                }
              />

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
            </SectionCard>
          ) : (
            <RecordCard as="div" tone="muted" className="px-5 py-6">
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
            </RecordCard>
          )}
        </div>
      </div>
    </CommandShell>
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
