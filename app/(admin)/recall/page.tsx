// LOT-1D — Recall Passport search page.
//
// Six search axes per LOT-1A §3.1:
//   supplier lot, internal receipt #, raw bag QR, finished lot trace
//   code, product+date range, customer+date range.
//
// Renders one full recall passport per query: raw bag → workflow bag
// → finished lot → outputs / packaging lots / QC events / shipments
// / customers. Missing links are surfaced honestly via warnings +
// missingLinks fields — never invented.

import Link from "next/link";
import { ArrowRight, Search, AlertTriangle } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { customers, products } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getRecallPassport,
  type RecallPassport,
  type RecallSearchInput,
  type RecallSearchKind,
} from "@/lib/production/recall-passport-loaders";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const SEARCH_KIND_LABELS: Record<RecallSearchKind, string> = {
  supplier_lot: "Supplier lot number",
  internal_receipt_number: "Internal receipt number",
  raw_bag_qr: "Raw bag QR (BAG-…)",
  finished_lot_trace_code: "Finished lot trace code (FL-…)",
  product_date_range: "Product + produced-on date range",
  customer_date_range: "Customer + shipped date range",
};

const SEARCH_KIND_HINTS: Record<RecallSearchKind, string> = {
  supplier_lot:
    "Manufacturer / vendor lot number from the raw-bag intake. Partial match supported.",
  internal_receipt_number:
    "Receipt-pad code stamped on the bag at intake (e.g. PO123-R1-B2-7).",
  raw_bag_qr:
    "Luma-issued raw-bag QR string (BAG-<uuid>). Distinct from production QR cards.",
  finished_lot_trace_code:
    "Customer-facing code printed on the master case / display (e.g. FL-2026-001).",
  product_date_range:
    "Show every finished lot for a product within a packed-date window.",
  customer_date_range:
    "Show every finished lot shipped to a customer within a date window.",
};

function parseInput(sp: Record<string, string | undefined>): RecallSearchInput | null {
  const kind = (sp.kind ?? "") as RecallSearchKind;
  switch (kind) {
    case "supplier_lot":
    case "internal_receipt_number":
    case "raw_bag_qr":
    case "finished_lot_trace_code": {
      const value = (sp.value ?? "").trim();
      if (value.length === 0) return null;
      return { kind, value };
    }
    case "product_date_range": {
      const productId = (sp.productId ?? "").trim();
      const fromDate = (sp.fromDate ?? "").trim();
      const toDate = (sp.toDate ?? "").trim();
      if (!productId || !fromDate || !toDate) return null;
      return { kind, productId, fromDate, toDate };
    }
    case "customer_date_range": {
      const customerId = (sp.customerId ?? "").trim();
      const fromDate = (sp.fromDate ?? "").trim();
      const toDate = (sp.toDate ?? "").trim();
      if (!customerId || !fromDate || !toDate) return null;
      return { kind, customerId, fromDate, toDate };
    }
    default:
      return null;
  }
}

function formatDate(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

export default async function RecallPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireSession();
  const sp = await searchParams;
  const input = parseInput(sp);
  const currentKind = (sp.kind as RecallSearchKind | undefined) ?? "supplier_lot";

  // Light option lists for the product / customer dropdowns.
  const [productOptions, customerOptions] = await Promise.all([
    db
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .orderBy(products.name),
    db
      .select({
        id: customers.id,
        customerCode: customers.customerCode,
        name: customers.name,
      })
      .from(customers)
      .where(eq(customers.active, true))
      .orderBy(customers.name),
  ]);

  const passport = input ? await getRecallPassport(input) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recall passport"
        description="Six-axis lookup across raw bags, finished lots, packaging, QC, and shipments. Missing links are shown honestly — nothing is invented."
      />

      <SearchPanel
        currentKind={currentKind}
        currentValue={sp.value ?? ""}
        currentProductId={sp.productId ?? ""}
        currentCustomerId={sp.customerId ?? ""}
        currentFrom={sp.fromDate ?? ""}
        currentTo={sp.toDate ?? ""}
        products={productOptions}
        customers={customerOptions}
      />

      {!input ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              Pick a search kind above and enter a value. The passport will
              surface every linked raw bag, finished lot, packaging lot,
              QC event, and shipment in one view.
            </p>
          </CardContent>
        </Card>
      ) : passport == null || (passport.rawBags.length === 0 && passport.finishedLots.length === 0) ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              No matches for the supplied input. Confirm the spelling and
              try a partial match.
            </p>
          </CardContent>
        </Card>
      ) : (
        <RecallPassportView passport={passport} />
      )}
    </div>
  );
}

