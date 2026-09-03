"use client";

// GUIDED-CLOSEOUT-1 — step 0: apply all safe actions behind one confirm.
// Runs the EXISTING PO-scoped batch actions (each re-checks eligibility per
// row inside its own transaction). Nothing touches Zoho.

import * as React from "react";
import {
  autoIssueSafeLotsForPoAction,
  autoReleaseSafeLotsForPoAction,
  type PoBatchResult,
} from "../actions";
import { useRouter } from "next/navigation";

export function SafeBatchStep({
  poId,
  issueReady,
  releaseReady,
  continueHref,
}: {
  poId: string;
  issueReady: number;
  releaseReady: number;
  /** SIMPLIFY-D — results persist until the operator explicitly continues;
   *  the entry resolver decides what's next from live data. */
  continueHref: string;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [results, setResults] = React.useState<
    Array<{ label: string; result: PoBatchResult }> | null
  >(null);

  const run = async () => {
    setPending(true);
    const out: Array<{ label: string; result: PoBatchResult }> = [];
    if (issueReady > 0) {
      out.push({
        label: "Issue finished lots",
        result: await autoIssueSafeLotsForPoAction(poId),
      });
    }
    if (releaseReady > 0) {
      out.push({
        label: "Release safe lots",
        result: await autoReleaseSafeLotsForPoAction(poId),
      });
    }
    setResults(out);
    setPending(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-strong">
        Apply all safe actions:{" "}
        {issueReady > 0 ? `issue ${issueReady} finished lot${issueReady === 1 ? "" : "s"}` : null}
        {issueReady > 0 && releaseReady > 0 ? " and " : null}
        {releaseReady > 0 ? `release ${releaseReady} lot${releaseReady === 1 ? "" : "s"}` : null}
        {" "}— nothing touches Zoho.
      </p>
      <p className="text-xs text-text-muted">
        Each row is re-checked inside its own transaction before anything is
        created — rows that changed since this screen loaded are skipped with
        their reason, never forced.
      </p>
      {results ? (
        <div className="space-y-2">
          {results.map(({ label, result }) => (
            <div key={label} className="rounded border border-border bg-surface px-3 py-2 text-xs">
              <p className="font-semibold">{label}</p>
              {result.ok ? (
                <>
                  <p className="text-good-700">
                    {result.affected} applied · {result.skipped} skipped
                    {result.capped ? " (capped)" : ""}
                  </p>
                  {result.skippedReasons.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-text-muted">
                      {result.skippedReasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="text-crit-700">{result.error}</p>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => router.replace(continueHref)}
            className="rounded bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
          >
            Continue
          </button>
          <p className="text-xs text-text-muted">
            The queue recomputes from live data when you continue.
          </p>
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>Run the safe batch for this PO.</span>
          </label>
          <button
            type="button"
            disabled={pending || !confirmed}
            onClick={() => void run()}
            className="rounded bg-brand-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Running…" : "Apply all safe actions"}
          </button>
        </>
      )}
    </div>
  );
}
