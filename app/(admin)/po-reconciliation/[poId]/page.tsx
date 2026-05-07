// Phase H.x3.5 — PO reconciliation detail.
//
// Renders six sections per the spec:
//   1. PO summary
//   2. Bag breakdown
//   3. Product / route allocation
//   4. Production cycle timeline
//   5. Supplier settlement view
//   6. Missing data / confidence panel

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  derivePoRawMaterialReconciliation,
  type RawBagReconciliation,
  type PoReconciliation,
} from "@/lib/production/po-reconciliation";
import {
  derivePoBagAllocationReport,
  derivePoSplitUsageReport,
  derivePoSupplierDisputePacket,
  type PoBagAllocationRow,
  type PoSplitUsageRow,
  type SupplierDisputePacket,
} from "@/lib/production/bag-allocation";
import type { MetricResult, Confidence } from "@/lib/production/types";

export const dynamic = "force-dynamic";

export default async function PoReconciliationDetailPage({
  params,
}: {
  params: Promise<{ poId: string }>;
}) {
  await requireAdmin();
  const { poId } = await params;
  const [recon, allocationLedger, splitUsage, disputePacket] = await Promise.all([
    derivePoRawMaterialReconciliation(poId),
    derivePoBagAllocationReport(poId),
    derivePoSplitUsageReport(poId),
    derivePoSupplierDisputePacket(poId),
  ]);
  if (!recon) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title={`PO ${recon.poNumber}`}
        description={`${recon.vendorName ?? "—"} · ${recon.bagsReceived} bag${recon.bagsReceived === 1 ? "" : "s"} · ${recon.rawItemNames.join(", ") || "—"}`}
      />

      <div className="flex justify-end">
        <Link
          href={`/po-reconciliation/${poId}/export`}
          className="text-sm rounded border border-border bg-surface hover:bg-page px-3 py-1.5"
        >
          Download CSV
        </Link>
      </div>

      <PoSummary recon={recon} />
      <BagBreakdown bags={recon.bagBreakdown} />
      <ProductAllocation allocation={recon.productAllocation} />
      <CycleTimeline tl={recon.cycleTimeline} />
      <RawBagAllocationLedger rows={allocationLedger} splitUsage={splitUsage} />
      <DisputePacketPanel packet={disputePacket} />
      <SettlementView recon={recon} />
      <MissingDataPanel recon={recon} />
    </div>
  );
}

