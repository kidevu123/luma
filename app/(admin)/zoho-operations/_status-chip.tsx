import type * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  MinusCircle,
  XCircle,
} from "lucide-react";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

export function ZohoOpStatusChip({ status }: { status: ZohoAssemblyOp["status"] }) {
  const cfg: Record<
    ZohoAssemblyOp["status"],
    { cls: string; icon: React.ComponentType<{ className?: string }>; label: string }
  > = {
    PENDING:       { cls: "bg-surface-2 text-text-muted border-border/60",       icon: Clock,        label: "Pending"       },
    IN_PROGRESS:   { cls: "bg-info-50 text-info-700 border-info-500/40",         icon: Clock,        label: "In progress"   },
    SUCCEEDED:     { cls: "bg-good-50 text-good-700 border-good-500/40",         icon: CheckCircle2, label: "Succeeded"     },
    FAILED:        { cls: "bg-danger-50 text-danger-700 border-danger-500/40",   icon: XCircle,      label: "Failed"        },
    NEEDS_MAPPING: { cls: "bg-warn-50 text-warn-700 border-warn-500/40",         icon: AlertCircle,  label: "Needs mapping" },
    SKIPPED:       { cls: "bg-surface-2 text-text-muted border-border/60",       icon: MinusCircle,  label: "Skipped"       },
  };
  const c = cfg[status];
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-sm border text-[10px] font-semibold uppercase tracking-wide ${c.cls}`}>
      <Icon className="h-3 w-3" />
      {c.label}
    </span>
  );
}

export function ZohoOpKindChip({ opKind }: { opKind: ZohoAssemblyOp["opKind"] }) {
  const cfg: Record<ZohoAssemblyOp["opKind"], { cls: string; label: string }> = {
    TABLET_RECEIVE:   { cls: "bg-info-50 text-info-700 border-info-500/40",     label: "Tablet receive"   },
    UNIT_ASSEMBLE:    { cls: "bg-good-50 text-good-700 border-good-500/40",     label: "Unit assembly"    },
    DISPLAY_ASSEMBLE: { cls: "bg-surface-2 text-text border-border/60",         label: "Display assembly" },
    CASE_ASSEMBLE:    { cls: "bg-surface-2 text-text border-border/60",         label: "Case assembly"    },
  };
  const c = cfg[opKind];
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[10px] font-medium uppercase tracking-wide ${c.cls}`}>
      {c.label}
    </span>
  );
}
