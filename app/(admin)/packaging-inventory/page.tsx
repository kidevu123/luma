// Phase H.x7 — Packaging inventory panel.

import { requireAdmin } from "@/lib/auth-guards";
import { loadPackagingInventoryPanel } from "@/lib/production/material-panels";
import { PageHeader } from "@/components/ui/page-header";
import { MaterialsTabs } from "@/components/ui/materials-tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { scrapLotAction, deleteLotAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PackagingInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; showScrapped?: string; err?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const showScrapped = sp.showScrapped === "1";
  const actionError = sp.err ? decodeURIComponent(sp.err) : null;
  const panel = await loadPackagingInventoryPanel(undefined, sp);
  const visibleLots = showScrapped
    ? panel.lots
    : panel.lots.filter((l) => l.status !== "SCRAPPED");

  return (
    <div className="space-y-5">
      <MaterialsTabs />
      <PageHeader
        title="Packaging inventory"
        description="Read-only view of received material lots. Source system, receipt truth, weights, status, and confidence are surfaced honestly."
      />

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

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
            <div className="flex flex-wrap gap-2">
              {panel.kindCounts.map((k) => (
                <div
                  key={k.kind}
                  className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 min-w-[110px] ${
                    k.lots === 0
                      ? "border-border/30 bg-page opacity-40"
                      : "border-border/60 bg-surface"
                  }`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {k.kind.replace(/_/g, " ")}
                  </span>
                  <span className="text-base font-bold tabular-nums">
                    {k.lots === 0 ? "—" : k.lots}
                    <span className="text-xs font-normal text-text-muted ml-1">
                      {k.lots === 1 ? "lot" : "lots"}
                    </span>
                  </span>
                  {k.lots > 0 && (
                    <span className="text-[11px] text-text-muted tabular-nums">
                      {k.totalUnits != null
                        ? k.totalUnits.toLocaleString() + " units"
                        : k.totalGrams != null
                          ? (k.totalGrams / 1000).toFixed(1) + " kg"
                          : ""}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lots ({visibleLots.length})</CardTitle>
          <a
            href={showScrapped ? "/packaging-inventory" : "/packaging-inventory?showScrapped=1"}
            className="text-xs text-text-muted hover:text-text transition-colors"
          >
            {showScrapped ? "Hide scrapped" : "Show scrapped"}
          </a>
        </CardHeader>
        <CardContent>
          {visibleLots.length === 0 ? (
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
                    <th className="text-right p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLots.map((l) => (
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
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {l.status !== "SCRAPPED" && (
                            <form action={scrapLotAction}>
                              <input type="hidden" name="id" value={l.lotId} />
                              <button type="submit" className="text-[10px] text-text-subtle hover:text-amber-600 transition-colors">
                                Scrap
                              </button>
                            </form>
                          )}
                          <form action={deleteLotAction}>
                            <input type="hidden" name="id" value={l.lotId} />
                            <button type="submit" className="text-[10px] text-text-subtle hover:text-red-600 transition-colors">
                              Delete
                            </button>
                          </form>
                        </div>
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
