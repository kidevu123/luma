"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PackagePlus, ShieldCheck, Calculator, Send } from "lucide-react";
import {
  autoIssueSafeLotsForPoAction,
  autoReleaseSafeLotsForPoAction,
  useCalculatedRemainingForPoAction,
  queueZohoReadyForPoAction,
} from "./actions";

type Result = { affected: number; skipped: number; capped: boolean; skippedReasons: string[] } | null;

function useBatch(action: (poId: string) => Promise<
  | { ok: true; affected: number; skipped: number; capped: boolean; skippedReasons: string[] }
  | { ok: false; error: string }
>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (poId: string, confirmMsg: string) => {
    if (!confirm(confirmMsg)) return;
    setError(null);
    setResult(null);
    start(async () => {
      const r = await action(poId);
      if (r.ok) {
        setResult({ affected: r.affected, skipped: r.skipped, capped: r.capped, skippedReasons: r.skippedReasons });
        router.refresh();
      } else setError(r.error);
    });
  };
  return { pending, result, error, run };
}

export function PoBatchButtons({
  poId,
  issueReady,
  releaseReady,
  calcReady,
  queueReady,
}: {
  poId: string;
  issueReady: number;
  releaseReady: number;
  calcReady: number;
  queueReady: number;
}) {
  const issue = useBatch(autoIssueSafeLotsForPoAction);
  const release = useBatch(autoReleaseSafeLotsForPoAction);
  const calc = useBatch(useCalculatedRemainingForPoAction);
  const queue = useBatch(queueZohoReadyForPoAction);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={issue.pending || issueReady === 0}
          onClick={() =>
            issue.run(
              poId,
              `Auto-issue ${issueReady} finished lot${issueReady === 1 ? "" : "s"} for this PO? Each is re-checked for eligibility; Zoho output is NOT committed.`,
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-brand-600/50 bg-brand-50 px-3 py-1.5 text-[12px] font-semibold text-brand-800 hover:bg-brand-100 transition-colors disabled:opacity-50"
        >
          <PackagePlus className="h-3.5 w-3.5" aria-hidden />
          {issue.pending ? "Issuing…" : `Auto-issue safe lots (${issueReady})`}
        </button>
        <button
          type="button"
          disabled={release.pending || releaseReady === 0}
          onClick={() =>
            release.run(
              poId,
              `Auto-release ${releaseReady} clean Pending QC lot${releaseReady === 1 ? "" : "s"} for this PO? Each is re-checked; Zoho output is NOT committed.`,
            )
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-green-600/50 bg-green-50 px-3 py-1.5 text-[12px] font-semibold text-green-800 hover:bg-green-100 transition-colors disabled:opacity-50"
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          {release.pending ? "Releasing…" : `Auto-release safe lots (${releaseReady})`}
        </button>
        {calcReady > 0 ? (
          <button
            type="button"
            disabled={calc.pending}
            onClick={() =>
              calc.run(
                poId,
                `Apply the system-calculated remaining to ${calcReady} bag${calcReady === 1 ? "" : "s"}? Derived from production output; no operator input.`,
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-600/50 bg-sky-50 px-3 py-1.5 text-[12px] font-semibold text-sky-800 hover:bg-sky-100 transition-colors disabled:opacity-50"
          >
            <Calculator className="h-3.5 w-3.5" aria-hidden />
            {calc.pending ? "Applying…" : `Use calculated remaining (${calcReady})`}
          </button>
        ) : null}
        {queueReady > 0 ? (
          <button
            type="button"
            disabled={queue.pending}
            onClick={() =>
              queue.run(
                poId,
                `Queue ${queueReady} Zoho output op${queueReady === 1 ? "" : "s"}? The worker commits them via the integration service; nothing is pushed immediately.`,
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-600/50 bg-violet-50 px-3 py-1.5 text-[12px] font-semibold text-violet-800 hover:bg-violet-100 transition-colors disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" aria-hidden />
            {queue.pending ? "Queueing…" : `Queue all ready for Zoho (${queueReady})`}
          </button>
        ) : null}
      </div>
      {(issue.result || issue.error) && (
        <p className="text-[11px] text-text-muted">
          {issue.error ? <span className="text-red-700">{issue.error}</span> : (
            <>
              <span className="font-medium text-brand-700">Issued {issue.result!.affected}</span>
              {issue.result!.skipped > 0 ? ` · skipped ${issue.result!.skipped}` : ""}
            </>
          )}
        </p>
      )}
      {(release.result || release.error) && (
        <p className="text-[11px] text-text-muted">
          {release.error ? <span className="text-red-700">{release.error}</span> : (
            <>
              <span className="font-medium text-green-700">Released {release.result!.affected}</span>
              {release.result!.skipped > 0 ? ` · skipped ${release.result!.skipped}` : ""}
            </>
          )}
        </p>
      )}
      {(calc.result || calc.error) && (
        <p className="text-[11px] text-text-muted">
          {calc.error ? <span className="text-red-700">{calc.error}</span> : (
            <>
              <span className="font-medium text-sky-700">Applied {calc.result!.affected}</span>
              {calc.result!.skipped > 0 ? ` · skipped ${calc.result!.skipped}` : ""}
            </>
          )}
        </p>
      )}
      {(queue.result || queue.error) && (
        <p className="text-[11px] text-text-muted">
          {queue.error ? <span className="text-red-700">{queue.error}</span> : (
            <>
              <span className="font-medium text-violet-700">Queued {queue.result!.affected}</span>
              {queue.result!.skipped > 0 ? ` · skipped ${queue.result!.skipped}` : ""}
            </>
          )}
        </p>
      )}
    </div>
  );
}
