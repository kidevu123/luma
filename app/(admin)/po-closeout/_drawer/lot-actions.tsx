"use client";

// CLOSEOUT-DRAWER-1 — finished-lot actions, inline. Calls the EXISTING
// finished-lots server actions verbatim (auto-issue repair service and the
// status transition action). Never touches Zoho.

import * as React from "react";
import Link from "next/link";
import {
  repairAutoIssueFinishedLotAction,
  setFinishedLotStatusAction,
} from "@/app/(admin)/finished-lots/actions";

export function LotActions({
  mode,
  workflowBagId,
  finishedLotId,
  onDone,
}: {
  mode: "ISSUE" | "RELEASE" | "HOLD_REVIEW";
  workflowBagId: string | null;
  finishedLotId: string | null;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  const run = async (fn: () => Promise<{ error?: string } | { ok: true } | unknown>) => {
    setPending(true);
    setError(null);
    const r = (await fn()) as { error?: string } | null;
    setPending(false);
    if (r && typeof r === "object" && "error" in r && r.error) setError(r.error);
    else onDone();
  };

  return (
    <div className="rounded border border-border bg-surface px-3 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-text-strong">
        {mode === "ISSUE" ? "Issue finished lot" : mode === "RELEASE" ? "Release lot (QC)" : "QC hold review"}
      </p>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10.5px] text-red-800">{error}</p>
      ) : null}

      {mode === "ISSUE" && workflowBagId ? (
        <>
          <p className="text-[10.5px] text-text-muted">
            Creates the finished lot from this bag&apos;s finalized output (eligibility
            re-checked in the transaction). Does not release; does not touch Zoho.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(() => repairAutoIssueFinishedLotAction(workflowBagId))}
            className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Issuing…" : "Auto-issue finished lot"}
          </button>
        </>
      ) : null}

      {mode !== "ISSUE" && finishedLotId ? (
        <>
          <p className="text-[10.5px] text-text-muted">
            {mode === "RELEASE"
              ? "Releases the lot after QC review. Zoho queueing stays a separate explicit step."
              : "Lot is on hold — release it after review, or keep it held."}
          </p>
          {mode === "HOLD_REVIEW" ? (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (recorded in audit)…"
              className="w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
            />
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(() =>
                  setFinishedLotStatusAction({
                    id: finishedLotId,
                    status: "RELEASED",
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  }),
                )
              }
              className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Working…" : "Release lot"}
            </button>
            <Link
              href={`/finished-lots/${finishedLotId}`}
              className="text-[10.5px] font-medium text-brand-700 hover:underline"
            >
              Open lot
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
