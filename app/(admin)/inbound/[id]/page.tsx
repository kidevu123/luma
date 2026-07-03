import { formatDateTimeEst } from "@/lib/ui/luma-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Box as BoxIcon, Truck, FileText } from "lucide-react";
import { requireSession } from "@/lib/auth-guards";
import { getReceive } from "@/lib/db/queries/receives";
import {
  listAuditLogsForInventoryBags,
  listQrCardBagEditAudits,
} from "@/lib/db/queries/audit-log";
import {
  collectQrTokensFromBagAudits,
  groupBagEditHistories,
} from "@/lib/receive/bag-edit-history";
import { db } from "@/lib/db";
import { batches, tabletTypes } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { BagEditHistoryPanel } from "./bag-edit-history-panel";
import { BagNotesCell } from "./bag-notes-cell";
import { FloorReadinessBadge } from "@/components/admin/floor-readiness-badge";
import { RepairQrReservationButton } from "./repair-qr-reservation-button";
import { RepairLostQrReservationsButton } from "./repair-lost-qr-reservations-button";
import { listLostQrReservationCandidates } from "@/lib/db/queries/lost-qr-reservations";
import { loadReceiveBagReadinessEvaluations } from "@/lib/production/floor-readiness-loaders";
import { formatBagQrForDisplay } from "@/lib/ui/format-bag-qr-display";
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
  const user = await requireSession();
  const isAdmin = user.role === "OWNER" || user.role === "ADMIN";
  const { id } = await params;
  const r = await getReceive(id);
  if (!r) notFound();

  // BATCH-LOST-QR-RESERVATION-REPAIR-1 — global count of bags whose own IDLE
  // RAW_BAG card lost its intake reservation (safe to re-reserve in one click).
  const lostQrScan = isAdmin
    ? await listLostQrReservationCandidates()
    : { safeToRepair: 0, total: 0 };

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

  const bagIds = r.bags.map((b) => b.id);
  const bagAudits = await listAuditLogsForInventoryBags(bagIds);
  const qrTokens = new Set<string>();
  for (const bag of r.bags) {
    const bagOnly = bagAudits.filter((row) => row.targetId === bag.id);
    for (const token of collectQrTokensFromBagAudits(
      bagOnly,
      bag.bagQrCode ?? null,
    )) {
      qrTokens.add(token);
    }
  }
  const qrAudits = await listQrCardBagEditAudits([...qrTokens]);
  const batchLabels = new Map(
    batchRows.map((b) => [b.id, b.batchNumber ?? b.id.slice(0, 8)]),
  );
  const readinessByBag = await loadReceiveBagReadinessEvaluations(db, bagIds);

  const bagEditHistories = groupBagEditHistories({
    bags: r.bags.map((b) => ({
      id: b.id,
      bagNumber: b.bagNumber,
      internalReceiptNumber: b.internalReceiptNumber ?? null,
      bagQrCode: b.bagQrCode ?? null,
    })),
    bagAudits,
    qrAudits,
    batchLabels,
  });

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
            <div className="flex items-center gap-2">
              {isAdmin && lostQrScan.safeToRepair > 0 ? (
                <RepairLostQrReservationsButton
                  receiveId={id}
                  safeCount={lostQrScan.safeToRepair}
                />
              ) : null}
              <Button variant="secondary" size="sm" asChild>
                <Link href={`/inbound/${id}/edit`}>Edit receive</Link>
              </Button>
              <StatusPill kind={r.receive.closedAt ? "neutral" : "ok"}>
                {r.receive.closedAt ? "Closed" : "Open"}
              </StatusPill>
            </div>
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
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle>Bags ({r.bags.length})</CardTitle>
              {r.receive.closedAt ? (
                <p className="text-[11px] text-text-muted max-w-[220px] text-right leading-snug">
                  Receive closed — reopen from Edit receive to add bags.
                </p>
              ) : r.boxes.length > 0 ? (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={`/inbound/${id}/add-bag`}>Add bag</Link>
                </Button>
              ) : null}
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
                      <TH>Floor QR / bag code</TH>
                      <TH>Supplier lot</TH>
                      <TH className="text-right">Declared</TH>
                      <TH className="text-right">Weight (kg)</TH>
                      <TH>Notes</TH>
                      <TH>Status</TH>
                      <TH>Floor ready</TH>
                      <TH>Edits</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {r.bags.map((bag) => {
                      const batch = bag.batchId ? byBatch.get(bag.batchId) : null;
                      const history = bagEditHistories.find((h) => h.bagId === bag.id);
                      const editCount = history?.entries.length ?? 0;
                      return (
                        <TR key={bag.id}>
                          <TD className="tabular-nums font-semibold text-xs">{bag.bagNumber}</TD>
                          <TD className="font-mono text-xs">
                            {bag.internalReceiptNumber ?? "—"}
                          </TD>
                          <TD className="text-xs">
                            {(() => {
                              const qr = formatBagQrForDisplay(bag.bagQrCode);
                              return (
                                <div className="space-y-0.5">
                                  <span
                                    className={
                                      qr.isPlaceholder
                                        ? "text-warn-700 font-medium"
                                        : "font-mono text-text-subtle"
                                    }
                                  >
                                    {qr.primary}
                                  </span>
                                  {qr.secondary ? (
                                    <span className="block font-mono text-[10px] text-text-subtle truncate max-w-[200px]">
                                      {qr.secondary}
                                    </span>
                                  ) : null}
                                </div>
                              );
                            })()}
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
                          <TD className="max-w-[160px]">
                            <BagNotesCell notes={bag.notes ?? null} />
                          </TD>
                          <TD>
                            <BagStatus status={bag.status} />
                          </TD>
                          <TD>
                            {readinessByBag.get(bag.id) ? (
                              <>
                                <FloorReadinessBadge
                                  evaluation={readinessByBag.get(bag.id)!}
                                  showAction
                                />
                                {readinessByBag
                                  .get(bag.id)!
                                  .codes.includes("BLOCKED_QR_RESERVATION_LOST") ? (
                                  <RepairQrReservationButton
                                    receiveId={r.receive.id}
                                    bagId={bag.id}
                                  />
                                ) : null}
                              </>
                            ) : (
                              <span className="text-xs text-text-muted">—</span>
                            )}
                          </TD>
                          <TD className="text-xs text-text-muted">
                            {editCount === 0 ? (
                              "No edits"
                            ) : (
                              <a
                                href={`#bag-history-${bag.id}`}
                                className="text-brand-700 hover:underline font-medium"
                              >
                                {editCount === 1 ? "1 edit" : `${editCount} edits`}
                              </a>
                            )}
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
              {r.bags.length > 0 && (
                <div id="bag-edit-history">
                  <BagEditHistoryPanel histories={bagEditHistories} />
                </div>
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
                value={formatDateTimeEst(r.receive.receivedAt as unknown as string)}
              />
              <p className="text-[11px] text-text-subtle pt-2 border-t border-border/60">
                Received lots are available for production automatically. Use Input lots to
                quarantine or hold only when material should be blocked.
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
              <BoxIcon className="h-4 w-4" /> Open input lots
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
  const labels: Record<string, string> = {
    RELEASED: "Available",
    QUARANTINE: "Blocked",
    ON_HOLD: "On hold",
    RECALLED: "Recalled",
    EXPIRED: "Expired",
    DEPLETED: "Depleted",
  };
  return (
    <StatusPill kind={map[status] ?? "neutral"}>
      {labels[status] ?? status}
    </StatusPill>
  );
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
