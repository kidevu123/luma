// PT-4D — Cycle-count / supervisor adjustment form for a single
// packaging_lots row. See ../actions.ts for the rules: never
// overwrites original receipt fields, fires
// PACKAGING_RECEIPT_ADJUSTED + (CYCLE_COUNT_VARIANCE if delta != 0),
// raises lot.confidence to HIGH for current state.

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { eq, sql, desc } from "drizzle-orm";
import {
  packagingLots,
  packagingMaterials,
  materialInventoryEvents,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { adjustPackagingLotAction } from "../actions";
import { ADJUST_REASON_LABELS, ADJUST_REASON_OPTIONS } from "../constants";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdjustPackagingLotPage({
  params,
}: {
  params: Promise<{ lotId: string }>;
}) {
  await requireAdmin();
  const { lotId } = await params;

  const [row] = await db
    .select({
      id: packagingLots.id,
      materialSku: packagingMaterials.sku,
      materialName: packagingMaterials.name,
      uom: packagingMaterials.uom,
      supplier: packagingLots.supplier,
      boxNumber: packagingLots.boxNumber,
      supplierLotNumber: packagingLots.supplierLotNumber,
      declaredQuantity: packagingLots.declaredQuantity,
      countedQuantity: packagingLots.countedQuantity,
      acceptedQuantity: packagingLots.acceptedQuantity,
      qtyOnHand: packagingLots.qtyOnHand,
      confidence: packagingLots.confidence,
      sourceSystem: packagingLots.sourceSystem,
      packtrackPoId: packagingLots.packtrackPoId,
      packtrackReceiptId: packagingLots.packtrackReceiptId,
      receivedAt: packagingLots.receivedAt,
    })
    .from(packagingLots)
    .innerJoin(
      packagingMaterials,
      eq(packagingMaterials.id, packagingLots.packagingMaterialId),
    )
    .where(eq(packagingLots.id, lotId));
  if (!row) notFound();

  // Adjustment history for context.
  const history = await db
    .select({
      id: materialInventoryEvents.id,
      eventType: materialInventoryEvents.eventType,
      payload: materialInventoryEvents.payload,
      occurredAt: materialInventoryEvents.occurredAt,
    })
    .from(materialInventoryEvents)
    .where(
      sql`${materialInventoryEvents.packagingLotId} = ${lotId}
          AND ${materialInventoryEvents.eventType}::text IN ('PACKAGING_RECEIPT_ADJUSTED','PACKAGING_VARIANCE_RECORDED')`,
    )
    .orderBy(desc(materialInventoryEvents.occurredAt))
    .limit(20);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Adjust packaging lot"
        description="Cycle-count or supervisor correction. Original receipt fields are preserved; only qty_on_hand changes. Variance is logged as CYCLE_COUNT_VARIANCE — not production loss."
      />

      <Card>
        <CardHeader>
          <CardTitle>Lot summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <Row label="Material" value={`${row.materialSku} — ${row.materialName}`} />
          <Row label="Supplier" value={row.supplier ?? "—"} />
          <Row label="Box / lot" value={`${row.boxNumber ?? "—"} / ${row.supplierLotNumber ?? "—"}`} />
          <Row label="Source" value={(row.sourceSystem as string) ?? "legacy"} />
          {row.packtrackPoId && (
            <Row
              label="PackTrack"
              value={`PO ${row.packtrackPoId}${row.packtrackReceiptId ? ` · receipt ${row.packtrackReceiptId}` : ""}`}
            />
          )}
          <Row label="Received" value={row.receivedAt ? new Date(row.receivedAt as unknown as string).toLocaleString() : "—"} />
          <hr className="my-2 border-border/40" />
          <Row label="Declared (receipt-time)" value={row.declaredQuantity?.toString() ?? "—"} />
          <Row label="Counted (receipt-time)" value={row.countedQuantity?.toString() ?? "—"} />
          <Row label="Accepted (receipt-time)" value={row.acceptedQuantity?.toString() ?? "—"} />
          <Row label="Current on-hand" value={`${row.qtyOnHand} ${row.uom}`} />
          <Row label="Current confidence" value={row.confidence ?? "—"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cycle count / adjustment</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            action={async (fd) => {
              "use server";
              await adjustPackagingLotAction(fd);
            }}
            className="space-y-3 text-sm"
          >
            <input type="hidden" name="lotId" value={row.id} />
            <Field label={`Counted current quantity (in ${row.uom})`}>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                name="countedCurrentQuantity"
                required
                placeholder={`Current on-hand: ${row.qtyOnHand}`}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm tabular-nums"
              />
              <p className="text-[11px] text-text-muted mt-1">
                Enter the count from your physical inventory check. The
                difference vs. {row.qtyOnHand} on-hand will be logged as
                CYCLE_COUNT_VARIANCE.
              </p>
            </Field>
            <Field label="Reason">
              <select
                name="reason"
                required
                defaultValue=""
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              >
                <option value="" disabled>
                  — Select reason —
                </option>
                {ADJUST_REASON_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ADJUST_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes (optional)">
              <textarea
                name="notes"
                maxLength={500}
                rows={2}
                className="block w-full bg-surface border border-border/60 rounded px-2 py-2 text-sm"
              />
            </Field>
            <div className="flex gap-2">
              <button
                type="submit"
                className="rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-sm font-medium px-4 py-2"
              >
                Submit adjustment
              </button>
              <Link
                href="/packaging-receipts"
                className="rounded-lg border border-border bg-surface text-text-muted hover:text-text text-sm px-4 py-2"
              >
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Adjustment history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-text-muted">
              No prior cycle-count adjustments on this lot.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">When</th>
                    <th className="text-left p-2">Event</th>
                    <th className="text-left p-2">Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-t border-border/40">
                      <td className="p-2">
                        {h.occurredAt
                          ? new Date(h.occurredAt as unknown as string).toLocaleString()
                          : "—"}
                      </td>
                      <td className="p-2 font-mono">{String(h.eventType)}</td>
                      <td className="p-2 font-mono text-[10px]">
                        {JSON.stringify(h.payload)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="tabular-nums font-mono text-[11px]">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}
