"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { syncPurchaseOrdersFromZohoAction } from "./actions";
import type { PoSyncResult } from "@/lib/zoho/po-sync";

export function SyncPoButton() {
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<PoSyncResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  function handleSync() {
    setLastError(null);
    startTransition(async () => {
      const res = await syncPurchaseOrdersFromZohoAction();
      if (res.ok) {
        setLastResult(res.result);
        setLastError(null);
      } else {
        setLastError(res.error);
        setLastResult(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={handleSync}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
        {isPending ? "Syncing..." : "Sync POs from Zoho"}
      </button>

      {lastResult && (
        <p className="text-[10px] text-text-muted">
          {lastResult.fetched} POs · {lastResult.detailsFetched} details · {lastResult.lineUpserted} lines synced
          {lastResult.lineSkipped > 0 && (
            <span className="ml-1">· {lastResult.lineSkipped} skipped</span>
          )}
          {lastResult.errors.length > 0 && (
            <span className="text-warn-700 ml-1">· {lastResult.errors.length} error{lastResult.errors.length !== 1 ? "s" : ""}</span>
          )}
        </p>
      )}

      {lastError && (
        <p className="text-[10px] text-danger-700">{lastError}</p>
      )}
    </div>
  );
}
