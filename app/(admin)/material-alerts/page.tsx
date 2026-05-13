// Phase H.x7 — Material alerts panel. PT-7D — extended with shortage
// recommendations section reading from read_material_recommendations.

import { requireAdmin } from "@/lib/auth-guards";
import { loadMaterialAlertsPanel } from "@/lib/production/material-panels";
import { VARIANCE_LABELS } from "@/lib/production/reconciliation-v2-loader";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { loadMaterialRecommendations } from "@/lib/db/queries/material-recommendations";
import { ShortageRecommendationsPanel } from "./_recommendations-panel";

export const dynamic = "force-dynamic";

export default async function MaterialAlertsPage() {
  await requireAdmin();
  const [panel, recommendations] = await Promise.all([
    loadMaterialAlertsPanel(),
    loadMaterialRecommendations({ status: "ALL" }),
  ]);
  const totalAlerts =
    panel.shortages.length +
    panel.runouts.length +
    panel.held.length +
    panel.openAllocations.length +
    panel.reconciliationAlerts.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material alerts"
        description={`${totalAlerts} active alert${totalAlerts === 1 ? "" : "s"}. Read-only; alerts point to missing data or variance buckets, not automatic actions.`}
      />

      {totalAlerts === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-text-muted py-8 text-center">
              No alerts. Inventory is above par, no low remaining rolls, and no PT-6 variance rows currently require attention.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <ShortageRecommendationsPanel rows={recommendations} />

      <Card>
        <CardHeader>
          <CardTitle>Below par level ({panel.shortages.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.shortages.length === 0 ? (
            <p className="text-sm text-text-muted">
              No materials below par. Materials without a configured par level do not appear here.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Material</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-right p-2">Par level</th>
                  <th className="text-right p-2">On hand</th>
                  <th className="text-left p-2">Conf.</th>
                  <th className="text-left p-2">Warning</th>
                </tr>
              </thead>
              <tbody>
                {panel.shortages.map((s) => (
                  <tr key={s.materialId} className="border-t border-border/40">
                    <td className="p-2">{s.materialName}</td>
                    <td className="p-2">{s.materialKind}</td>
                    <td className="p-2 text-right tabular-nums">{s.parLevel} {s.uom}</td>
                    <td className="p-2 text-right tabular-nums">{s.totalOnHand ?? "Missing"} {s.uom}</td>
                    <td className="p-2"><ConfidenceBadge confidence={s.confidence} /></td>
                    <td className="p-2 text-amber-700">{s.warning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active rolls running out ({panel.runouts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.runouts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No active rolls projected to run low. Rolls with missing standards cannot project runout and surface on the roll variance panel.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Roll</th>
                  <th className="text-left p-2">Role</th>
                  <th className="text-left p-2">Machine</th>
                  <th className="text-right p-2">Current est.</th>
                  <th className="text-right p-2">Blisters left</th>
                  <th className="text-left p-2">Conf.</th>
                  <th className="text-left p-2">Warning</th>
                </tr>
              </thead>
              <tbody>
                {panel.runouts.map((r) => (
                  <tr key={r.packagingLotId} className="border-t border-border/40">
                    <td className="p-2">
                      {r.rollNumber ?? r.packagingLotId.slice(0, 8)}
                      <span className="text-[11px] text-text-muted ml-1">{r.materialName}</span>
                    </td>
                    <td className="p-2">{r.materialRole ?? "Missing"}</td>
                    <td className="p-2">{r.machineName ?? "Unassigned"}</td>
                    <td className="p-2 text-right tabular-nums">
                      {r.currentWeightGramsEstimate != null ? `${r.currentWeightGramsEstimate} g` : "Missing"}
                    </td>
                    <td className="p-2 text-right tabular-nums text-amber-700 font-semibold">
                      {r.projectedBlistersRemaining ?? "Missing"}
                    </td>
                    <td className="p-2"><ConfidenceBadge confidence={r.confidence} /></td>
                    <td className="p-2 text-amber-700">{r.warning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PT-6 material variance alerts ({panel.reconciliationAlerts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.reconciliationAlerts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No receipt, cycle-count, or consumption variance rows currently require attention.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Material</th>
                    <th className="text-left p-2">Variance type</th>
                    <th className="text-right p-2">Value</th>
                    <th className="text-left p-2">Severity</th>
                    <th className="text-left p-2">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.reconciliationAlerts.flatMap((row) =>
                    Object.values(row.variances)
                      .filter((v) => v.value != null && Math.abs(v.value) > 0.0001)
                      .map((v) => (
                        <tr key={`${row.id}-${v.kind}`} className="border-t border-border/40">
                          <td className="p-2">{row.materialName ?? row.materialSku ?? row.scopeId.slice(0, 8)}</td>
                          <td className="p-2">
                            <div>{VARIANCE_LABELS[v.kind].title}</div>
                            <div className="text-[10px] text-text-muted">{VARIANCE_LABELS[v.kind].subtitle}</div>
                          </td>
                          <td className="p-2 text-right tabular-nums">{v.value} {v.unit}</td>
                          <td className="p-2">{v.severity}</td>
                          <td className="p-2"><ConfidenceBadge confidence={v.confidence} /></td>
                        </tr>
                      )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Held / scrapped lots ({panel.held.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.held.length === 0 ? (
            <p className="text-sm text-text-muted">No held or scrapped lots.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Lot id</th>
                  <th className="text-left p-2">Material</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-right p-2">Qty on hand</th>
                  <th className="text-left p-2">Supplier</th>
                  <th className="text-left p-2">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {panel.held.map((h) => (
                  <tr key={h.lotId} className="border-t border-border/40">
                    <td className="p-2 font-mono text-[10px]">{h.lotId.slice(0, 8)}</td>
                    <td className="p-2">{h.materialName}</td>
                    <td className="p-2">{h.status}</td>
                    <td className="p-2 text-right tabular-nums">{h.qtyOnHand} {h.uom}</td>
                    <td className="p-2">{h.supplier ?? "Missing"}</td>
                    <td className="p-2"><ConfidenceBadge confidence={h.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stale open allocations ({panel.openAllocations.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.openAllocations.length === 0 ? (
            <p className="text-sm text-text-muted">
              No allocation sessions older than 12 hours.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs uppercase">
                <tr>
                  <th className="text-left p-2">Session</th>
                  <th className="text-left p-2">Inventory bag</th>
                  <th className="text-left p-2">Product</th>
                  <th className="text-right p-2">Open for</th>
                  <th className="text-left p-2">Warning</th>
                </tr>
              </thead>
              <tbody>
                {panel.openAllocations.map((a) => (
                  <tr key={a.sessionId} className="border-t border-border/40">
                    <td className="p-2 font-mono text-[10px]">{a.sessionId.slice(0, 8)}</td>
                    <td className="p-2 font-mono text-[10px]">{a.inventoryBagId.slice(0, 8)}</td>
                    <td className="p-2">{a.productName ?? "Missing"}</td>
                    <td className="p-2 text-right tabular-nums text-amber-700">{a.hoursOpen.toFixed(1)} h</td>
                    <td className="p-2 text-amber-700">{a.warning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
