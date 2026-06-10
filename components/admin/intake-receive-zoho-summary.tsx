"use client";

import * as React from "react";
import { Info } from "lucide-react";
import type { IntakeReceiveZohoSummary } from "@/lib/zoho/raw-bag-receive-panel";
import { loadIntakeReceiveZohoSummaryAction } from "@/app/(admin)/receiving/raw-bags/actions";

export function IntakeReceiveZohoSummaryBanner({
  receiveId,
  bagIds,
}: {
  receiveId?: string;
  bagIds?: readonly string[];
}) {
  const [summary, setSummary] = React.useState<IntakeReceiveZohoSummary | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    void loadIntakeReceiveZohoSummaryAction({
      ...(receiveId ? { receiveId } : {}),
      ...(bagIds && bagIds.length > 0 ? { bagIds } : {}),
    }).then((data) => {
      if (!cancelled) setSummary(data);
    });
    return () => {
      cancelled = true;
    };
  }, [receiveId, bagIds?.join(",")]);

  if (!summary) return null;

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/50 px-4 py-3 text-xs text-sky-950 space-y-2">
      <div className="flex items-start gap-2">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">Zoho receive scope for this intake</p>
          <p>{summary.granularityDescription}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 font-mono">
        <div>
          <span className="text-sky-800/70 uppercase tracking-wide text-[10px]">
            Bags
          </span>
          <div className="text-sm">{summary.bagCount}</div>
        </div>
        <div>
          <span className="text-sky-800/70 uppercase tracking-wide text-[10px]">
            Total declared qty
          </span>
          <div className="text-sm">
            {summary.totalDeclaredQuantity.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-sky-800/70 uppercase tracking-wide text-[10px]">
            Zoho PRs if all committed
          </span>
          <div className="text-sm">{summary.zohoTransactionsOnFullCommit}</div>
        </div>
      </div>
      {summary.perBagQuantities.length > 1 ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer font-medium">Per-bag breakdown</summary>
          <ul className="mt-2 space-y-1">
            {summary.perBagQuantities.map((row) => (
              <li key={row.inventoryBagId}>
                Luma receipt {row.lumaReceipt ?? "—"} —{" "}
                {row.declaredQuantity.toLocaleString()} tablets (1 Zoho PR per bag)
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
