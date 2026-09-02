"use client";

// SIMPLIFY-A — the row's single primary action, inline. No expand, no wait.
// Calls the EXISTING finished-lots server actions verbatim (same as the
// drawer's LotActions). Only the two deterministic, safe actions render a
// button; everything else keeps the drawer/link path.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  repairAutoIssueFinishedLotAction,
  setFinishedLotStatusAction,
} from "@/app/(admin)/finished-lots/actions";
import type { PoCloseoutRow } from "@/lib/db/queries/po-closeout";

export function RowActionButton({ row }: { row: PoCloseoutRow }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    const r = (await fn()) as { error?: string } | null;
    setPending(false);
    if (r && typeof r === "object" && "error" in r && r.error) setError(r.error);
    else router.refresh();
  };

  let button: { label: string; onClick: () => void } | null = null;
  if (
    (row.action === "AUTO_ISSUE_FINISHED_LOT" || (row.action === "ISSUE_FINISHED_LOT" && row.status === "READY_FOR_ACTION")) &&
    row.workflowBagId
  ) {
    const workflowBagId = row.workflowBagId;
    button = { label: "Issue lot", onClick: () => void run(() => repairAutoIssueFinishedLotAction(workflowBagId)) };
  } else if (row.action === "AUTO_RELEASE_FINISHED_LOT" && row.finishedLotId && row.status === "READY_FOR_ACTION") {
    const finishedLotId = row.finishedLotId;
    button = {
      label: "Release lot",
      onClick: () => void run(() => setFinishedLotStatusAction({ id: finishedLotId, status: "RELEASED" })),
    };
  }

  if (!button) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={pending}
        onClick={button.onClick}
        className="rounded bg-brand-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
      >
        {pending ? "Working…" : button.label}
      </button>
      {error ? (
        <p className="mt-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-800">{error}</p>
      ) : null}
    </div>
  );
}