function SearchPanel({
  currentKind,
  currentValue,
  currentProductId,
  currentCustomerId,
  currentFrom,
  currentTo,
  products,
  customers,
}: {
  currentKind: RecallSearchKind;
  currentValue: string;
  currentProductId: string;
  currentCustomerId: string;
  currentFrom: string;
  currentTo: string;
  products: Array<{ id: string; name: string; sku: string }>;
  customers: Array<{ id: string; customerCode: string; name: string }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Search</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="get" className="space-y-3 text-sm">
          <label className="block">
            <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
              Search kind
            </span>
            <select
              name="kind"
              defaultValue={currentKind}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
            >
              {(Object.keys(SEARCH_KIND_LABELS) as RecallSearchKind[]).map((k) => (
                <option key={k} value={k}>
                  {SEARCH_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <span className="block mt-1 text-[11px] text-text-muted">
              {SEARCH_KIND_HINTS[currentKind]}
            </span>
          </label>

          {currentKind === "supplier_lot" ||
          currentKind === "internal_receipt_number" ||
          currentKind === "raw_bag_qr" ||
          currentKind === "finished_lot_trace_code" ? (
            <label className="block">
              <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                Value
              </span>
              <input
                name="value"
                defaultValue={currentValue}
                placeholder={
                  currentKind === "supplier_lot"
                    ? "e.g. HN-LOT-12345"
                    : currentKind === "internal_receipt_number"
                      ? "e.g. PO123-R1-B2-7"
                      : currentKind === "raw_bag_qr"
                        ? "e.g. BAG-<uuid>"
                        : "e.g. FL-2026-001"
                }
                className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-[12px]"
              />
            </label>
          ) : null}

          {currentKind === "product_date_range" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  Product
                </span>
                <select
                  name="productId"
                  defaultValue={currentProductId}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                >
                  <option value="">— Select product —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  From (produced on)
                </span>
                <input
                  type="date"
                  name="fromDate"
                  defaultValue={currentFrom}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                />
              </label>
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  To (produced on)
                </span>
                <input
                  type="date"
                  name="toDate"
                  defaultValue={currentTo}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                />
              </label>
            </div>
          )}

          {currentKind === "customer_date_range" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  Customer
                </span>
                <select
                  name="customerId"
                  defaultValue={currentCustomerId}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                >
                  <option value="">— Select customer —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.customerCode} · {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  From (shipped at)
                </span>
                <input
                  type="date"
                  name="fromDate"
                  defaultValue={currentFrom}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                />
              </label>
              <label className="block">
                <span className="text-text-muted text-[11px] font-semibold uppercase tracking-wider">
                  To (shipped at)
                </span>
                <input
                  type="date"
                  name="toDate"
                  defaultValue={currentTo}
                  className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5"
                />
              </label>
            </div>
          )}

          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-slate-800"
          >
            <Search className="h-3.5 w-3.5" />
            Run recall lookup
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

function RecallPassportView({ passport }: { passport: RecallPassport }) {
  return (
    <div className="space-y-4">
      <Summary passport={passport} />
      {(passport.warnings.length > 0 || passport.missingLinks.length > 0) && (
        <WarningsCard passport={passport} />
      )}
      <RawBagsCard passport={passport} />
      <WorkflowCard passport={passport} />
      <OutputsCard passport={passport} />
      <PackagingCard passport={passport} />
      <QcCard passport={passport} />
      <ShipmentsCard passport={passport} />
    </div>
  );
}

function ConfBadge({ value }: { value: string }) {
  const map: Record<string, string> = {
    HIGH: "bg-emerald-100 text-emerald-900 border-emerald-300",
    MEDIUM: "bg-amber-100 text-amber-900 border-amber-300",
    LOW: "bg-orange-100 text-orange-900 border-orange-300",
    MISSING: "bg-slate-200 text-slate-700 border-slate-300",
  };
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wider ${map[value] ?? map.MISSING}`}
    >
      {value}
    </span>
  );
}

function Summary({ passport }: { passport: RecallPassport }) {
  const lotCount = passport.finishedLots.length;
  const bagCount = passport.rawBags.length;
  const lot = passport.finishedLots[0];
  const supplierLots = Array.from(
    new Set(
      passport.rawBags
        .map((b) => b.supplierLotNumber)
        .filter((v): v is string => !!v),
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Recall passport
          <span className="ml-2">
            <ConfBadge value={passport.confidence} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Stat label="Finished lots" value={String(lotCount)} />
        <Stat label="Raw bags" value={String(bagCount)} />
        <Stat
          label="Supplier lots"
          value={supplierLots.length > 0 ? supplierLots.join(", ") : "—"}
        />
        <Stat
          label="Trace code"
          value={lot?.traceCode ?? lot?.finishedLotNumber ?? "—"}
        />
        <Stat label="Product" value={lot?.productName ?? "—"} />
        <Stat label="Packed at" value={formatDate(lot?.packedAt)} />
        <Stat label="Shipments" value={String(passport.shipmentLinks.length)} />
        <Stat label="QC events" value={String(passport.qcEvents.length)} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

function WarningsCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          Warnings and missing links
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-[12px]">
        {passport.warnings.map((w, i) => (
          <p key={`w-${i}`} className="text-amber-800">
            {w}
          </p>
        ))}
        {passport.missingLinks.map((m, i) => (
          <p key={`m-${i}`} className="text-slate-700 italic">
            {m}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function RawBagsCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Raw material / receiving ({passport.rawBags.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.rawBags.length === 0 ? (
          <p className="text-sm text-text-muted">
            No raw bags matched this search axis.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Internal receipt</th>
                  <th className="text-left p-2">Bag QR</th>
                  <th className="text-left p-2">Vendor barcode</th>
                  <th className="text-left p-2">Supplier lot</th>
                  <th className="text-left p-2">Receive</th>
                  <th className="text-right p-2">Declared</th>
                  <th className="text-right p-2">Current</th>
                  <th className="text-right p-2">Weight (g)</th>
                  <th className="text-left p-2">Received</th>
                </tr>
              </thead>
              <tbody>
                {passport.rawBags.map((b) => (
                  <tr key={b.id} className="border-t border-border/40">
                    <td className="p-2 font-mono">
                      {b.internalReceiptNumber ?? (
                        <span className="text-amber-800">missing</span>
                      )}
                    </td>
                    <td className="p-2 font-mono">
                      {b.bagQrCode ?? (
                        <span className="text-amber-800">legacy / missing</span>
                      )}
                    </td>
                    <td className="p-2 font-mono text-text-muted">
                      {b.vendorBarcode ?? "—"}
                    </td>
                    <td className="p-2 font-mono">
                      {b.supplierLotNumber ?? "—"}
                    </td>
                    <td className="p-2">
                      {b.receiveName ?? "—"}
                      {b.boxNumber != null ? ` · B${b.boxNumber}` : ""}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(b.declaredPillCount)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(b.pillCount)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(b.weightGrams)}
                    </td>
                    <td className="p-2 text-text-muted">
                      {formatDate(b.receivedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Production genealogy ({passport.workflowBags.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.workflowBags.length === 0 ? (
          <p className="text-sm text-text-muted">
            No workflow bags linked to the matched finished lots.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {passport.workflowBags.map((wb) => (
              <li
                key={wb.id}
                className="flex items-center justify-between gap-2 text-[12px]"
              >
                <span>
                  <span className="font-mono">
                    {wb.receiptNumber ?? wb.id.slice(0, 8)}
                  </span>
                  <span className="text-text-muted">
                    {" "}
                    · started {formatDate(wb.startedAt)}
                    {wb.finalizedAt
                      ? ` · finalized ${formatDate(wb.finalizedAt)}`
                      : " · not finalized"}
                  </span>
                </span>
                <Link
                  href={`/genealogy/${wb.id}`}
                  className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-text-muted hover:bg-page"
                >
                  Open genealogy <ArrowRight className="h-3 w-3" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function OutputsCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finished output ({passport.outputs.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.outputs.length === 0 ? (
          <p className="text-sm text-text-muted">
            No projected outputs. Finished lot may exist without
            displays / cases yet — the projector skips zero counts
            rather than fabricating rows.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Type</th>
                  <th className="text-right p-2">Quantity</th>
                  <th className="text-left p-2">Unit</th>
                  <th className="text-left p-2">Trace printed</th>
                  <th className="text-left p-2">Print payload</th>
                </tr>
              </thead>
              <tbody>
                {passport.outputs.map((o) => (
                  <tr key={o.id} className="border-t border-border/40">
                    <td className="p-2">{o.outputType}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(o.quantity)}
                    </td>
                    <td className="p-2">{o.unit}</td>
                    <td className="p-2 font-mono">
                      {o.traceCodePrinted ?? "—"}
                    </td>
                    <td className="p-2 text-[10px] font-mono text-text-muted">
                      {JSON.stringify(o.printPayload).slice(0, 80)}
                      {JSON.stringify(o.printPayload).length > 80 ? "…" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PackagingCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Packaging / material ({passport.packagingLots.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.packagingLots.length === 0 ? (
          <p className="text-sm text-text-muted">
            No packaging-lot linkage projected. Either the workflow
            bags consumed materials without packaging_lot_id stamped
            on the events, or the projector hasn't run yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Material</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-left p-2">Roll #</th>
                  <th className="text-right p-2">Qty used</th>
                  <th className="text-left p-2">Unit</th>
                  <th className="text-left p-2">Confidence</th>
                  <th className="text-left p-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {passport.packagingLots.map((pl) => (
                  <tr key={pl.id} className="border-t border-border/40">
                    <td className="p-2">{pl.materialName ?? pl.packagingLotId.slice(0, 8)}</td>
                    <td className="p-2 text-text-muted">{pl.materialKind ?? "—"}</td>
                    <td className="p-2 font-mono">{pl.rollNumber ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(pl.quantityUsed)}
                    </td>
                    <td className="p-2">{pl.unit ?? "—"}</td>
                    <td className="p-2">
                      <ConfBadge value={pl.confidence} />
                    </td>
                    <td className="p-2 text-[10px] text-text-muted">{pl.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QcCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>QC events ({passport.qcEvents.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.qcEvents.length === 0 ? (
          <p className="text-sm text-text-muted">
            No damage / rework / scrap / correction events linked to
            these finished lots.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Event type</th>
                  <th className="text-left p-2">Occurred</th>
                  <th className="text-left p-2">Event id</th>
                </tr>
              </thead>
              <tbody>
                {passport.qcEvents.map((q) => (
                  <tr key={q.id} className="border-t border-border/40">
                    <td className="p-2 font-mono">{q.eventType}</td>
                    <td className="p-2 text-text-muted">
                      {formatDate(q.occurredAt)}
                    </td>
                    <td className="p-2 font-mono text-[10px] text-text-muted">
                      {q.workflowEventId.slice(0, 8)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ShipmentsCard({ passport }: { passport: RecallPassport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipments / customers ({passport.shipmentLinks.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {passport.shipmentLinks.length === 0 ? (
          <p className="text-sm text-text-muted">
            No shipment / customer linkage recorded yet. (Recall
            lookup may still surface the rest of the chain.)
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Customer</th>
                  <th className="text-left p-2">Carrier</th>
                  <th className="text-left p-2">Tracking</th>
                  <th className="text-right p-2">Qty</th>
                  <th className="text-left p-2">Unit</th>
                  <th className="text-left p-2">Shipped</th>
                </tr>
              </thead>
              <tbody>
                {passport.shipmentLinks.map((s) => (
                  <tr key={s.id} className="border-t border-border/40">
                    <td className="p-2">
                      {s.customerName ?? (
                        <span className="text-text-muted">—</span>
                      )}
                      {s.customerCode ? (
                        <span className="text-text-muted">
                          {" "}
                          · {s.customerCode}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2">{s.carrier ?? "—"}</td>
                    <td className="p-2 font-mono">{s.trackingNumber ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">
                      {formatNumber(s.quantity)}
                    </td>
                    <td className="p-2">{s.unit ?? "—"}</td>
                    <td className="p-2 text-text-muted">
                      {formatDate(s.shippedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
