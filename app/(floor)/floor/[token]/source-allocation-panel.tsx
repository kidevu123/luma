"use client";

// P0-ALLOC-REPAIR — Station-screen panel for the current run's source
// allocation. Healthy runs get a quiet confirmation line; closed or
// missing allocations get the yellow warning with a lead repair action
// (badge code + one tap) instead of a dead-end message.

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, ShieldCheck, Wrench } from "lucide-react";
import { repairSourceAllocationAction } from "./bag-allocation-actions";
import type { SourceAllocationStatus } from "@/lib/production/source-allocation-status";

export function SourceAllocationPanel({
  token,
  stationId,
  workflowBagId,
  inventoryBagId,
  status,
}: {
  token: string;
  stationId: string;
  workflowBagId: string;
  inventoryBagId: string | null;
  status: SourceAllocationStatus;
}) {
  const router = useRouter();
  const [repairOpen, setRepairOpen] = React.useState(false);
  const [leadCode, setLeadCode] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [repaired, setRepaired] = React.useState(false);

  if (status.kind === "healthy") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700">
        <ShieldCheck className="h-3.5 w-3.5" />
        {status.message}
      </p>
    );
  }
  if (repaired) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-700">
        <ShieldCheck className="h-3.5 w-3.5" />
        Source allocation repaired — this run is back on the ledger.
      </p>
    );
  }

  async function repair() {
    if (!inventoryBagId) return;
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("stationId", stationId);
      fd.set("workflowBagId", workflowBagId);
      fd.set("inventoryBagId", inventoryBagId);
      fd.set("leadCode", leadCode.trim());
      const r = await repairSourceAllocationAction(fd);
      if (r.error) {
        setError(r.error);
      } else {
        setRepaired(true);
        setRepairOpen(false);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 space-y-2">
      <p className="flex items-start gap-1.5 text-xs text-yellow-900">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
        <span>{status.message}</span>
      </p>
      {status.repairable && inventoryBagId && !repairOpen && (
        <button
          type="button"
          onClick={() => setRepairOpen(true)}
          className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-yellow-400 bg-surface text-xs font-medium text-yellow-900"
        >
          <Wrench className="h-3.5 w-3.5" />
          {status.kind === "closed"
            ? "Lead: reopen source allocation"
            : "Lead: open/repair source allocation"}
        </button>
      )}
      {status.repairable && repairOpen && (
        <div className="space-y-2">
          <label className="block">
            <span className="block text-[11px] font-medium text-yellow-900 mb-1">
              Lead badge code
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={leadCode}
              onChange={(e) => setLeadCode(e.target.value)}
              className="block w-full h-11 px-3 rounded-lg bg-surface border border-yellow-300 text-base tabular-nums"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => setRepairOpen(false)}
              className="h-10 px-3 rounded-lg border border-border bg-surface text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || !leadCode.trim()}
              onClick={repair}
              className="h-10 px-3 rounded-lg bg-yellow-700 text-white text-xs font-semibold disabled:opacity-60"
            >
              {pending ? "Repairing…" : "Repair allocation"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
