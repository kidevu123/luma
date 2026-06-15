// Phase H.x7 — Roll usage variance panel.

import { requireAdmin } from "@/lib/auth-guards";
import { loadRollVariancePanel } from "@/lib/production/material-panels";
import { VARIANCE_LABELS } from "@/lib/production/reconciliation-v2-loader";
import { PageHeader } from "@/components/ui/page-header";
import { MetricsTabs } from "@/components/ui/metrics-tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { formatWeightKg } from "@/lib/ui/luma-display";

export const dynamic = "force-dynamic";

export default async function RollVariancePage() {
  await requireAdmin();
  const panel = await loadRollVariancePanel();
  const s = panel.summary;

  return (
    <div className="space-y-5">
      <MetricsTabs />
      <PageHeader
        title="Roll variance"
        description="Expected usage comes from roll standards. Actual usage appears only when a weigh-back or depletion signal exists."
      />

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Rolls tracked" value={String(s.totalRolls)} />
          <Stat label="With actual usage" value={`${s.withWeighback} / ${s.totalRolls}`} />
          <Stat
            label="Total variance"
            value={s.totalVarianceGrams != null ? formatWeightKg(s.totalVarianceGrams) : "Missing"}
          />
          <Stat label="Rolls > 5% variance" value={String(s.rollsOver5Pct)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Detail</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.rows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No rolls tracked yet. Variance appears only after real roll usage rows exist.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Roll</th>
                    <th className="text-left p-2">Role</th>
                    <th className="text-left p-2">Machine</th>
                    <th className="text-right p-2">Expected</th>
                    <th className="text-right p-2">Actual</th>
                    <th className="text-right p-2">Variance</th>
                    <th className="text-left p-2">Severity</th>
                    <th className="text-left p-2">Estimated vs actual</th>
                    <th className="text-left p-2">Source</th>
                    <th className="text-left p-2">Conf.</th>
                    <th className="text-left p-2">Alerts</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.rows.map((r) => (
                    <tr key={r.packagingLotId} className="border-t border-border/40">
                      <td className="p-2">{r.rollNumber ?? r.packagingLotId.slice(0, 8)}</td>
                      <td className="p-2">{r.materialRole ?? "Missing"}</td>
                      <td className="p-2">{r.machineName ?? "Unassigned"}</td>
                      <td className="p-2 text-right tabular-nums">
                        {r.expectedUsedGrams != null ? formatWeightKg(r.expectedUsedGrams) : "Roll standard missing"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.actualUsedGrams != null ? formatWeightKg(r.actualUsedGrams) : "Not weighed back"}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {r.varianceGrams != null ? formatWeightKg(r.varianceGrams) : "Missing"}
                      </td>
                      <td className="p-2"><SeverityBadge severity={r.varianceSeverity} /></td>
                      <td className="p-2 text-[11px] text-text-muted">{r.estimateActualLabel}</td>
                      <td className="p-2 font-mono text-[10px]">{r.sourceSystem}</td>
                      <td className="p-2"><ConfidenceBadge confidence={r.confidence} /></td>
                      <td className="p-2 text-[10px] text-text-muted">
                        {r.warnings.length > 0 ? r.warnings.join(", ") : "None"}
                      </td>
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
          <CardTitle>PT-6 variance clarity</CardTitle>
        </CardHeader>
        <CardContent>
          {panel.reconciliationAlerts.length === 0 ? (
            <p className="text-sm text-text-muted">
              No PT-6 v2 material variance rows currently require attention.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase">
                  <tr>
                    <th className="text-left p-2">Material</th>
                    <th className="text-left p-2">Scope</th>
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
                          <td className="p-2">{row.materialName ?? row.materialSku ?? "Unknown material"}</td>
                          <td className="p-2">{row.scopeType}</td>
                          <td className="p-2">
                            <div>{VARIANCE_LABELS[v.kind].title}</div>
                            <div className="text-[10px] text-text-muted">
                              {VARIANCE_LABELS[v.kind].subtitle}
                            </div>
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {v.value} {v.unit}
                          </td>
                          <td className="p-2 text-[11px] text-text-muted">{v.severity}</td>
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase text-text-subtle tracking-wider font-semibold">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-text-strong">{value}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "MISSING" }) {
  const cls =
    severity === "HIGH"    ? "bg-crit-50 text-crit-700 border-crit-500/40" :
    severity === "MEDIUM"  ? "bg-warn-50 text-warn-700 border-warn-500/40" :
    severity === "LOW"     ? "bg-warn-50 text-warn-700 border-warn-500/40" :
    severity === "MISSING" ? "bg-muted-50 text-muted-700 border-muted-500/40" :
                             "bg-good-50 text-good-700 border-good-500/40";
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {severity}
    </span>
  );
}
