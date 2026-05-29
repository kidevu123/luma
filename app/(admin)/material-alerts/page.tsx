// LUMA-UI-FINAL-1 — material alerts panel.
//
// Chrome rebuilt on the standard design system.
// Data loading, loader functions, and recommendations panel unchanged.

import { requireAdmin } from "@/lib/auth-guards";
import { loadMaterialAlertsPanel } from "@/lib/production/material-panels";
import { VARIANCE_LABELS } from "@/lib/production/reconciliation-v2-loader";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { loadMaterialRecommendations } from "@/lib/db/queries/material-recommendations";
import { validatePackTrackRecommendationConfig } from "@/lib/integrations/packtrack/recommendations";
import { ShortageRecommendationsPanel } from "./_recommendations-panel";
import { PageHeader } from "@/components/ui/page-header";
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Package,
  Archive,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatGramsAsKg } from "@/lib/inbound/roll-weight";

export const dynamic = "force-dynamic";

export default async function MaterialAlertsPage() {
  await requireAdmin();
  const [panel, recommendations] = await Promise.all([
    loadMaterialAlertsPanel(),
    loadMaterialRecommendations({ status: "ALL" }),
  ]);
  const packtrackConfig = validatePackTrackRecommendationConfig();
  const totalAlerts =
    panel.shortages.length +
    panel.runouts.length +
    panel.held.length +
    panel.openAllocations.length +
    panel.reconciliationAlerts.length;

  const statusBadgeCls = (tone: "crit" | "warn") =>
    tone === "crit"
      ? "inline-flex items-center h-5 px-1.5 rounded border border-crit-500/30 bg-crit-50/80 text-crit-700 text-[10px] font-semibold uppercase tracking-wider font-mono"
      : "inline-flex items-center h-5 px-1.5 rounded border border-warn-500/30 bg-warn-50/80 text-warn-700 text-[10px] font-semibold uppercase tracking-wider font-mono";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Material alerts"
        description="Read-only. Alerts point to missing data or variance buckets — not automatic actions. Each row cites the source table so the underlying issue can be resolved directly."
      />

      {/* Stats ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5" /> Below par
          </p>
          <p className={cn("text-2xl font-mono tabular-nums mt-1", panel.shortages.length > 0 ? "text-warn-700" : "text-text-strong")}>
            {panel.shortages.length}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Materials below configured par level</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" /> Roll runouts
          </p>
          <p className={cn("text-2xl font-mono tabular-nums mt-1", panel.runouts.length > 0 ? "text-crit-700" : "text-text-strong")}>
            {panel.runouts.length}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Active rolls projected to run low</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Variance alerts
          </p>
          <p className={cn("text-2xl font-mono tabular-nums mt-1", panel.reconciliationAlerts.length > 0 ? "text-warn-700" : "text-text-strong")}>
            {panel.reconciliationAlerts.length}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">PT-6 receipt / cycle-count / consumption variance</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium flex items-center gap-1.5">
            <Archive className="h-3.5 w-3.5" /> Held / Stale
          </p>
          <p className={cn("text-2xl font-mono tabular-nums mt-1", (panel.held.length + panel.openAllocations.length) > 0 ? "text-warn-700" : "text-text-strong")}>
            {panel.held.length} / {panel.openAllocations.length}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Held lots / stale allocations</p>
        </div>
      </div>

      {totalAlerts === 0 ? (
        <div className="rounded-xl border border-good-200 bg-good-50/60 px-4 py-3 text-[12px] text-good-800 flex items-start gap-2.5">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">No active material alerts</p>
            <p className="mt-0.5">Inventory is above par, no active rolls are running low, and no PT-6 variance rows currently require attention.</p>
          </div>
        </div>
      ) : null}

      {/* Shortage recommendations from PackTrack */}
      <ShortageRecommendationsPanel
        rows={recommendations}
        packtrackConfigured={packtrackConfig.configured}
      />

      {/* Below par */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Inventory risk</p>
          <h2 className="text-sm font-semibold text-text-strong">Below par level — {panel.shortages.length}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">Materials where current on-hand quantity is below the configured par level. Materials without a par level are not listed here.</p>
        </div>
        <div className="px-4 py-4">
          {panel.shortages.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-text-muted">No materials below par</p>
              <p className="text-[12px] text-text-subtle mt-1">Materials without a configured par level do not appear here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <Th>Material</Th>
                    <Th>Kind</Th>
                    <Th align="right">Par level</Th>
                    <Th align="right">On hand</Th>
                    <Th>Confidence</Th>
                    <Th>Warning</Th>
                  </tr>
                </thead>
                <tbody>
                  {panel.shortages.map((s) => (
                    <tr
                      key={s.materialId}
                      className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                    >
                      <Td className="font-medium text-text-strong">
                        {s.materialName}
                      </Td>
                      <Td className="text-text-muted">{s.materialKind}</Td>
                      <Td align="right" className="tabular-nums font-mono">
                        {s.parLevel} {s.uom}
                      </Td>
                      <Td
                        align="right"
                        className={cn(
                          "tabular-nums font-mono font-semibold",
                          s.totalOnHand == null
                            ? "italic text-text-subtle"
                            : "text-warn-700",
                        )}
                      >
                        {s.totalOnHand ?? "Missing"} {s.uom}
                      </Td>
                      <Td>
                        <ConfidenceBadge confidence={s.confidence} />
                      </Td>
                      <Td className="text-warn-700 text-[11px]">{s.warning}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Active roll runouts */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Roll materials</p>
          <h2 className="text-sm font-semibold text-text-strong">Active rolls running out — {panel.runouts.length}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">Rolls with projected runout below the station threshold. Rolls with missing standards cannot project runout and appear on the Roll Variance panel instead.</p>
        </div>
        <div className="px-4 py-4">
          {panel.runouts.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-text-muted">No active rolls projected to run low</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <Th>Roll</Th>
                    <Th>Role</Th>
                    <Th>Machine</Th>
                    <Th align="right">Current est.</Th>
                    <Th align="right">Blisters left</Th>
                    <Th>Confidence</Th>
                    <Th>Warning</Th>
                  </tr>
                </thead>
                <tbody>
                  {panel.runouts.map((r) => (
                    <tr
                      key={r.packagingLotId}
                      className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                    >
                      <Td>
                        <span className="font-mono font-medium text-text-strong">
                          {r.rollNumber ?? r.packagingLotId.slice(0, 8)}
                        </span>
                        <span className="ml-1.5 text-[11px] text-text-muted">
                          {r.materialName}
                        </span>
                      </Td>
                      <Td className="text-text-muted">
                        {r.materialRole ?? (
                          <span className="italic text-text-subtle">Missing</span>
                        )}
                      </Td>
                      <Td className="text-text-muted">
                        {r.machineName ?? (
                          <span className="italic text-text-subtle">
                            Unassigned
                          </span>
                        )}
                      </Td>
                      <Td
                        align="right"
                        className="tabular-nums font-mono text-text-muted"
                      >
                        {formatGramsAsKg(r.currentWeightGramsEstimate)}
                      </Td>
                      <Td
                        align="right"
                        className="tabular-nums font-mono font-semibold text-crit-700"
                      >
                        {r.projectedBlistersRemaining ?? "—"}
                      </Td>
                      <Td>
                        <ConfidenceBadge confidence={r.confidence} />
                      </Td>
                      <Td className="text-warn-700 text-[11px]">{r.warning}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* PT-6 variance */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">PT-6 reconciliation</p>
          <h2 className="text-sm font-semibold text-text-strong">Material variance alerts — {panel.reconciliationAlerts.length}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">Receipt, cycle-count, and consumption variance rows. Each row carries a severity and confidence; investigate any CRITICAL or HIGH-severity row first.</p>
        </div>
        <div className="px-4 py-4">
          {panel.reconciliationAlerts.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-text-muted">No variance alerts</p>
              <p className="text-[12px] text-text-subtle mt-1">No receipt, cycle-count, or consumption variance rows currently require attention.</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[11.5px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <Th>Material</Th>
                    <Th>Variance type</Th>
                    <Th align="right">Value</Th>
                    <Th>Severity</Th>
                    <Th>Confidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {panel.reconciliationAlerts.flatMap((row) =>
                    Object.values(row.variances)
                      .filter((v) => v.value != null && Math.abs(v.value) > 0.0001)
                      .map((v) => (
                        <tr
                          key={`${row.id}-${v.kind}`}
                          className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                        >
                          <Td className="font-medium text-text-strong">
                            {row.materialName ??
                              row.materialSku ??
                              row.scopeId.slice(0, 8)}
                          </Td>
                          <Td>
                            <div className="font-medium">
                              {VARIANCE_LABELS[v.kind].title}
                            </div>
                            <div className="text-[10px] text-text-muted">
                              {VARIANCE_LABELS[v.kind].subtitle}
                            </div>
                          </Td>
                          <Td
                            align="right"
                            className="tabular-nums font-mono font-medium"
                          >
                            {v.value} {v.unit}
                          </Td>
                          <Td>
                            <SeverityBadge severity={v.severity} />
                          </Td>
                          <Td>
                            <ConfidenceBadge confidence={v.confidence} />
                          </Td>
                        </tr>
                      )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Held / scrapped */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Lot status</p>
          <h2 className="text-sm font-semibold text-text-strong">Held / scrapped lots — {panel.held.length}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">Packaging lots with status HELD or SCRAPPED. Investigate before pulling from inventory.</p>
        </div>
        <div className="px-4 py-4">
          {panel.held.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-text-muted">No held or scrapped lots</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <Th>Lot id</Th>
                    <Th>Material</Th>
                    <Th>Status</Th>
                    <Th align="right">Qty on hand</Th>
                    <Th>Supplier</Th>
                    <Th>Confidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {panel.held.map((h) => (
                    <tr
                      key={h.lotId}
                      className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                    >
                      <Td className="font-mono text-[10.5px] text-text-muted">
                        {h.lotId.slice(0, 8)}
                      </Td>
                      <Td className="font-medium text-text-strong">
                        {h.materialName}
                      </Td>
                      <Td>
                        <span className={statusBadgeCls(h.status === "SCRAPPED" ? "crit" : "warn")}>
                          {h.status}
                        </span>
                      </Td>
                      <Td align="right" className="tabular-nums font-mono">
                        {h.qtyOnHand} {h.uom}
                      </Td>
                      <Td className="text-text-muted">
                        {h.supplier ?? (
                          <span className="italic text-text-subtle">Missing</span>
                        )}
                      </Td>
                      <Td>
                        <ConfidenceBadge confidence={h.confidence} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Stale open allocations */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 bg-surface-2/40">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Allocation health</p>
          <h2 className="text-sm font-semibold text-text-strong">Stale open allocations — {panel.openAllocations.length}</h2>
          <p className="text-[11px] text-text-muted mt-0.5">Bag-allocation sessions open for more than 12 hours. These may indicate an incomplete production run or an abandoned session.</p>
        </div>
        <div className="px-4 py-4">
          {panel.openAllocations.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-text-muted">No stale allocations</p>
              <p className="text-[12px] text-text-subtle mt-1">No allocation sessions older than 12 hours.</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border/60">
                    <Th>Session</Th>
                    <Th>Inventory bag</Th>
                    <Th>Product</Th>
                    <Th align="right">Open for</Th>
                    <Th>Warning</Th>
                  </tr>
                </thead>
                <tbody>
                  {panel.openAllocations.map((a) => (
                    <tr
                      key={a.sessionId}
                      className="border-b border-border/30 hover:bg-surface-2/40 transition-colors"
                    >
                      <Td className="font-mono text-[10.5px] text-text-muted">
                        {a.sessionId.slice(0, 8)}
                      </Td>
                      <Td className="font-mono text-[10.5px] text-text-muted">
                        {a.inventoryBagId.slice(0, 8)}
                      </Td>
                      <Td className="font-medium text-text-strong">
                        {a.productName ?? (
                          <span className="italic text-text-subtle">Missing</span>
                        )}
                      </Td>
                      <Td
                        align="right"
                        className="tabular-nums font-mono font-semibold text-warn-700"
                      >
                        {a.hoursOpen.toFixed(1)} h
                      </Td>
                      <Td className="text-warn-700 text-[11px]">{a.warning}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
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

function SeverityBadge({ severity }: { severity: string | undefined }) {
  const map: Record<string, string> = {
    CRITICAL: "bg-crit-50/80 text-crit-700 border-crit-500/30",
    HIGH: "bg-warn-50/80 text-warn-700 border-warn-500/30",
    MEDIUM: "bg-info-50/80 text-info-700 border-info-500/30",
    LOW: "bg-surface-2 text-text-muted border-border",
  };
  if (!severity)
    return <span className="italic text-text-subtle text-[11px]">—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-semibold uppercase tracking-wider",
        map[severity] ?? map["LOW"],
      )}
    >
      {severity}
    </span>
  );
}
