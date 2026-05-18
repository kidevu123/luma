// LUMA-UI-FINAL-1 — Recall Passport search page.
//
// Six search axes per LOT-1A §3.1:
//   supplier lot, internal receipt #, raw bag QR, finished lot trace
//   code, product+date range, customer+date range.
//
// Chrome rebuilt on the Operations Atelier design language.
// Search logic, parseInput, getRecallPassport, and all data loading
// are unchanged.

import Link from "next/link";
import {
  ArrowRight,
  Download,
  Printer,
  Search,
  AlertTriangle,
  ScanLine,
  Package,
  Truck,
  ShieldCheck,
} from "lucide-react";
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
import {
  CommandShell,
  PageHero,
  SectionCard,
  ActionPanel,
  FieldGroup,
  DataEmptyState,
  StatusBadge,
  type FieldRow,
} from "@/components/production/luma-ui";
import { cn } from "@/lib/utils";

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
  const hasResults =
    passport != null &&
    (passport.rawBags.length > 0 || passport.finishedLots.length > 0);

  return (
    <CommandShell density="wide">
      <PageHero
        eyebrow="Traceability · Recall passport"
        title="Recall lookup."
        description="Six-axis lookup across raw bags, finished lots, packaging, QC events, and shipments. Missing links are shown honestly — nothing is invented."
        badges={[
          { label: "Six search axes", tone: "info" },
          { label: "Customer-safe export available", tone: "muted" },
        ]}
      />

      {/* Search panel */}
      <SectionCard
        eyebrow="Search"
        title="Choose a search axis"
        subtitle={SEARCH_KIND_HINTS[currentKind]}
        tone="info"
        reveal="reveal-2"
      >
        <form method="get" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="eyebrow block mb-1">Search kind</span>
              <select
                name="kind"
                defaultValue={currentKind}
                className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
              >
                {(Object.keys(SEARCH_KIND_LABELS) as RecallSearchKind[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {SEARCH_KIND_LABELS[k]}
                    </option>
                  ),
                )}
              </select>
            </label>

            {(currentKind === "supplier_lot" ||
              currentKind === "internal_receipt_number" ||
              currentKind === "raw_bag_qr" ||
              currentKind === "finished_lot_trace_code") && (
              <label className="block">
                <span className="eyebrow block mb-1">Value</span>
                <input
                  name="value"
                  defaultValue={sp.value ?? ""}
                  placeholder={
                    currentKind === "supplier_lot"
                      ? "e.g. HN-LOT-12345"
                      : currentKind === "internal_receipt_number"
                        ? "e.g. PO123-R1-B2-7"
                        : currentKind === "raw_bag_qr"
                          ? "e.g. BAG-<uuid>"
                          : "e.g. FL-2026-001"
                  }
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] font-mono text-text-strong placeholder:text-text-subtle placeholder:font-sans focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </label>
            )}
          </div>

          {currentKind === "product_date_range" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="eyebrow block mb-1">Product</span>
                <select
                  name="productId"
                  defaultValue={sp.productId ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                >
                  <option value="">— Select product —</option>
                  {productOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="eyebrow block mb-1">From (produced on)</span>
                <input
                  type="date"
                  name="fromDate"
                  defaultValue={sp.fromDate ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </label>
              <label className="block">
                <span className="eyebrow block mb-1">To (produced on)</span>
                <input
                  type="date"
                  name="toDate"
                  defaultValue={sp.toDate ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </label>
            </div>
          )}

          {currentKind === "customer_date_range" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="eyebrow block mb-1">Customer</span>
                <select
                  name="customerId"
                  defaultValue={sp.customerId ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                >
                  <option value="">— Select customer —</option>
                  {customerOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.customerCode} · {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="eyebrow block mb-1">From (shipped at)</span>
                <input
                  type="date"
                  name="fromDate"
                  defaultValue={sp.fromDate ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </label>
              <label className="block">
                <span className="eyebrow block mb-1">To (shipped at)</span>
                <input
                  type="date"
                  name="toDate"
                  defaultValue={sp.toDate ?? ""}
                  className="w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-[12.5px] text-text-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                />
              </label>
            </div>
          )}

          <div>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 hover:bg-brand-700 active:bg-brand-800 px-4 py-2 text-[12.5px] font-semibold text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
            >
              <Search className="h-3.5 w-3.5" />
              Run recall lookup
            </button>
          </div>
        </form>
      </SectionCard>

      {/* Export / print bar */}
      {input && hasResults && (
        <ExportBar
          searchParams={sp}
          firstLotId={passport!.finishedLots[0]!.id}
        />
      )}

      {/* Result states */}
      {!input ? (
        <DataEmptyState
          icon={ScanLine}
          title="Start a recall lookup"
          body="Pick a search axis above and enter a value. The passport surfaces every linked raw bag, finished lot, packaging lot, QC event, and shipment in one view."
          tone="muted"
        />
      ) : !hasResults ? (
        <DataEmptyState
          icon={Search}
          title="No matches found"
          body="No raw bags or finished lots match the supplied input. Confirm the spelling and try a partial match."
          tone="muted"
        />
      ) : (
        <RecallPassportView passport={passport!} />
      )}
    </CommandShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Export bar
// ─────────────────────────────────────────────────────────────────────

function ExportBar({
  searchParams,
  firstLotId,
}: {
  searchParams: Record<string, string | undefined>;
  firstLotId: string;
}) {
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v && v.trim().length > 0) exportParams.set(k, v);
  }
  const exportHref = `/recall/export.csv?${exportParams.toString()}`;
  const labelHref = `/finished-lots/${firstLotId}/labels`;
  return (
    <div className="flex flex-wrap gap-2">
      <Link
        href={exportHref}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface hover:bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-muted hover:text-text transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV (customer-safe)
      </Link>
      <Link
        href={`${exportHref}&customer_supplier_lot_visible=true`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-warn-500/30 bg-warn-50/60 hover:bg-warn-50 px-3 py-1.5 text-[12px] font-medium text-warn-800 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV (internal — supplier lot included)
      </Link>
      <Link
        href={labelHref}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors"
      >
        <Printer className="h-3.5 w-3.5" />
        Print labels (first matched lot)
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Passport view
// ─────────────────────────────────────────────────────────────────────

function RecallPassportView({ passport }: { passport: RecallPassport }) {
  return (
    <div className="space-y-5">
      <PassportSummary passport={passport} />
      {(passport.warnings.length > 0 || passport.missingLinks.length > 0) && (
        <WarningsSection passport={passport} />
      )}
      <RawBagsSection passport={passport} />
      <WorkflowSection passport={passport} />
      <OutputsSection passport={passport} />
      <PackagingSection passport={passport} />
      <QcSection passport={passport} />
      <ShipmentsSection passport={passport} />
    </div>
  );
}

function ConfChip({ value }: { value: string }) {
  const map: Record<string, string> = {
    HIGH: "bg-good-50/80 text-good-700 border-good-500/30",
    MEDIUM: "bg-warn-50/80 text-warn-700 border-warn-500/30",
    LOW: "bg-crit-50/80 text-crit-700 border-crit-500/30",
    MISSING: "bg-surface-2 text-text-subtle border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-semibold uppercase tracking-wider",
        map[value] ?? map["MISSING"],
      )}
    >
      {value}
    </span>
  );
}

function PassportSummary({ passport }: { passport: RecallPassport }) {
  const lot = passport.finishedLots[0];
  const supplierLots = Array.from(
    new Set(
      passport.rawBags
        .map((b) => b.supplierLotNumber)
        .filter((v): v is string => !!v),
    ),
  );
  const fields: FieldRow[] = [
    { label: "Finished lots", value: passport.finishedLots.length, mono: true },
    { label: "Raw bags", value: passport.rawBags.length, mono: true },
    {
      label: "Supplier lots",
      value: supplierLots.length > 0 ? supplierLots.join(", ") : null,
      mono: true,
    },
    {
      label: "Trace code",
      value: lot?.traceCode ?? lot?.finishedLotNumber ?? null,
      mono: true,
    },
    { label: "Product", value: lot?.productName ?? null },
    {
      label: "Packed at",
      value: lot?.packedAt ? formatDate(lot.packedAt) : null,
      mono: true,
    },
    { label: "Shipments", value: passport.shipmentLinks.length, mono: true },
    { label: "QC events", value: passport.qcEvents.length, mono: true },
  ];

  return (
    <SectionCard
      eyebrow="Recall passport"
      title="Summary"
      tone={
        passport.confidence === "HIGH"
          ? "good"
          : passport.confidence === "MEDIUM"
            ? "warn"
            : passport.confidence === "LOW"
              ? "crit"
              : "muted"
      }
      actions={<ConfChip value={passport.confidence} />}
      reveal="reveal-3"
    >
      <FieldGroup rows={fields} columns={4} />
    </SectionCard>
  );
}

function WarningsSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Traceability gaps"
      title="Warnings and missing links"
      tone="warn"
      reveal="reveal-3"
    >
      <div className="space-y-2">
        {passport.warnings.map((w, i) => (
          <div
            key={`w-${i}`}
            className="flex items-start gap-2 text-[12px] text-warn-700"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
        {passport.missingLinks.map((m, i) => (
          <div key={`m-${i}`} className="text-[12px] text-text-muted italic pl-5">
            {m}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function RawBagsSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Inbound traceability"
      title={`Raw material / receiving — ${passport.rawBags.length}`}
      tone={passport.rawBags.length > 0 ? "info" : "muted"}
      reveal="reveal-3"
    >
      {passport.rawBags.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No raw bags matched this search axis.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60">
                <Th>Internal receipt</Th>
                <Th>Bag QR</Th>
                <Th>Vendor barcode</Th>
                <Th>Supplier lot</Th>
                <Th>Receive</Th>
                <Th align="right">Declared</Th>
                <Th align="right">Current</Th>
                <Th align="right">Weight (g)</Th>
                <Th>Received</Th>
              </tr>
            </thead>
            <tbody>
              {passport.rawBags.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                >
                  <Td className="font-mono font-medium text-text-strong">
                    {b.internalReceiptNumber ?? (
                      <span className="text-warn-700 italic">missing</span>
                    )}
                  </Td>
                  <Td className="font-mono text-[10.5px] text-text-muted">
                    {b.bagQrCode ?? (
                      <span className="text-warn-700 italic">legacy / missing</span>
                    )}
                  </Td>
                  <Td className="font-mono text-[10.5px] text-text-subtle">
                    {b.vendorBarcode ?? "—"}
                  </Td>
                  <Td className="font-mono text-[11px]">
                    {b.supplierLotNumber ?? "—"}
                  </Td>
                  <Td className="text-text-muted">
                    {b.receiveName ?? "—"}
                    {b.boxNumber != null ? ` · B${b.boxNumber}` : ""}
                  </Td>
                  <Td align="right" className="tabular-nums font-mono">
                    {formatNumber(b.declaredPillCount)}
                  </Td>
                  <Td align="right" className="tabular-nums font-mono">
                    {formatNumber(b.pillCount)}
                  </Td>
                  <Td
                    align="right"
                    className="tabular-nums font-mono text-text-muted"
                  >
                    {formatNumber(b.weightGrams)}
                  </Td>
                  <Td className="text-text-muted">
                    {formatDate(b.receivedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function WorkflowSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Production genealogy"
      title={`Workflow bags — ${passport.workflowBags.length}`}
      tone={passport.workflowBags.length > 0 ? "info" : "muted"}
      reveal="reveal-4"
    >
      {passport.workflowBags.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No workflow bags linked to the matched finished lots.
        </p>
      ) : (
        <ul className="space-y-2">
          {passport.workflowBags.map((wb) => (
            <li
              key={wb.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface-2/40 px-3 py-2.5 text-[12px]"
            >
              <span>
                <span className="font-mono font-medium text-text-strong">
                  {wb.receiptNumber ?? wb.id.slice(0, 8)}
                </span>
                <span className="text-text-muted">
                  {" "}
                  · started {formatDate(wb.startedAt)}
                  {wb.finalizedAt
                    ? ` · finalized ${formatDate(wb.finalizedAt)}`
                    : (
                      <span className="text-warn-700"> · not finalized</span>
                    )}
                </span>
              </span>
              <Link
                href={`/genealogy/${wb.id}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-text-muted hover:bg-surface-2 hover:text-text transition-colors"
              >
                Open genealogy <ArrowRight className="h-3 w-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function OutputsSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Finished output"
      title={`Pack-out — ${passport.outputs.length}`}
      tone={passport.outputs.length > 0 ? "good" : "muted"}
      reveal="reveal-4"
    >
      {passport.outputs.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No projected outputs. Finished lot may exist without displays / cases
          yet — the projector skips zero counts rather than fabricating rows.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60">
                <Th>Type</Th>
                <Th align="right">Quantity</Th>
                <Th>Unit</Th>
                <Th>Trace printed</Th>
                <Th>Print payload</Th>
              </tr>
            </thead>
            <tbody>
              {passport.outputs.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                >
                  <Td className="font-medium text-text-strong">
                    {o.outputType}
                  </Td>
                  <Td align="right" className="tabular-nums font-mono">
                    {formatNumber(o.quantity)}
                  </Td>
                  <Td className="text-text-muted">{o.unit}</Td>
                  <Td className="font-mono text-[10.5px]">
                    {o.traceCodePrinted ?? "—"}
                  </Td>
                  <Td className="font-mono text-[10px] text-text-subtle">
                    {JSON.stringify(o.printPayload).slice(0, 80)}
                    {JSON.stringify(o.printPayload).length > 80 ? "…" : ""}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function PackagingSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Materials used"
      title={`Packaging / material — ${passport.packagingLots.length}`}
      tone={passport.packagingLots.length > 0 ? "info" : "muted"}
      reveal="reveal-4"
    >
      {passport.packagingLots.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No packaging-lot linkage projected. Either the workflow bags consumed
          materials without packaging_lot_id stamped on the events, or the
          projector has not run yet.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60">
                <Th>Material</Th>
                <Th>Kind</Th>
                <Th>Roll #</Th>
                <Th align="right">Qty used</Th>
                <Th>Unit</Th>
                <Th>Confidence</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {passport.packagingLots.map((pl) => (
                <tr
                  key={pl.id}
                  className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                >
                  <Td className="font-medium text-text-strong">
                    {pl.materialName ?? pl.packagingLotId.slice(0, 8)}
                  </Td>
                  <Td className="text-text-muted">{pl.materialKind ?? "—"}</Td>
                  <Td className="font-mono text-[10.5px]">
                    {pl.rollNumber ?? "—"}
                  </Td>
                  <Td align="right" className="tabular-nums font-mono">
                    {formatNumber(pl.quantityUsed)}
                  </Td>
                  <Td className="text-text-muted">{pl.unit ?? "—"}</Td>
                  <Td>
                    <ConfChip value={pl.confidence} />
                  </Td>
                  <Td className="font-mono text-[10px] text-text-subtle">
                    {pl.source}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function QcSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Quality control"
      title={`QC events — ${passport.qcEvents.length}`}
      tone={passport.qcEvents.length > 0 ? "warn" : "muted"}
      reveal="reveal-5"
    >
      {passport.qcEvents.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No damage / rework / scrap / correction events linked to these
          finished lots.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60">
                <Th>Event type</Th>
                <Th>Occurred</Th>
                <Th>Event id</Th>
              </tr>
            </thead>
            <tbody>
              {passport.qcEvents.map((q) => (
                <tr
                  key={q.id}
                  className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                >
                  <Td className="font-mono font-medium text-text-strong">
                    {q.eventType}
                  </Td>
                  <Td className="text-text-muted">
                    {formatDate(q.occurredAt)}
                  </Td>
                  <Td className="font-mono text-[10px] text-text-subtle">
                    {q.workflowEventId.slice(0, 8)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function ShipmentsSection({ passport }: { passport: RecallPassport }) {
  return (
    <SectionCard
      eyebrow="Customer traceability"
      title={`Shipments / customers — ${passport.shipmentLinks.length}`}
      tone={passport.shipmentLinks.length > 0 ? "good" : "muted"}
      reveal="reveal-5"
    >
      {passport.shipmentLinks.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">
          No shipment / customer linkage recorded yet. Recall lookup may still
          surface the rest of the chain.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60">
                <Th>Customer</Th>
                <Th>Carrier</Th>
                <Th>Tracking</Th>
                <Th align="right">Qty</Th>
                <Th>Unit</Th>
                <Th>Shipped</Th>
              </tr>
            </thead>
            <tbody>
              {passport.shipmentLinks.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                >
                  <Td className="font-medium text-text-strong">
                    {s.customerName ?? (
                      <span className="text-text-subtle">—</span>
                    )}
                    {s.customerCode ? (
                      <span className="text-text-muted ml-1.5 text-[11px]">
                        · {s.customerCode}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-text-muted">{s.carrier ?? "—"}</Td>
                  <Td className="font-mono text-[10.5px]">
                    {s.trackingNumber ?? "—"}
                  </Td>
                  <Td align="right" className="tabular-nums font-mono">
                    {formatNumber(s.quantity)}
                  </Td>
                  <Td className="text-text-muted">{s.unit ?? "—"}</Td>
                  <Td className="text-text-muted">
                    {formatDate(s.shippedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Table helpers
// ─────────────────────────────────────────────────────────────────────

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-text-subtle font-semibold",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2.5",
        align === "right" ? "text-right" : "",
        className,
      )}
    >
      {children}
    </td>
  );
}
