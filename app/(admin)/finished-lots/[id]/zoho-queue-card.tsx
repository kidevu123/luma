"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, XCircle, AlertCircle, MinusCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { createZohoQueueAction } from "./zoho-enqueue-actions";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

// ─── Status chip ──────────────────────────────────────────────────────────────

function OpStatusChip({ status }: { status: ZohoAssemblyOp["status"] }) {
  const cfg: Record<ZohoAssemblyOp["status"], { cls: string; icon: React.ElementType; label: string }> = {
    PENDING:       { cls: "bg-surface-2 text-text-muted border-border/60",        icon: Clock,         label: "Pending"        },
    IN_PROGRESS:   { cls: "bg-info-50 text-info-700 border-info-500/40",          icon: Clock,         label: "In progress"    },
    SUCCEEDED:     { cls: "bg-good-50 text-good-700 border-good-500/40",          icon: CheckCircle2,  label: "Succeeded"      },
    FAILED:        { cls: "bg-danger-50 text-danger-700 border-danger-500/40",    icon: XCircle,       label: "Failed"         },
    NEEDS_MAPPING: { cls: "bg-warn-50 text-warn-700 border-warn-500/40",          icon: AlertCircle,   label: "Needs mapping"  },
    SKIPPED:       { cls: "bg-surface-2 text-text-muted border-border/60",        icon: MinusCircle,   label: "Skipped"        },
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

function KindLabel({ opKind }: { opKind: ZohoAssemblyOp["opKind"] }) {
  const labels: Record<ZohoAssemblyOp["opKind"], string> = {
    TABLET_RECEIVE:  "Tablet receive",
    UNIT_ASSEMBLE:   "Unit assembly",
    DISPLAY_ASSEMBLE:"Display assembly",
    CASE_ASSEMBLE:   "Case assembly",
  };
  return <span className="text-xs font-medium">{labels[opKind]}</span>;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ZohoQueueCard({
  existingOps,
  lotId,
  planHasNonSkippedOps,
}: {
  existingOps: ZohoAssemblyOp[];
  lotId: string;
  planHasNonSkippedOps: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<{ enqueued: number; existing: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function handleCreate() {
    setPending(true);
    setError(null);
    setResult(null);
    const r = await createZohoQueueAction(lotId);
    setPending(false);
    if (r.error) {
      setError(r.error);
    } else {
      setResult({ enqueued: r.enqueued, existing: r.existing });
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Zoho Operation Queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {existingOps.length > 0 ? (
          <DataTable>
            <THead>
              <TR>
                <TH>Seq</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
                <TH className="text-right">Qty</TH>
                <TH>Idempotency key</TH>
              </TR>
            </THead>
            <tbody>
              {existingOps.map((op) => (
                <TR key={op.id}>
                  <TD className="tabular-nums text-xs text-text-muted">{op.opSequence ?? "—"}</TD>
                  <TD><KindLabel opKind={op.opKind} /></TD>
                  <TD><OpStatusChip status={op.status} /></TD>
                  <TD className="text-right tabular-nums font-semibold">{op.quantity.toLocaleString()}</TD>
                  <TD className="font-mono text-[10px] text-text-muted truncate max-w-[240px]">{op.idempotencyKey}</TD>
                </TR>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="text-sm text-text-muted">No operations queued yet.</p>
        )}

        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-warn-300/60 bg-warn-50 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warn-700" />
            <p className="text-[11px] text-warn-800 leading-snug">
              This creates internal Luma operation rows only. It does not send anything to Zoho.
              {existingOps.length > 0 && " Re-running is safe — existing rows are not duplicated."}
            </p>
          </div>

          <Button
            variant="secondary"
            size="sm"
            disabled={!planHasNonSkippedOps || pending}
            onClick={handleCreate}
          >
            {pending ? "Working…" : existingOps.length > 0 ? "Re-run queue creation" : "Create Zoho operation queue"}
          </Button>

          {!planHasNonSkippedOps && (
            <p className="text-xs text-text-muted">
              All planned ops are skipped — nothing to enqueue.
            </p>
          )}
        </div>

        {result && (
          <p className="text-xs text-good-700 bg-good-50 border border-good-300/60 rounded px-2 py-1">
            {result.enqueued > 0
              ? `Created ${result.enqueued} new row${result.enqueued !== 1 ? "s" : ""}.`
              : "No new rows — all already existed."}{" "}
            {result.existing > 0 && `${result.existing} already existed.`}
          </p>
        )}

        {error && (
          <p className="text-xs text-danger-700 bg-danger-50 border border-danger-300/60 rounded px-2 py-1">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
