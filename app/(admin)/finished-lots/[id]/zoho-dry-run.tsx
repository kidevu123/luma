import { AlertCircle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  ZohoAssemblyPlanResult,
  PlanOp,
  ZohoAssemblyStatusPreview,
} from "@/lib/zoho/assembly-planner";

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: ZohoAssemblyStatusPreview }) {
  const cfg = {
    READY:        { cls: "bg-good-50 text-good-700 border-good-500/40",   icon: CheckCircle2,  label: "Ready"        },
    NEEDS_MAPPING:{ cls: "bg-warn-50 text-warn-700 border-warn-500/40",   icon: AlertCircle,   label: "Needs mapping"},
    SKIPPED:      { cls: "bg-surface-2 text-text-muted border-border/60", icon: MinusCircle,   label: "Skipped"      },
    BLOCKED:      { cls: "bg-danger-50 text-danger-700 border-danger-500/40", icon: XCircle,   label: "Blocked"      },
  }[status];
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wide ${cfg.cls}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function OverallBadge({ status }: { status: ZohoAssemblyStatusPreview }) {
  const cfg = {
    READY:        "bg-good-100 text-good-800 border-good-300",
    NEEDS_MAPPING:"bg-warn-100 text-warn-800 border-warn-300",
    SKIPPED:      "bg-surface-2 text-text-muted border-border",
    BLOCKED:      "bg-danger-100 text-danger-800 border-danger-300",
  }[status];
  const label = {
    READY:        "All ops ready",
    NEEDS_MAPPING:"Mapping required",
    SKIPPED:      "Nothing to submit",
    BLOCKED:      "Blocked",
  }[status];
  return (
    <span className={`inline-flex items-center h-6 px-2.5 rounded-full border text-[11px] font-semibold ${cfg}`}>
      {label}
    </span>
  );
}

function SourceBadge({ method }: { method: "LEDGER" | "FALLBACK" | "NONE" }) {
  const cfg = {
    LEDGER:   "bg-info-50 text-info-700 border-info-500/40",
    FALLBACK: "bg-warn-50 text-warn-700 border-warn-500/40",
    NONE:     "bg-surface-2 text-text-muted border-border/60",
  }[method];
  const label = {
    LEDGER:   "Source: allocation ledger",
    FALLBACK: "Source: batch genealogy fallback",
    NONE:     "Source: none found",
  }[method];
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium ${cfg}`}>
      {label}
    </span>
  );
}

function KindChip({ opKind }: { opKind: PlanOp["opKind"] }) {
  const cfg = {
    TABLET_RECEIVE:  "bg-info-50 text-info-700 border-info-500/40",
    UNIT_ASSEMBLE:   "bg-good-50 text-good-700 border-good-500/40",
    DISPLAY_ASSEMBLE:"bg-surface-2 text-text border-border/60",
    CASE_ASSEMBLE:   "bg-surface-2 text-text border-border/60",
  }[opKind];
  const label = {
    TABLET_RECEIVE:  "Tablet receive",
    UNIT_ASSEMBLE:   "Unit assembly",
    DISPLAY_ASSEMBLE:"Display assembly",
    CASE_ASSEMBLE:   "Case assembly",
  }[opKind];
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wide ${cfg}`}>
      {label}
    </span>
  );
}

// ─── Op detail rows ───────────────────────────────────────────────────────────

function OpRow({ op }: { op: PlanOp }) {
  const isTabletReceive = op.opKind === "TABLET_RECEIVE";

  return (
    <div className={`border-b border-border/40 last:border-0 py-3 px-4 ${op.statusPreview === "SKIPPED" ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-3 flex-wrap">
        {/* Sequence badge */}
        <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-surface-2 border border-border text-[10px] font-semibold text-text-muted flex items-center justify-center tabular-nums">
          {op.opSequence}
        </span>

        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Top line: kind + status + qty */}
          <div className="flex items-center gap-2 flex-wrap">
            <KindChip opKind={op.opKind} />
            <StatusPill status={op.statusPreview} />
            <span className="text-xs tabular-nums text-text-muted">
              {op.quantity.toLocaleString()} units
            </span>
            {isTabletReceive && op.componentRole && (
              <span className="text-[10px] font-medium text-text-muted bg-surface-2 border border-border/60 rounded px-1">
                {op.componentRole}
              </span>
            )}
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-[11px]">
            {isTabletReceive && (
              <>
                <DetailRow label="Tablet type" value={op.tabletTypeName ?? "Unknown"} />
                <DetailRow label="Zoho item ID" value={op.zohoTabletItemId ?? "—"} missing={!op.zohoTabletItemId} />
                <DetailRow label="Zoho PO ID"   value={op.zohoPoId ?? "—"}           missing={!op.zohoPoId} />
                <DetailRow label="Zoho line ID" value={op.zohoLineItemId ?? "—"}     missing={!op.zohoLineItemId} />
                {op.sourceInventoryBagId && (
                  <DetailRow label="Inv. bag" value={op.sourceInventoryBagId.slice(0, 8) + "…"} mono />
                )}
              </>
            )}
            {!isTabletReceive && (
              <DetailRow
                label="Zoho composite item"
                value={op.zohoItemId ?? "—"}
                missing={!op.zohoItemId && op.statusPreview !== "SKIPPED"}
              />
            )}
          </div>

          {/* Status reason */}
          {op.statusReason && op.statusPreview !== "SKIPPED" && (
            <p className="text-[11px] text-warn-700 leading-snug">
              {op.statusReason}
            </p>
          )}

          {/* BOM issues (assembly ops) */}
          {!isTabletReceive && op.bomIssues.length > 0 && (
            <div className="mt-1 space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-text-subtle">BOM issues</p>
              {op.bomIssues.map((bi) => (
                <p key={bi.materialId} className="text-[11px] text-warn-700">
                  {bi.materialName} — {bi.issue}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  missing,
  mono,
}: {
  label: string;
  value: string;
  missing?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-text-subtle shrink-0">{label}:</span>
      <span className={`${mono ? "font-mono" : ""} ${missing ? "text-warn-700 font-medium" : "text-text"} truncate`}>
        {value}
      </span>
    </div>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────

export function ZohoDryRunCard({ plan }: { plan: ZohoAssemblyPlanResult }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 flex-wrap">
          Zoho Assembly Plan
          <span className="text-xs font-normal text-text-muted">(dry run)</span>
          <div className="flex items-center gap-1.5 ml-auto">
            <OverallBadge status={plan.overallStatus} />
            <SourceBadge method={plan.sourceMethod} />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {/* Global issues */}
        {plan.issues.length > 0 && (
          <div className="mx-4 mb-3 rounded-lg border border-warn-300/60 bg-warn-50 px-3 py-2 space-y-1">
            {plan.issues.map((issue, i) => (
              <p key={i} className="text-[11px] text-warn-800 leading-snug">{issue}</p>
            ))}
          </div>
        )}

        {/* Ops list */}
        {plan.ops.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-text-muted">No operations planned.</div>
        ) : (
          <div className="divide-y divide-border/40">
            {plan.ops.map((op) => (
              <OpRow key={op.idempotencyKey} op={op} />
            ))}
          </div>
        )}

        <div className="px-4 py-2 border-t border-border/40 text-[10px] text-text-subtle">
          This is a read-only preview. No Zoho calls have been made. Ops are enqueued
          separately after product mappings are complete.
        </div>
      </CardContent>
    </Card>
  );
}
