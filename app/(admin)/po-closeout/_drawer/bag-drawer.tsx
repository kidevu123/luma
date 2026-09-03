"use client";

// CLOSEOUT-DRAWER-1 — drawer body for one bag row. Lazily loads the live
// read-only detail aggregate when opened, and refetches after every action
// (the panels call onDone). Fail closed: when applicableActions is empty the
// drawer is verify-only and shows the row's reason instead of buttons.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  loadBagCloseoutDetailAction,
  type BagCloseoutDetailResult,
} from "../actions";
import type { BagCloseoutRowFacts } from "@/lib/db/queries/bag-closeout-detail";
import { useRefreshSuppression } from "@/lib/ui/refresh-suppression";
import { VerifyPanel } from "./verify-panel";
import { ActionPanels } from "./action-panels";

export function BagDrawer({
  inventoryBagId,
  poId,
  row,
  reason,
}: {
  inventoryBagId: string;
  poId: string;
  row: BagCloseoutRowFacts;
  /** The row verdict's reason — shown as headline context. */
  reason: string;
}) {
  const router = useRouter();
  useRefreshSuppression();
  const [result, setResult] = React.useState<BagCloseoutDetailResult | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refetch = React.useCallback(async () => {
    setLoading(true);
    try {
      setResult(await loadBagCloseoutDetailAction({ inventoryBagId, poId, row }));
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to load bag detail.",
      });
    } finally {
      setLoading(false);
    }
    // Also refresh the page's row/counts so the verdict matches the drawer.
    router.refresh();
  }, [inventoryBagId, poId, row, router]);

  // Load once on mount (the drawer is only rendered while open).
  const loadedRef = React.useRef(false);
  React.useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void refetch();
  }, [refetch]);

  // Re-fetch when the server-rendered row facts change (action/status/lot id
  // flip after a server action revalidates the page and router.refresh()
  // delivers the updated RSC payload). This keeps the action panels in sync
  // without requiring a full page navigation.
  const prevRowKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${row.action}|${row.status}|${row.finishedLotId ?? ""}`;
    if (prevRowKeyRef.current === null) {
      // First render — initial load is already handled above.
      prevRowKeyRef.current = key;
      return;
    }
    if (prevRowKeyRef.current !== key) {
      prevRowKeyRef.current = key;
      void refetch();
    }
  }, [row.action, row.status, row.finishedLotId, refetch]);

  return (
    <div className="space-y-3 border-t border-border/60 bg-surface-2/40 p-4">
      <p className="text-[11px] text-text-muted">
        <span className="font-medium text-text-strong">{reason}</span>
      </p>
      {loading && !result ? (
        <p className="text-[11px] text-text-muted">Loading live bag detail…</p>
      ) : null}
      {result && !result.ok ? (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
          {result.error}
        </p>
      ) : null}
      {result?.ok ? (
        <>
          <VerifyPanel detail={result.detail} />
          <ActionPanels
            detail={result.detail}
            row={row}
            inventoryBagId={inventoryBagId}
            poId={poId}
            onDone={() => void refetch()}
          />
        </>
      ) : null}
    </div>
  );
}
