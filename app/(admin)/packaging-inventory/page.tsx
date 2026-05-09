// Phase H.x7 — Packaging inventory panel.

import { requireAdmin } from "@/lib/auth-guards";
import { loadPackagingInventoryPanel } from "@/lib/production/material-panels";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";

export const dynamic = "force-dynamic";

export default async function PackagingInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const panel = await loadPackagingInventoryPanel(undefined, sp);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging inventory"
        description="Read-only view of received material lots. Source system, receipt truth, weights, status, and confidence are surfaced honestly."
      />

      <Card>
        <CardHeader>
          <CardTitle>Status breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.statusCounts.length === 0 ? (
            <p className="text-sm text-text-muted">No lots received yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {panel.statusCounts.map((s) => (
                <span
                  key={s.status}
                  className="rounded border border-border/60 bg-page px-3 py-1 text-xs font-medium tabular-nums"
                >
                  <span className="text-text-muted uppercase mr-1">{s.status}</span>
                  {s.n}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By material kind</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.kindCounts.length === 0 ? (
            <p className="text-sm text-text-muted">No packaging materials configured.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-text-muted text-xs uppercase">
                  <tr>
                    <th className="text-left p-2">Kind</th>
                    <th className="text-right p-2">Lots</th>
                    <th className="text-right p-2">Total units</th>
                    <th className="text-right p-2">Total g (rolls)</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.kindCounts.map((k) => (
                    <tr key={k.kind} className="border-t border-border/40">
                      <td className="p-2">{k.kind}</td>
                      <td className="p-2 text-right tabular-nums">{k.lots}</td>
                      <td className="p-2 text-right tabular-nums">{k.totalUnits ?? "Missing"}</td>
                      <td className="p-2 text-right tabular-nums">{k.totalGrams ?? "Missing"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lots</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.lots.length === 0 ? (
            <p className="text-sm text-text-muted">No lots received yet for the current filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Lot / roll / box</th>
                    <th className="text-left p-2">Material</th>
                    <th className="text-left p-2">Kind</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-right p-2">On hand</th>
                    <th className="text-right p-2">Estimated remaining</th>
                    <th className="text-left p-2">Receipt truth</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Conf.</th>
                    <th className="text-left p-2">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.lots.map((l) => (
                    <tr key={l.lotId} className="border-t border-border/40">
                      <td className="p-2">
                        <div className="font-mono text-[10px]">{l.lotId.slice(0, 8)}</div>
                        <div className="text-text-muted">
                          {l.rollNumber
                            ? `roll ${l.rollNumber}`
                            : l.boxNumber
                              ? `box ${l.boxNumber}`
                              : l.supplierLotNumber
                                ? `lot ${l.supplierLotNumber}`
                                : "No roll or box"}
                        </div>
                      </td>
                      <td className="p-2">
                        <div>{l.materialName}</div>
                        <div className="font-mono text-[10px] text-text-muted">{l.materialSku}</div>
                      </td>
                      <td className="p-2">{l.materialKind}</td>
                      <td className="p-2">{l.status}</td>
                      <td className="p-2 text-right tabular-nums">
                        {l.qtyOnHand} {l.uom}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {l.currentWeightGramsEstimate != null
                          ? `${l.currentWeightGramsEstimate} g`
                          : l.netWeightGrams != null
                            ? `${l.netWeightGrams} g`
                            : l.acceptedQuantity != null
                              ? `${l.acceptedQuantity} ${l.uom}`
                              : "Missing"}
                      </td>
                      <td className="p-2">
                        <div>{l.receiptTruthLabel}</div>
                        <div className="text-[10px] text-text-muted">
                          declared {l.declaredQuantity ?? "Missing"} · counted {l.countedQuantity ?? "Missing"}
                        </div>
                      </td>
                      <td className="p-2">
                        <div className="font-mono text-[10px]">{l.sourceSystem}</div>
                        <div className="text-[10px] text-text-muted">
                          {l.receiptNumber ?? l.externalPoId ?? "Local only"}
                        </div>
                      </td>
                      <td className="p-2">
                        <ConfidenceBadge confidence={l.confidence} />
                      </td>
                      <td className="p-2 text-[10px] text-text-muted">
                        {l.warnings.length > 0 ? l.warnings.join(", ") : "None"}
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
