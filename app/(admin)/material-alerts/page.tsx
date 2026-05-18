// LUMA-UI-FINAL-1 — material alerts panel.
//
// Chrome rebuilt on the Operations Atelier design language.
// Data loading, loader functions, and recommendations panel unchanged.

import { requireAdmin } from "@/lib/auth-guards";
import { loadMaterialAlertsPanel } from "@/lib/production/material-panels";
import { VARIANCE_LABELS } from "@/lib/production/reconciliation-v2-loader";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { loadMaterialRecommendations } from "@/lib/db/queries/material-recommendations";
import { validatePackTrackRecommendationConfig } from "@/lib/integrations/packtrack/recommendations";
import { ShortageRecommendationsPanel } from "./_recommendations-panel";
import {
  CommandShell,
  PageHero,
  RibbonStrip,
  SectionCard,
  DataEmptyState,
  StatusBadge,
  type HeroBadge,
  type RibbonSegmentData,
} from "@/components/production/luma-ui";
import {
  AlertTriangle,
  CheckCircle2,
  Layers,
  Package,
  Archive,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

  const heroBadges: HeroBadge[] = [
    {
      label:
        totalAlerts === 0
          ? "No active alerts"
          : `${totalAlerts} active alert${totalAlerts === 1 ? "" : "s"}`,
      tone: totalAlerts === 0 ? "good" : totalAlerts > 3 ? "crit" : "warn",
    },
    { label: "Read-only", tone: "muted" },
  ];

  const ribbonSegments: RibbonSegmentData[] = [
    {
      label: "Below par",
      value: panel.shortages.length,
      tone: panel.shortages.length > 0 ? "warn" : "good",
      icon: Package,
      hint: "Materials below configured par level",
    },
    {
      label: "Roll runouts",
      value: panel.runouts.length,
      tone: panel.runouts.length > 0 ? "crit" : "good",
      icon: Layers,
      hint: "Active rolls projected to run low",
    },
    {
      label: "Variance alerts",
      value: panel.reconciliationAlerts.length,
      tone: panel.reconciliationAlerts.length > 0 ? "warn" : "good",
      icon: AlertTriangle,
      hint: "PT-6 receipt / cycle-count / consumption variance",
    },
    {
      label: "Held / scrapped",
      value: panel.held.length,
      tone: panel.held.length > 0 ? "warn" : "muted",
      icon: Archive,
      hint: "Lots on hold or scrapped",
    },
    {
      label: "Stale allocations",
      value: panel.openAllocations.length,
      tone: panel.openAllocations.length > 0 ? "warn" : "muted",
      icon: Clock,
      hint: "Allocation sessions open > 12 hours",
    },
  ];

  return (
    <CommandShell density="wide">
      <PageHero
        eyebrow="Management · Inventory risk"
        title="Material alerts."
        description="Read-only. Alerts point to missing data or variance buckets — not automatic actions. Each row cites the source table so the underlying issue can be resolved directly."
        badges={heroBadges}
      />

      <RibbonStrip reveal="reveal-2" segments={ribbonSegments} />

      {totalAlerts === 0 ? (
        <DataEmptyState
          icon={CheckCircle2}
          title="No active material alerts"
          body="Inventory is above par, no active rolls are running low, and no PT-6 variance rows currently require attention."
          tone="good"
        />
      ) : null}

      {/* Shortage recommendations from PackTrack */}
      <ShortageRecommendationsPanel
        rows={recommendations}
        packtrackConfigured={packtrackConfig.configured}
      />

      {/* Below par */}
      <SectionCard
        eyebrow="Inventory risk"
        title={`Below par level — ${panel.shortages.length}`}
        subtitle="Materials where current on-hand quantity is below the configured par level. Materials without a par level are not listed here."
        tone={panel.shortages.length > 0 ? "warn" : "muted"}
        reveal="reveal-3"
      >
        {panel.shortages.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">
            No materials below par. Materials without a configured par level do
            not appear here.
          </p>
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
      </SectionCard>

      {/* Active roll runouts */}
      <SectionCard
        eyebrow="Roll materials"
        title={`Active rolls running out — ${panel.runouts.length}`}
        subtitle="Rolls with projected runout below the station threshold. Rolls with missing standards cannot project runout and appear on the Roll Variance panel instead."
        tone={panel.runouts.length > 0 ? "crit" : "muted"}
        reveal="reveal-4"
      >
        {panel.runouts.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">
            No active rolls projected to run low.
          </p>
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
                      {r.currentWeightGramsEstimate != null
                        ? `${r.currentWeightGramsEstimate} g`
                        : "—"}
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
      </SectionCard>

      {/* PT-6 variance */}
      <SectionCard
        eyebrow="PT-6 reconciliation"
        title={`Material variance alerts — ${panel.reconciliationAlerts.length}`}
        subtitle="Receipt, cycle-count, and consumption variance rows. Each row carries a severity and confidence; investigate any CRITICAL or HIGH-severity row first."
        tone={panel.reconciliationAlerts.length > 0 ? "warn" : "muted"}
        reveal="reveal-4"
      >
        {panel.reconciliationAlerts.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">
            No receipt, cycle-count, or consumption variance rows currently
            require attention.
          </p>
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
      </SectionCard>

      {/* Held / scrapped */}
      <SectionCard
        eyebrow="Lot status"
        title={`Held / scrapped lots — ${panel.held.length}`}
        subtitle="Packaging lots with status HELD or SCRAPPED. Investigate before pulling from inventory."
        tone={panel.held.length > 0 ? "warn" : "muted"}
        reveal="reveal-5"
      >
        {panel.held.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">No held or scrapped lots.</p>
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
                      <StatusBadge
                        tone={h.status === "SCRAPPED" ? "crit" : "warn"}
                        mono
                      >
                        {h.status}
                      </StatusBadge>
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
      </SectionCard>

      {/* Stale open allocations */}
      <SectionCard
        eyebrow="Allocation health"
        title={`Stale open allocations — ${panel.openAllocations.length}`}
        subtitle="Bag-allocation sessions open for more than 12 hours. These may indicate an incomplete production run or an abandoned session."
        tone={panel.openAllocations.length > 0 ? "warn" : "muted"}
        reveal="reveal-5"
      >
        {panel.openAllocations.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">
            No allocation sessions older than 12 hours.
          </p>
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
      </SectionCard>
    </CommandShell>
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
