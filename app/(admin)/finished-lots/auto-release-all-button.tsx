"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { autoReleaseAllSafeLotsAction } from "./actions";

/** AUTO-QC-RELEASE-1 — one click releases every clean Pending QC lot. Lots with
 *  any QC signal stay Pending for review. Does not commit to Zoho. */
export function AutoReleaseAllButton({ readyCount }: { readyCount: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { released: number; skipped: number; capped: boolean; skippedLots: Array<{ finishedLotId: string; message: string }> }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={pending || readyCount === 0}
        onClick={() => {
          if (
            !confirm(
              `Auto-release ${readyCount} clean Pending QC lot${readyCount === 1 ? "" : "s"}? Lots with any QC signal stay Pending for review. Zoho output is NOT committed by this step.`,
            )
          )
            return;
          setError(null);
          setResult(null);
          startTransition(async () => {
            const r = await autoReleaseAllSafeLotsAction();
            if (!r.ok) {
              setError(r.error);
              return;
            }
            setResult({
              released: r.released,
              skipped: r.skipped,
              capped: r.capped,
              skippedLots: r.skippedLots.map((s) => ({ finishedLotId: s.finishedLotId, message: s.message })),
            });
            router.refresh();
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-green-600/50 bg-green-50 px-3 py-1.5 text-[12px] font-semibold text-green-800 hover:bg-green-100 transition-colors disabled:opacity-50"
        title={readyCount === 0 ? "No lots are currently safe to auto-release" : `Auto-release ${readyCount} clean lot(s)`}
      >
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        {pending ? "Releasing…" : `Auto-release all safe lots${readyCount > 0 ? ` (${readyCount})` : ""}`}
      </button>
      {error ? <p className="text-[11px] text-red-700">{error}</p> : null}
      {result ? (
        <div className="text-[11px] text-text-muted">
          <span className="font-medium text-green-700">Released {result.released}</span>
          {result.skipped > 0 ? (
            <>
              {" · "}
              <span className="text-amber-700">skipped {result.skipped}</span>
            </>
          ) : null}
          {result.capped ? " · more remain (run again)" : ""}
          {result.skippedLots.length > 0 ? (
            <ul className="mt-1 list-disc pl-4">
              {result.skippedLots.slice(0, 5).map((s) => (
                <li key={s.finishedLotId} className="text-[10.5px]">{s.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
