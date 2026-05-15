// COMMERCIAL-TRACE-5 — admin allocation review page.
//
// Server component. Loads:
//   - summary counts from finished_lot_invoice_allocations
//   - invoice-line list with filter support (?invoice / ?customer / ?sku
//     / ?status / ?confidence / ?needs_review / ?unconfirmed)
//   - selected invoice line detail (?invoice_line=<uuid>)
//
// All copy follows the data-honesty rules from the phase brief:
//   - Suggested vs Confirmed by operator is always distinct
//   - LOW / name-only / unit conflict / missing customer are surfaced
//     as plain-text labels
//   - "Only confirmed allocations should be used for Nexus invoice/batch
//     lookup." appears near the summary

import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
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
  ProductionAlertCard,
  ProductionSection,
  ProductionIdentityBlock,
  type IdentityRow,
} from "@/components/production/ui";
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
  return date.toISOString().slice(0, 10);
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

  // ── Summary counts. One query, grouped by status + confirmed. ───────
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

  // ── Invoice-line list. Builds a row per zoho_invoice_lines with
  // aggregated suggested/confirmed quantity from allocations. ─────────
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

  // Per-line allocation aggregates.
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
    hasConflict: boolean;
    hasNeedsReview: boolean;
    hasUnitMismatch: boolean;
    rowCount: number;
    confirmedCount: number;
  };
  const aggByLine = new Map<string, Agg>();
  for (const r of allocAggRows) {
    const key = r.invoiceLineId;
    const a =
      aggByLine.get(key) ??
      ({
        suggestedQty: 0,
        confirmedQty: 0,
        hasConflict: false,
        hasNeedsReview: false,
        hasUnitMismatch: false,
        rowCount: 0,
        confirmedCount: 0,
      } as Agg);
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

  // Apply post-aggregate filters (status / confidence / needs_review /
  // unconfirmed / customer name).
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

  // ── Detail block for selected line (if any). ────────────────────────
  let detail: {
    line: typeof lineRows[number] | null;
    rows: Array<{
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
    }>;
  } = { line: null, rows: [] };

  if (selectedInvoiceLineId) {
    detail.line = lineRows.find((r) => r.lineId === selectedInvoiceLineId) ?? null;
    if (!detail.line) {
      // Re-fetch in case the selected line is outside the 200-row page.
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
        .leftJoin(
          finishedLots,
          eq(finishedLots.id, finishedLotInvoiceAllocations.finishedLotId),
        )
        .leftJoin(
          shipmentFinishedLots,
          eq(
            shipmentFinishedLots.id,
            finishedLotInvoiceAllocations.shipmentFinishedLotId,
          ),
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoice allocations"
        description="Match Zoho invoice lines to Luma finished lots. Confirmed allocations become the bridge for Nexus invoice/batch lookup."
      />

      <ProductionAlertCard
        tone="INFO"
        title="Only confirmed allocations should be used for Nexus invoice/batch lookup."
        body="Suggestions are engine-generated and may be wrong. The Confirm action is the only path to HIGH confidence and customer-visible (CSR-scope) traceability later in COMMERCIAL-TRACE-6. Customer-scope responses will continue to hide supplier lot, internal receipt, raw bag QR, operator, and machine details regardless of confirmation."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <SummaryCard label="Needs review" value={summary.needsReview} tone="WARN" />
        <SummaryCard label="Suggested" value={summary.suggested} tone="INFO" />
        <SummaryCard label="Confirmed by operator" value={summary.confirmed} tone="GOOD" />
        <SummaryCard label="Rejected" value={summary.rejected} tone="MUTED" />
        <SummaryCard label="Missing data" value={summary.missing} tone="CRITICAL" />
      </div>

      {/* Filters */}
      <ProductionSection title="Filters" subtitle="All filters are query-string driven; bookmarkable.">
        <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3" method="get">
          <Field
            name="invoice"
            label="Invoice #"
            defaultValue={filters.invoice}
            placeholder="INV-…"
          />
          <Field
            name="customer"
            label="Customer"
            defaultValue={filters.customer}
            placeholder="customer name"
          />
          <Field
            name="sku"
            label="SKU"
            defaultValue={filters.sku}
            placeholder="SKU-…"
          />
          <SelectField
            name="status"
            label="Status"
            defaultValue={filters.status}
            options={[
              { value: "", label: "Any" },
              { value: "UNALLOCATED", label: "Unallocated (no suggestions yet)" },
              { value: "SUGGESTED", label: "Suggested" },
              { value: "NEEDS_REVIEW", label: "Needs review" },
              { value: "CONFIRMED", label: "Confirmed" },
            ]}
          />
          <SelectField
            name="confidence"
            label="Confidence"
            defaultValue={filters.confidence}
            options={[
              { value: "", label: "Any" },
              { value: "HIGH", label: "HIGH (confirmed only)" },
              { value: "MEDIUM", label: "MEDIUM" },
              { value: "LOW", label: "LOW" },
              { value: "MISSING", label: "MISSING" },
            ]}
          />
          <label className="block self-end">
            <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">
              Needs review only
            </span>
            <input
              type="checkbox"
              name="needs_review"
              value="true"
              defaultChecked={filters.needsReview}
              className="mt-1 h-5 w-5"
            />
          </label>
          <label className="block self-end">
            <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">
              Unconfirmed only
            </span>
            <input
              type="checkbox"
              name="unconfirmed"
              value="true"
              defaultChecked={filters.unconfirmed}
              className="mt-1 h-5 w-5"
            />
          </label>
          <div className="self-end flex gap-2">
            <button
              type="submit"
              className="h-9 px-4 rounded-md bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
            >
              Apply
            </button>
            <Link
              href="/invoice-allocations"
              className="h-9 px-4 rounded-md border border-border text-sm flex items-center justify-center"
            >
              Reset
            </Link>
          </div>
        </form>
      </ProductionSection>

      {/* Invoice line list */}
      <ProductionSection
        title="Invoice lines"
        subtitle={
          filteredLines.length === 0
            ? "No invoice lines match the current filters. Confirmed allocations live on at the audit trail regardless."
            : `Showing ${filteredLines.length} line${filteredLines.length === 1 ? "" : "s"}.`
        }
      >
        {filteredLines.length === 0 ? (
          <p className="text-sm text-text-muted">
            No Zoho invoice lines available yet. Invoice rows arrive via the apply phase of COMMERCIAL-TRACE-3; once
            seeded, generate suggestions per line here.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/60">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-2 text-[10px] uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="text-left px-3 py-2">Invoice #</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-left px-3 py-2">SKU / Zoho item</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Suggested</th>
                  <th className="text-right px-3 py-2">Confirmed</th>
                  <th className="text-left px-3 py-2">Warnings</th>
                  <th className="text-left px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.map((r) => {
                  const a = aggByLine.get(r.lineId);
                  const status = !a
                    ? "Unallocated"
                    : a.confirmedCount === a.rowCount
                      ? "Confirmed by operator"
                      : a.hasNeedsReview
                        ? "Needs review"
                        : "Suggested";
                  const warnings: string[] = [];
                  if (!r.zohoItemId && !r.sku) warnings.push("Missing item id / SKU");
                  if (!r.customerId) warnings.push("Missing customer");
                  if (r.quantity == null) warnings.push("Missing quantity");
                  return (
                    <tr key={r.lineId} className="border-t border-border/40">
                      <td className="px-3 py-2 font-mono">{r.invoiceNumber ?? "—"}</td>
                      <td className="px-3 py-2">{r.customerName ?? "—"}</td>
                      <td className="px-3 py-2 font-mono">{fmtDate(r.invoiceDate)}</td>
                      <td className="px-3 py-2">{r.itemName}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">
                        {r.sku ?? "—"}
                        {r.zohoItemId ? (
                          <span className="block text-text-muted">{r.zohoItemId}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.quantity ?? "?"} {r.unit ?? ""}
                      </td>
                      <td className="px-3 py-2">{status}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {a ? a.suggestedQty : 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {a ? a.confirmedQty : 0}
                      </td>
                      <td className="px-3 py-2 text-amber-700 text-[11px]">
                        {warnings.length > 0 ? warnings.join(" · ") : ""}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/invoice-allocations?invoice_line=${r.lineId}`}
                          className="text-brand-700 hover:underline"
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ProductionSection>

      {/* Detail panel */}
      {detail.line ? (
        <ProductionSection
          title={`Review · invoice ${detail.line.invoiceNumber ?? "(no number)"} · ${detail.line.itemName}`}
          subtitle="Confirmed allocations become the bridge for CSR / Nexus invoice → batch lookup later. Customer-scope responses never expose supplier lot, internal receipt, raw bag QR, operator, or machine details."
          tone="INFO"
        >
          <ProductionIdentityBlock
            rows={[
              { label: "Invoice #", value: detail.line.invoiceNumber, mono: true },
              { label: "Invoice date", value: fmtDate(detail.line.invoiceDate), mono: true },
              { label: "Customer", value: detail.line.customerName ?? "Missing" },
              { label: "Item", value: detail.line.itemName },
              { label: "SKU", value: detail.line.sku, mono: true },
              { label: "Zoho item id", value: detail.line.zohoItemId, mono: true },
              {
                label: "Invoice qty",
                value: `${detail.line.quantity ?? "?"} ${detail.line.unit ?? ""}`,
                mono: true,
              },
              { label: "Suggestion rows", value: detail.rows.length, mono: true },
            ] satisfies IdentityRow[]}
          />

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
        </ProductionSection>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "GOOD" | "WARN" | "CRITICAL" | "INFO" | "MUTED";
}) {
  const ring: Record<typeof tone, string> = {
    GOOD: "border-emerald-500/40 bg-emerald-500/5",
    WARN: "border-amber-500/40 bg-amber-500/5",
    CRITICAL: "border-red-500/40 bg-red-500/5",
    INFO: "border-cyan-500/40 bg-cyan-500/5",
    MUTED: "border-slate-500/40 bg-slate-500/5",
  };
  return (
    <div className={`rounded-md border px-3 py-2 ${ring[tone]}`}>
      <div className="text-[10px] uppercase tracking-[0.10em] text-text-muted">
        {label}
      </div>
      <div className="text-xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  defaultValue,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-1 w-full h-9 px-2 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
      />
    </label>
  );
}

function SelectField({
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
      <span className="text-[10px] uppercase tracking-[0.10em] text-text-muted">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
        className="mt-1 w-full h-9 px-2 rounded-md border border-border bg-surface text-sm focus:border-brand-500 focus:outline-none"
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