function RawBagAllocationLedger({
  rows,
  splitUsage,
}: {
  rows: ReadonlyArray<PoBagAllocationRow>;
  splitUsage: ReadonlyArray<PoSplitUsageRow>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>5. Raw bag allocation ledger</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-text-muted">
          Each bag is a balance ledger — partial use, return to stock, and split across multiple
          products are tracked through allocation sessions and events. Bags with no ledger events
          fall back to legacy data (lazy fallback) and surface MEDIUM confidence.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-text-muted uppercase">
              <tr>
                <th className="text-left p-2">Bag #</th>
                <th className="text-left p-2">Raw item</th>
                <th className="text-left p-2">Status</th>
                <th className="text-right p-2">Vendor count</th>
                <th className="text-right p-2">Allocated</th>
                <th className="text-right p-2">Consumed</th>
                <th className="text-right p-2">Returned</th>
                <th className="text-right p-2">Open WIP</th>
                <th className="text-right p-2">Remaining</th>
                <th className="text-right p-2">Known loss</th>
                <th className="text-right p-2">Unknown var.</th>
                <th className="text-right p-2">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="p-4 text-center text-text-muted">
                    No bags found for this PO.
                  </td>
                </tr>
              ) : (
                rows.map((b) => (
                  <tr key={b.inventoryBagId} className="border-t border-border/40">
                    <td className="p-2 tabular-nums">{b.bagNumber ?? "—"}</td>
                    <td className="p-2">{b.rawItemName ?? "—"}</td>
                    <td className="p-2">
                      {b.status}
                      {b.fallbackUsed ? (
                        <span className="ml-1 text-[10px] text-amber-700">(legacy)</span>
                      ) : null}
                    </td>
                    <td className="p-2 text-right tabular-nums">{b.vendorDeclaredCount ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{b.allocatedQty}</td>
                    <td className="p-2 text-right tabular-nums">{b.consumedQty}</td>
                    <td className="p-2 text-right tabular-nums">{b.returnedQty}</td>
                    <td className="p-2 text-right tabular-nums">{b.openAllocationQty}</td>
                    <td className="p-2 text-right tabular-nums">{b.remainingQtyEstimate ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{b.knownLossQty}</td>
                    <td className="p-2 text-right tabular-nums">{b.unknownVarianceQty ?? "—"}</td>
                    <td className="p-2 text-right">{b.confidence}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {splitUsage.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] uppercase text-text-muted mb-1">PO split usage by product</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Product</th>
                    <th className="text-left p-2">Route</th>
                    <th className="text-right p-2">Bags</th>
                    <th className="text-right p-2">Consumed from PO</th>
                    <th className="text-right p-2">Finished equiv.</th>
                    <th className="text-right p-2">Damage/rework</th>
                    <th className="text-right p-2">Yield %</th>
                    <th className="text-right p-2">Share of PO %</th>
                    <th className="text-right p-2">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {splitUsage.map((s) => (
                    <tr key={`${s.productId}-${s.routeCode}`} className="border-t border-border/40">
                      <td className="p-2">
                        <div className="font-medium">{s.productName}</div>
                        <div className="text-[10px] text-text-muted font-mono">{s.productSku}</div>
                      </td>
                      <td className="p-2">{s.routeCode ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">{s.bagsTouched}</td>
                      <td className="p-2 text-right tabular-nums">{s.consumedFromPo.toLocaleString()}</td>
                      <td className="p-2 text-right tabular-nums">{s.finishedEquivalent.toLocaleString()}</td>
                      <td className="p-2 text-right tabular-nums">{s.damageRework}</td>
                      <td className="p-2 text-right tabular-nums">
                        {s.yieldPercent != null ? `${s.yieldPercent.toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {s.shareOfPoConsumed != null ? `${s.shareOfPoConsumed.toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-2 text-right">{s.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DisputePacketPanel({ packet }: { packet: SupplierDisputePacket | null }) {
  if (!packet) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>6. Vendor dispute / audit packet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-text-muted leading-relaxed">
          Plain-language summary suitable for supplier review. Numbers are accounted output and
          remaining inventory — not accusations. Settlement decisions live with the policy team,
          not in this report.
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          {packet.narrative.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <div className="grid sm:grid-cols-3 gap-2 pt-3 border-t border-border/40">
          <NumStat label="Vendor declared" m={packet.vendorDeclaredTotal} />
          <NumStat label="Received weight" m={packet.ourReceivedWeightTotal} />
          <NumStat label="Card consumption" m={packet.consumedByCard} />
          <NumStat label="Bottle consumption" m={packet.consumedByBottle} />
          <NumStat label="Variety pack consumption" m={packet.consumedByVarietyPack} />
          <NumStat label="Remaining" m={packet.remainingTotal} />
          <NumStat label="Known damage / rework" m={packet.knownDamageRework} />
          <NumStat label="Unknown variance" m={packet.unknownVariance} />
          <NumStat label="Combined confidence" m={ok(packet.combinedConfidence, "")} />
        </div>
      </CardContent>
    </Card>
  );
}

function NumStat({ label, m }: { label: string; m: MetricResult }) {
  return (
    <div className="rounded border border-border/60 bg-page px-3 py-2">
      <div className="text-[10px] uppercase text-text-muted tracking-wider">{label}</div>
      <div className="text-base font-semibold tabular-nums">{render(m)}</div>
      {m.label && m.confidence === "MISSING" ? (
        <div className="text-[11px] text-text-muted">{m.label}</div>
      ) : null}
    </div>
  );
}

function PoSummary({ recon }: { recon: PoReconciliation }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>1. PO summary</CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
        <Stat label="Bags received" m={ok(recon.bagsReceived, "")} />
        <Stat label="Vendor declared total" m={recon.vendorDeclaredTotal} />
        <Stat label="Received net weight" m={recon.receivedNetWeightTotalGrams} />
        <Stat label="Internal estimated total" m={recon.internalEstimatedTotal} />
        <Stat label="Finished equivalent" m={recon.finishedEquivalentTotal} />
        <Stat label="Known loss" m={recon.knownLossTotal} />
        <Stat label="Remaining estimate" m={recon.remainingEstimateTotal} />
        <Stat label="Unknown variance" m={recon.unknownVariance} />
        <Stat label="Variance %" m={recon.variancePercent} />
        <Stat label="Combined confidence" m={ok(recon.combinedConfidence, "")} />
      </CardContent>
    </Card>
  );
}

function BagBreakdown({ bags }: { bags: ReadonlyArray<RawBagReconciliation> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Bag breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        {bags.length === 0 ? (
          <p className="text-sm text-text-muted">No bags found for this PO.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-text-muted uppercase">
                <tr>
                  <th className="text-left p-2">Bag #</th>
                  <th className="text-left p-2">Vendor barcode</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-right p-2">Vendor count</th>
                  <th className="text-right p-2">Net weight (g)</th>
                  <th className="text-right p-2">Our estimate</th>
                  <th className="text-right p-2">Finished</th>
                  <th className="text-right p-2">Known loss</th>
                  <th className="text-right p-2">Remaining</th>
                  <th className="text-right p-2">Unknown var.</th>
                  <th className="text-right p-2">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {bags.map((b) => (
                  <tr key={b.inventoryBagId} className="border-t border-border/40">
                    <td className="p-2 tabular-nums">{b.bagNumber ?? "—"}</td>
                    <td className="p-2 font-mono text-[10px]">
                      {b.vendorBarcode ?? "—"}
                    </td>
                    <td className="p-2">{b.status}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.vendorDeclaredCount)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.receivedNetWeightGrams)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.ourEstimatedCount)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.finishedEquivalentUnits)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.knownLossUnits)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.remainingEstimate)}</td>
                    <td className="p-2 text-right tabular-nums">{render(b.unknownVariance)}</td>
                    <td className="p-2 text-right">{b.combinedConfidence}</td>
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

function ProductAllocation({
  allocation,
}: {
  allocation: PoReconciliation["productAllocation"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Product / route allocation</CardTitle>
      </CardHeader>
      <CardContent>
        {allocation.length === 0 ? (
          <p className="text-sm text-text-muted">No finished output recorded for this PO yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Product</th>
                  <th className="text-left p-2">Route</th>
                  <th className="text-right p-2">Raw consumed</th>
                  <th className="text-right p-2">Finished units</th>
                  <th className="text-right p-2">Displays</th>
                  <th className="text-right p-2">Cases</th>
                  <th className="text-right p-2">Damage/rework</th>
                  <th className="text-right p-2">Yield %</th>
                </tr>
              </thead>
              <tbody>
                {allocation.map((a) => (
                  <tr key={`${a.productId}-${a.routeCode}`} className="border-t border-border/40">
                    <td className="p-2">
                      <div className="font-medium">{a.productName}</div>
                      <div className="text-[11px] text-text-muted font-mono">{a.productSku}</div>
                    </td>
                    <td className="p-2">{a.routeCode ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{a.rawUnitsConsumed}</td>
                    <td className="p-2 text-right tabular-nums">{a.finishedUnits}</td>
                    <td className="p-2 text-right tabular-nums">{a.finishedDisplays}</td>
                    <td className="p-2 text-right tabular-nums">{a.finishedCases}</td>
                    <td className="p-2 text-right tabular-nums">{a.damageRework}</td>
                    <td className="p-2 text-right tabular-nums">
                      {a.yieldPercent != null ? `${a.yieldPercent.toFixed(1)}%` : "—"}
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

function CycleTimeline({ tl }: { tl: PoReconciliation["cycleTimeline"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>4. Production cycle timeline</CardTitle>
      </CardHeader>
      <CardContent className="grid sm:grid-cols-2 gap-3 text-sm">
        <Row label="Received at" value={tl.receivedAt ? new Date(tl.receivedAt).toLocaleString() : "—"} />
        <Row label="First production start" value={tl.firstProductionStart ? new Date(tl.firstProductionStart).toLocaleString() : "—"} />
        <Row label="Last production end" value={tl.lastProductionEnd ? new Date(tl.lastProductionEnd).toLocaleString() : "—"} />
        <Row label="Finished lots" value={String(tl.finishedLotsCount)} />
        <Row label="Active WIP bags" value={String(tl.activeWipBags)} />
      </CardContent>
    </Card>
  );
}

function SettlementView({ recon }: { recon: PoReconciliation }) {
  const s = recon.settlement;
  return (
    <Card>
      <CardHeader>
        <CardTitle>7. Supplier settlement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid sm:grid-cols-2 gap-3">
          <Row label="Vendor declared total" value={String(s.vendorDeclaredTotal ?? "—")} />
          <Row label="Accounted finished output" value={String(s.accountedFinishedOutput ?? "—")} />
          <Row label="Known losses" value={String(s.knownLosses ?? "—")} />
          <Row label="Remaining inventory" value={String(s.remainingInventory ?? "—")} />
          <Row label="Unknown variance" value={String(s.unknownVariance ?? "—")} />
        </div>
        <div className="border-t border-border/40 pt-3">
          <div className="text-[11px] uppercase text-text-muted mb-1">
            Suggested payable quantity
          </div>
          <div className="text-2xl font-semibold tabular-nums">
            {s.suggestedPayable.value != null ? s.suggestedPayable.value.toLocaleString() : "Manual review"}
          </div>
          <div className="text-xs text-text-muted mt-1">
            Source: <span className="font-mono">{s.suggestedPayable.source}</span>
            {" — "}
            {s.suggestedPayable.explanation}
          </div>
          <p className="text-[11px] text-text-muted mt-2 italic">
            This is a suggestion, not a commitment. Payment policy lives outside Luma; this report only shows what we accounted for.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function MissingDataPanel({ recon }: { recon: PoReconciliation }) {
  // Aggregate missing-input flags from each MetricResult on the PO
  // and bag-level rollups. The user can act on each.
  const issues: Array<{ source: string; label: string }> = [];
  const collect = (label: string, m: MetricResult) => {
    if (m.confidence === "MISSING") issues.push({ source: m.label ?? label, label });
  };
  collect("Vendor declared total", recon.vendorDeclaredTotal);
  collect("Internal estimated total", recon.internalEstimatedTotal);
  collect("Finished equivalent", recon.finishedEquivalentTotal);
  collect("Remaining estimate", recon.remainingEstimateTotal);
  collect("Unknown variance", recon.unknownVariance);
  for (const b of recon.bagBreakdown) {
    if (b.vendorDeclaredCount.confidence === "MISSING") {
      issues.push({ source: "Bag " + (b.bagNumber ?? b.inventoryBagId.slice(0, 8)), label: b.vendorDeclaredCount.label ?? "Vendor count missing" });
    }
    if (b.ourEstimatedCount.confidence === "MISSING") {
      issues.push({ source: "Bag " + (b.bagNumber ?? b.inventoryBagId.slice(0, 8)), label: b.ourEstimatedCount.label ?? "Internal estimate missing" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>8. Missing data / confidence</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-sm mb-2">
          Combined confidence:{" "}
          <span
            className={
              recon.combinedConfidence === "HIGH"
                ? "text-emerald-700"
                : recon.combinedConfidence === "MEDIUM"
                  ? "text-amber-700"
                  : recon.combinedConfidence === "LOW"
                    ? "text-orange-700"
                    : "text-rose-700"
            }
          >
            {recon.combinedConfidence}
          </span>
        </div>
        {issues.length === 0 ? (
          <p className="text-sm text-text-muted">All required inputs are present for this PO.</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {issues.map((i, idx) => (
              <li key={idx}>
                <span className="text-text-muted">{i.source}:</span> {i.label}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── tiny helpers ──────────────────────────────────────────────

function Stat({ label, m }: { label: string; m: MetricResult }) {
  return (
    <div className="rounded border border-border/60 bg-page px-3 py-2">
      <div className="text-[10px] uppercase text-text-muted tracking-wider">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{render(m)}</div>
      {m.label && m.confidence === "MISSING" ? (
        <div className="text-[11px] text-text-muted">{m.label}</div>
      ) : null}
      <div className="text-[10px] text-text-muted">{m.confidence}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-1.5">
      <span className="text-text-muted text-xs uppercase tracking-wider">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function render(m: MetricResult): string {
  if (m.value == null || m.confidence === "MISSING") return "—";
  if (typeof m.value === "number") {
    if (m.unit === "%") return `${m.value.toFixed(1)}%`;
    return Math.abs(m.value) < 1 ? m.value.toFixed(3) : m.value.toLocaleString();
  }
  return String(m.value);
}

function ok(value: string | number, unit: string): MetricResult {
  return { value, unit, confidence: "HIGH" as Confidence, missingInputs: [] };
}
