"use client";

// P0-LOT-BACKLOG — client controls for the "needs lot review" queue:
// per-row "Issue lot" for ready rows and a bulk "Auto-issue all ready"
// sweep. Blocked rows show their explicit reason inline; the bulk run
// reports an issued/blocked summary without hiding the blockers.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  autoIssueAllReadyAction,
  autoIssueLotForBagAction,
  type BacklogAutoIssueSummary,
} from "./actions";

export function AutoIssueAllButton({ readyCount }: { readyCount: number }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [summary, setSummary] = React.useState<BacklogAutoIssueSummary | null>(
    null,
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending || readyCount === 0}
        onClick={async () => {
          setPending(true);
          try {
            const s = await autoIssueAllReadyAction();
            setSummary(s);
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-green-600/40 bg-green-50 px-3 py-1.5 text-[12px] font-medium text-green-800 hover:bg-green-100 transition-colors disabled:opacity-50"
      >
        {pending
          ? "Issuing…"
          : readyCount === 0
            ? "No rows ready to auto-issue"
            : `Auto-issue ${readyCount} ready lot${readyCount === 1 ? "" : "s"}`}
      </button>
      {summary && (
        <p className="text-[11px] text-text-muted">
          Issued {summary.issued} lot{summary.issued === 1 ? "" : "s"}
          {summary.blocked > 0
            ? ` · ${summary.blocked} blocked (reasons shown per row)`
            : " · no blockers"}
        </p>
      )}
    </div>
  );
}

export function IssueLotButton({
  workflowBagId,
}: {
  workflowBagId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const r = await autoIssueLotForBagAction(workflowBagId);
            if (!r.ok) setError(r.message ?? "Blocked.");
            else router.refresh();
          } finally {
            setPending(false);
          }
        }}
        className="inline-flex items-center gap-1 rounded-md border border-green-600/40 bg-green-50 px-2.5 py-1 text-[11.5px] font-medium text-green-800 hover:bg-green-100 transition-colors disabled:opacity-50"
      >
        {pending ? "Issuing…" : "Issue lot"}
      </button>
      {error && (
        <p className="mt-1 max-w-[16rem] text-[10.5px] text-red-700 leading-snug">
          {error}
        </p>
      )}
    </div>
  );
}
