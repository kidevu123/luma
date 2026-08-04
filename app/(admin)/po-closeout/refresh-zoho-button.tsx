"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { syncPurchaseOrdersFromZohoAction } from "../receiving/raw-bags/actions";

export function RefreshZohoButton() {
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<{ synced: number; errors: number } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const router = useRouter();

  function handleRefresh() {
    setLastError(null);
    setLastResult(null);
    startTransition(async () => {
      try {
        const res = await syncPurchaseOrdersFromZohoAction();
        if (res.ok) {
          setLastResult({ synced: res.result.fetched, errors: res.result.errors.length });
          setLastError(null);
          router.refresh();
        } else {
          setLastError(res.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(
          msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("action_id")
            ? "App updated — please refresh the page and try again."
            : `Sync failed: ${msg}`,
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={handleRefresh}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
        {isPending ? "Syncing..." : "Refresh from Zoho"}
      </button>

      {lastResult && (
        <p className="text-[10px] text-text-muted">
          Synced {lastResult.synced} PO{lastResult.synced === 1 ? "" : "s"} · {lastResult.errors} error{lastResult.errors === 1 ? "" : "s"}
        </p>
      )}

      {lastError && (
        <p className="text-[10px] text-danger-700">{lastError}</p>
      )}
    </div>
  );
}
