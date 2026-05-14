// LOT-1E — finished-lot label preview / print view.
//
// Two template variants rendered side-by-side:
//   - CUSTOMER (default carton template)
//   - INTERNAL (admin / production-floor template)
//
// No PDF generation. Operators print the page directly (`@media print`
// styling). A larger QR-graphic pipeline is deferred per the LOT-1E
// spec — the QR payload text is rendered explicitly so a label printer
// or external QR encoder can pick it up.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import {
  finishedLots,
  finishedLotOutputs,
  finishedLotRawBags,
  inventoryBags,
  batches,
  products,
} from "@/lib/db/schema";
import {
  buildFinishedLotLabelPayload,
  buildCustomerSafeLabelPayload,
  type FinishedLotLabelPayload,
} from "@/lib/production/finished-lot-labels";
import {
  isFinishedLotSendableToNexus,
  validateNexusConfig,
} from "@/lib/integrations/nexus/finished-lots";
import {
  customers,
  shipmentFinishedLots,
} from "@/lib/db/schema";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SendToNexusButton } from "./_send-button";

export const dynamic = "force-dynamic";

export default async function FinishedLotLabelsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;

  const [lotRow] = await db
    .select({
      id: finishedLots.id,
      productId: finishedLots.productId,
      finishedLotNumber: finishedLots.finishedLotNumber,
      traceCode: finishedLots.traceCode,
      finishedLotCodeAlias: finishedLots.finishedLotCodeAlias,
      packedAt: finishedLots.packedAt,
      expiresAt: finishedLots.expiresAt,
      unitsProduced: finishedLots.unitsProduced,
      displaysProduced: finishedLots.displaysProduced,
      casesProduced: finishedLots.casesProduced,
      productName: products.name,
      productSku: products.sku,
    })
    .from(finishedLots)
    .leftJoin(products, eq(finishedLots.productId, products.id))
    .where(eq(finishedLots.id, id));
  if (!lotRow) notFound();

  const outputs = await db
    .select()
    .from(finishedLotOutputs)
    .where(eq(finishedLotOutputs.finishedLotId, id));

  // Source-bag context for the internal template — count distinct
  // (inventory_bag_id) links emitted by the LOT-1C projector. Also
  // pull a representative supplier_lot via batches (internal-only;
  // never lands on the customer template).
  const [bagCountRow] = await db
    .select({
      bagCount: sql<number>`COUNT(DISTINCT ${finishedLotRawBags.inventoryBagId})::int`,
    })
    .from(finishedLotRawBags)
    .where(eq(finishedLotRawBags.finishedLotId, id));
  const supplierLotRows = await db
    .select({
      supplierLotNumber: batches.vendorLotNumber,
    })
    .from(finishedLotRawBags)
    .leftJoin(
      inventoryBags,
      eq(finishedLotRawBags.inventoryBagId, inventoryBags.id),
    )
    .leftJoin(batches, eq(inventoryBags.batchId, batches.id))
    .where(eq(finishedLotRawBags.finishedLotId, id));
  const supplierLots = Array.from(
    new Set(
      supplierLotRows
        .map((r) => r.supplierLotNumber)
        .filter((v): v is string => !!v),
    ),
  );

  const sourceRawBagCount = bagCountRow?.bagCount ?? 0;
  const supplierLotForInternal = supplierLots.length > 0 ? supplierLots.join(", ") : null;

  const baseArgs = {
    traceCode: lotRow.traceCode,
    traceAlias: lotRow.finishedLotCodeAlias,
    productName: lotRow.productName,
    productSku: lotRow.productSku,
    packedAt: lotRow.packedAt,
    expiresAt: lotRow.expiresAt,
    internalReceiptAlias: lotRow.finishedLotCodeAlias,
    sourceRawBagCount,
    supplierLotNumber: supplierLotForInternal,
    customerSupplierLotVisible: false, // LOT-1F flips this per customer.
    confidence: "MEDIUM",
    warnings: [] as string[],
    missingLinks: [] as string[],
  };

  // If no projector-emitted outputs exist, render placeholders from
  // the raw counts on finished_lots so operators can still preview.
  const renderableOutputs =
    outputs.length > 0
      ? outputs.map((o) => ({
          outputType: o.outputType,
          quantity: o.quantity,
          unit: o.unit,
          printPayload:
            (o.printPayload as Record<string, unknown> | null) ?? null,
        }))
      : [
          ...(lotRow.unitsProduced > 0
            ? [
                {
                  outputType: "LOOSE_UNIT",
                  quantity: lotRow.unitsProduced,
                  unit: "each",
                  printPayload: null,
                },
              ]
            : []),
          ...(lotRow.displaysProduced && lotRow.displaysProduced > 0
            ? [
                {
                  outputType: "DISPLAY",
                  quantity: lotRow.displaysProduced,
                  unit: "each",
                  printPayload: null,
                },
              ]
            : []),
          ...(lotRow.casesProduced && lotRow.casesProduced > 0
            ? [
                {
                  outputType: "MASTER_CASE",
                  quantity: lotRow.casesProduced,
                  unit: "each",
                  printPayload: null,
                },
              ]
            : []),
        ];

  const customerLabels: FinishedLotLabelPayload[] = renderableOutputs.map((o) =>
    buildCustomerSafeLabelPayload({ ...baseArgs, output: o }),
  );
  const internalLabels: FinishedLotLabelPayload[] = renderableOutputs.map((o) =>
    buildFinishedLotLabelPayload({ template: "INTERNAL", ...baseArgs, output: o }),
  );

  // ── Nexus handoff status ──────────────────────────────────────
  const [shipmentLink] = await db
    .select({
      shipmentFinishedLotId: shipmentFinishedLots.id,
      customerId: shipmentFinishedLots.customerId,
      nexusSentAt: shipmentFinishedLots.nexusSentAt,
      nexusLastSendError: shipmentFinishedLots.nexusLastSendError,
    })
    .from(shipmentFinishedLots)
    .where(eq(shipmentFinishedLots.finishedLotId, id));
  let customerRow:
    | {
        customerCode: string;
        name: string;
        nexusCustomerId: string | null;
        supplierLotVisible: boolean;
      }
    | null = null;
  if (shipmentLink?.customerId) {
    const [c] = await db
      .select({
        customerCode: customers.customerCode,
        name: customers.name,
        nexusCustomerId: customers.nexusCustomerId,
        supplierLotVisible: customers.supplierLotVisible,
      })
      .from(customers)
      .where(eq(customers.id, shipmentLink.customerId));
    customerRow = c ?? null;
  }
  const nexusConfig = validateNexusConfig();
  const sendability = isFinishedLotSendableToNexus({
    traceCode: lotRow.traceCode,
    nexusCustomerId: customerRow?.nexusCustomerId,
    shipmentLinkPresent: !!shipmentLink,
    configured: nexusConfig.configured,
  });

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/finished-lots/${lotRow.id}`}
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Back to finished lot
        </Link>
        <PageHeader
          title={`Labels — ${lotRow.finishedLotNumber}`}
          description="Customer template (default) and internal template, one card per output. Trace code is the customer-facing printed code; supplier lot is hidden by default."
        />
      </div>

      {renderableOutputs.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              No outputs to render. The projector emits one row per
              non-zero count (LOOSE / DISPLAY / MASTER_CASE) — when
              every count is zero or null the finished lot has nothing
              to print.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <NexusStatusCard
            sendability={sendability}
            traceCode={lotRow.traceCode}
            customer={customerRow}
            nexusConfigured={nexusConfig.configured}
            finishedLotId={lotRow.id}
            alreadySentAt={
              shipmentLink?.nexusSentAt
                ? shipmentLink.nexusSentAt.toISOString()
                : null
            }
            lastSendError={shipmentLink?.nexusLastSendError ?? null}
          />
          <Section title="Customer-facing labels">
            <LabelGrid labels={customerLabels} />
          </Section>
          <Section title="Internal / admin labels">
            <LabelGrid labels={internalLabels} />
          </Section>
        </>
      )}
    </div>
  );
}

function NexusStatusCard({
  sendability,
  traceCode,
  customer,
  nexusConfigured,
  finishedLotId,
  alreadySentAt,
  lastSendError,
}: {
  sendability: { sendable: boolean; reasons: string[] };
  traceCode: string | null;
  customer:
    | {
        customerCode: string;
        name: string;
        nexusCustomerId: string | null;
        supplierLotVisible: boolean;
      }
    | null;
  nexusConfigured: boolean;
  finishedLotId: string;
  alreadySentAt: string | null;
  lastSendError: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Nexus handoff status —{" "}
          <span
            className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wider ${
              sendability.sendable
                ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                : "border-slate-300 bg-slate-100 text-slate-700"
            }`}
          >
            {sendability.sendable ? "sendable" : "not sendable"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[12px]">
        <StatusRow
          label="Trace code"
          ok={!!(traceCode && traceCode.trim().length > 0)}
          value={traceCode ?? "missing"}
        />
        <StatusRow
          label="Customer linkage"
          ok={!!customer}
          value={
            customer
              ? `${customer.customerCode} · ${customer.name}`
              : "no shipment / customer linked"
          }
        />
        <StatusRow
          label="Nexus customer id"
          ok={!!customer?.nexusCustomerId}
          value={customer?.nexusCustomerId ?? "missing"}
        />
        <StatusRow
          label="Nexus endpoint / secret"
          ok={nexusConfigured}
          value={nexusConfigured ? "configured" : "NEXUS_FINISHED_LOT_URL / _SECRET unset"}
        />
        <StatusRow
          label="Supplier lot visible to customer"
          ok={true}
          value={
            customer?.supplierLotVisible
              ? "yes (customer opted in)"
              : "no (hidden by default)"
          }
        />
        {!sendability.sendable && sendability.reasons.length > 0 && (
          <div className="col-span-2 md:col-span-3 text-amber-800 text-[11px]">
            Blocked: {sendability.reasons.join("; ")}
          </div>
        )}
        <div className="col-span-2 md:col-span-3 pt-2 border-t border-border">
          <SendToNexusButton
            finishedLotId={finishedLotId}
            sendable={sendability.sendable}
            alreadySentAt={alreadySentAt}
            lastSendError={lastSendError}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatusRow({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="rounded border border-border bg-surface px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div
        className={`text-[12px] font-medium ${
          ok ? "text-text" : "text-amber-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function LabelGrid({ labels }: { labels: FinishedLotLabelPayload[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {labels.map((l, i) => (
        <LabelCard key={`${l.template}-${l.outputType}-${i}`} label={l} />
      ))}
    </div>
  );
}

function LabelCard({ label }: { label: FinishedLotLabelPayload }) {
  const isCustomer = label.template === "CUSTOMER";
  return (
    <div
      className={`rounded border ${
        isCustomer
          ? "border-slate-700 bg-white"
          : "border-amber-300 bg-amber-50"
      } p-3 text-xs font-mono`}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[9px] font-semibold uppercase tracking-wider ${
            isCustomer
              ? "border-slate-700 bg-slate-100 text-slate-900"
              : "border-amber-500 bg-amber-100 text-amber-900"
          }`}
        >
          {label.template}
        </span>
        <span className="text-[10px] text-text-muted">{label.outputType}</span>
      </div>

      <div className="text-[14px] font-semibold leading-tight">
        {label.productName}
      </div>
      {label.productSku && (
        <div className="text-[10px] text-text-muted">SKU: {label.productSku}</div>
      )}

      <div className="mt-2 rounded bg-slate-900 text-slate-50 px-2 py-1.5 text-center">
        <div className="text-[9px] uppercase tracking-wider text-slate-400">
          Trace code
        </div>
        <div className="text-[14px] font-bold tracking-wider">
          {label.traceCode}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Field label="Quantity" value={`${label.quantity} ${label.unit}`} />
        <Field label="Packed" value={label.packedAt ?? "missing"} />
        <Field label="Expires" value={label.expiresAt ?? "missing"} />
        <Field label="Output" value={label.outputType} />
      </div>

      {!isCustomer && (
        <div className="mt-3 pt-2 border-t border-amber-300 space-y-1 text-[10px]">
          <Field
            label="Internal alias"
            value={label.internalFields.internalReceiptAlias ?? "missing"}
          />
          <Field
            label="Source raw bags"
            value={String(label.internalFields.sourceRawBagCount)}
          />
          <Field
            label="Supplier lot"
            value={label.internalFields.supplierLotNumber ?? "hidden"}
          />
          <Field
            label="Confidence"
            value={label.internalFields.confidence}
          />
        </div>
      )}

      <div className="mt-2 text-[9px] text-text-muted">
        QR payload (text): <span className="font-mono">{label.qrPayloadText}</span>
      </div>
      {label.printPayloadSnapshot ? (
        <details className="mt-1 text-[9px] text-text-muted">
          <summary className="cursor-pointer">print_payload snapshot</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all">
            {JSON.stringify(label.printPayloadSnapshot, null, 2)}
          </pre>
        </details>
      ) : (
        <div className="mt-1 text-[9px] text-amber-800">
          print_payload missing — projector hasn't snapshotted this output yet.
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="text-[11px]">{value}</div>
    </div>
  );
}
