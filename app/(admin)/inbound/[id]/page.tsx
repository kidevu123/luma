import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Box as BoxIcon, Truck, FileText } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getReceive } from "@/lib/db/queries/receives";
import { db } from "@/lib/db";
import { batches, tabletTypes } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { PageHeader, StatusPill } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function ReceiveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const r = await getReceive(id);
  if (!r) notFound();

  // Pull batches referenced by this receive's boxes so we can show
  // batch number + status next to each box without an N+1.
  const batchIds = Array.from(
    new Set([
      ...r.boxes.map((b) => b.box.defaultBatchId),
      ...r.bags.map((b) => b.batchId),
    ].filter((x): x is string => !!x)),
  );
  const batchRows = batchIds.length
    ? await db
        .select({
          id: batches.id,
          batchNumber: batches.batchNumber,
          status: batches.status,
          tabletName: tabletTypes.name,
        })
        .from(batches)
        .leftJoin(tabletTypes, eq(batches.tabletTypeId, tabletTypes.id))
        .where(inArray(batches.id, batchIds))
    : [];
  const byBatch = new Map(batchRows.map((b) => [b.id, b]));

  const totalBags = r.bags.length;
  const totalPills = r.bags.reduce((s, b) => s + (b.pillCount ?? 0), 0);
  const totalWeightKg = r.bags.reduce((s, b) => s + (b.weightGrams ?? 0), 0) / 1000;
  const availableBags = r.bags.filter((b) => b.status === "AVAILABLE").length;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/inbound"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> All receives
        </Link>
        <PageHeader
          title={r.receive.receiveName}
          description={
            r.po
              ? `PO ${r.po.poNumber}${r.po.vendorName ? ` · ${r.po.vendorName}` : ""}`
              : "Walk-in receive (no PO)"
          }
          actions={
            <StatusPill kind={r.receive.closedAt ? "neutral" : "ok"}>
              {r.receive.closedAt ? "Closed" : "Open"}
            </StatusPill>
          }
        />
      </div>

      <div className="grid lg:grid-cols-[1fr_280px] gap-5">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Boxes ({r.boxes.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {r.boxes.length === 0 ? (
                <p className="text-sm text-text-muted">No boxes on this receive.</p>
              ) : (
                <DataTable>
                  <THead>
                    <TR>
                      <TH>#</TH>
                      <TH>Tablet</TH>
                      <TH>Batch</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Bags</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {r.boxes.map(({ box, tabletName }) => {
                      const b = box.defaultBatchId
                        ? byBatch.get(box.defaultBatchId)
                        : null;
                      return (
                        <TR key={box.id}>
                          <TD className="font-mono text-xs">#{box.boxNumber}</TD>
                          <TD>{tabletName ?? "—"}</TD>
                          <TD>
                            {b ? (
                              <Link
                                href={`/batches?focus=${b.id}`}
                                className="font-mono text-xs hover:underline"
                              >
                                {b.batchNumber}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </TD>
                          <TD>
                            {b ? <BatchStatus status={b.status} /> : "—"}
                          </TD>
                          <TD className="text-right tabular-nums">{box.totalBags}</TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </DataTable>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bags ({r.bags.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {r.bags.length > 0 && (
                <p className="text-xs text-text-muted bg-surface-2 border border-border/60 rounded-md px-3 py-2 mb-4 leading-relaxed">
                  After save, use <span className="font-medium text-text">Edit bag</span> on
                  any row to correct weight (kg), QR scan token, receipt number, supplier lot,
                  or notes. QR, receipt, and lot changes require an edit reason and are written
                  to the audit log. Bags already in production can only have notes updated.
                </p>
              )}
              {r.bags.length === 0 ? (
                <p className="text-sm text-text-muted">No bags on this receive.</p>
              ) : (
                <DataTable>
                  <THead>
                    <TR>
                      <TH>Bag #</TH>
                      <TH>Receipt #</TH>
                      <TH>QR token</TH>
                      <TH>Supplier lot</TH>
                      <TH className="text-right">Declared</TH>
                      <TH className="text-right">Weight (kg)</TH>
                      <TH>Notes</TH>
                      <TH>Status</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {r.bags.map((bag) => {
                      const batch = bag.batchId ? byBatch.get(bag.batchId) : null;
                      return (
                        <TR key={bag.id}>
                          <TD className="tabular-nums font-semibold text-xs">{bag.bagNumber}</TD>
                          <TD className="font-mono text-xs">
                            {bag.internalReceiptNumber ?? "—"}
                          </TD>
                          <TD className="font-mono text-xs text-text-subtle">
                            {bag.bagQrCode ?? "—"}
                          </TD>
                          <TD className="font-mono text-xs">
                            {batch?.batchNumber ?? "—"}
                          </TD>
                          <TD className="text-right tabular-nums text-xs">
                            {bag.declaredPillCount?.toLocaleString() ?? "—"}
                          </TD>
                          <TD className="text-right tabular-nums text-xs">
                            {bag.weightGrams != null
                              ? (bag.weightGrams / 1000).toFixed(3)
                              : "—"}
                          </TD>
                          <TD className="text-xs text-text-muted max-w-[120px] truncate">
                            {bag.notes ?? "—"}
                          </TD>
                          <TD>
                            <BagStatus status={bag.status} />
                          </TD>
                          <TD className="text-right">
                            <Link
                              href={`/inbound/${r.receive.id}/bag/${bag.id}/edit`}
                              className="text-xs font-medium text-brand-700 hover:underline"
                            >
                              Edit bag
                            </Link>
                          </TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </DataTable>
              )}
            </CardContent>
          </Card>

          {r.receive.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-text-subtle" /> Notes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap text-text-muted">
                  {r.receive.notes}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-3 lg:sticky lg:top-6 self-start">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Boxes" value={r.boxes.length.toString()} />
              <Row label="Bags" value={totalBags.toLocaleString()} />
              <Row label="Available" value={availableBags.toLocaleString()} />
              <Row label="Pills (est.)" value={totalPills.toLocaleString()} />
              <Row
                label="Weight (kg)"
                value={totalWeightKg > 0 ? totalWeightKg.toFixed(3) : "—"}
              />
              <Row
                label="Received"
                value={new Date(r.receive.receivedAt as unknown as string).toLocaleString()}
              />
              <p className="text-[11px] text-text-subtle pt-2 border-t border-border/60">
                Each box created (or reused) a batch in <span className="font-mono">QUARANTINE</span>.
                Release in the Batches tab once QA signs off.
              </p>
            </CardContent>
          </Card>

          {r.shipment && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-text-subtle" /> Shipment
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-text-muted space-y-1">
                {r.shipment.carrier && <div>Carrier: {r.shipment.carrier}</div>}
                {r.shipment.trackingNumber && (
                  <div className="font-mono">{r.shipment.trackingNumber}</div>
                )}
              </CardContent>
            </Card>
          )}

          <Button asChild variant="secondary" className="w-full">
            <Link href="/batches">
              <BoxIcon className="h-4 w-4" /> Open batches
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function BatchStatus({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
    QUARANTINE: "warn",
    RELEASED: "ok",
    ON_HOLD: "warn",
    RECALLED: "danger",
    EXPIRED: "danger",
    DEPLETED: "neutral",
  };
  return <StatusPill kind={map[status] ?? "neutral"}>{status}</StatusPill>;
}

function BagStatus({ status }: { status: string }) {
  const map: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
    AVAILABLE: "ok",
    IN_USE: "info",
    EMPTIED: "neutral",
    QUARANTINED: "warn",
    VOID: "danger",
  };
  return <StatusPill kind={map[status] ?? "neutral"}>{status}</StatusPill>;
}
