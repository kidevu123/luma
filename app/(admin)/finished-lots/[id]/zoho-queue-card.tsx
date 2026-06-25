"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { ZohoOpStatusChip } from "@/app/(admin)/zoho-operations/_status-chip";
import { createZohoQueueAction } from "./zoho-enqueue-actions";
import type { ZohoAssemblyOp } from "@/lib/db/schema";

function KindLabel({ opKind }: { opKind: ZohoAssemblyOp["opKind"] }) {
  const labels: Record<ZohoAssemblyOp["opKind"], string> = {
    TABLET_RECEIVE:  "Tablet receive",
    UNIT_ASSEMBLE:   "Unit assembly",
    DISPLAY_ASSEMBLE:"Display assembly",
    CASE_ASSEMBLE:   "Case assembly",
  };
  return <span className="text-xs font-medium">{labels[opKind]}</span>;
}

// ─── Status counts strip ──────────────────────────────────────────────────────

type OpStatus = ZohoAssemblyOp["status"];

const STATUS_PILL_CFG: Record<OpStatus, { cls: string; label: string }> = {
  PENDING:       { cls: "bg-surface-2 text-text-muted",              label: "Pending"       },
  IN_PROGRESS:   { cls: "bg-surface-2 text-text-muted",              label: "In progress"   },
  NEEDS_MAPPING: { cls: "bg-warn-100 text-warn-700",                  label: "Needs mapping" },
  FAILED:        { cls: "bg-danger-50 text-danger-700",               label: "Failed"        },
  SUCCEEDED:     { cls: "bg-good-50 text-good-700",                   label: "Succeeded"     },
  SKIPPED:       { cls: "bg-surface-2 text-text-muted",              label: "Skipped"       },
};

const STATUS_ORDER: OpStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "NEEDS_MAPPING",
  "FAILED",
  "SUCCEEDED",
  "SKIPPED",
];

function StatusCountsStrip({ ops }: { ops: ZohoAssemblyOp[] }) {
  if (ops.length === 0) return null;

  const allSucceeded = ops.every((op) => op.status === "SUCCEEDED");
  if (allSucceeded) {
    return (
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-good-50 text-good-700">
          <CheckCircle2 className="h-3 w-3" />
          All synced
        </span>
      </div>
    );
  }

  const counts = ops.reduce<Partial<Record<OpStatus, number>>>((acc, op) => {
    acc[op.status] = (acc[op.status] ?? 0) + 1;
    return acc;
  }, {});

  const pills = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {pills.map((s) => {
        const cfg = STATUS_PILL_CFG[s];
        return (
          <span
            key={s}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}
          >
            {counts[s]} {cfg.label}
          </span>
        );
      })}
    </div>
  );
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
        <StatusCountsStrip ops={existingOps} />
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
                  <TD><ZohoOpStatusChip status={op.status} /></TD>
                  <TD className="text-right tabular-nums font-semibold">{op.quantity.toLocaleString()}</TD>
                  <TD className="font-mono text-[10px] text-text-muted truncate max-w-[240px]">{op.idempotencyKey}</TD>
                </TR>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="text-sm text-text-muted">
            {existingOps.length === 0
              ? "No operations queued yet. New lots enqueue automatically on issue."
              : "No additional rows to show."}
          </p>
        )}

        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-warn-300/60 bg-warn-50 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warn-700" />
            <p className="text-[11px] text-warn-800 leading-snug">
              Issuing a lot creates internal Zoho operation rows automatically. Nothing is sent to Zoho until a worker runs.
              {existingOps.length > 0 && " Re-run queue creation is safe — existing rows are not duplicated."}
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

        <Link
          href={`/zoho-operations?lotId=${lotId}`}
          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline font-medium"
        >
          View all in Zoho Operations
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
