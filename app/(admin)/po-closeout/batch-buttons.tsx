"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PackagePlus, ShieldCheck } from "lucide-react";
import { autoIssueSafeLotsForPoAction, autoReleaseSafeLotsForPoAction } from "./actions";

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
}: {
  poId: string;
  issueReady: number;
  releaseReady: number;
}) {
  const issue = useBatch(autoIssueSafeLotsForPoAction);
  const release = useBatch(autoReleaseSafeLotsForPoAction);

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
    </div>
  );
}
