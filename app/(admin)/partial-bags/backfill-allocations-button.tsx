"use client";

import { useState, useTransition } from "react";
import { Wrench } from "lucide-react";
import { backfillSafeMissingAllocationsAction } from "./actions";

export function BackfillSafeAllocationsButton() {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleBackfill() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await backfillSafeMissingAllocationsAction();
        if (res.ok) {
          setMessage(
            `Repaired ${res.repaired} run${res.repaired === 1 ? "" : "s"}. Skipped ${res.skipped} (not safe).` +
              (res.errors.length > 0
                ? ` ${res.errors.length} error${res.errors.length === 1 ? "" : "s"}.`
                : ""),
          );
        } else {
          setError(res.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5 mb-3">
      <button
        type="button"
        onClick={handleBackfill}
        disabled={isPending}
        className="inline-flex w-fit items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 text-[11px] font-medium text-amber-900 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Wrench className={`h-3 w-3 ${isPending ? "animate-pulse" : ""}`} />
        {isPending ? "Backfilling..." : "Backfill safe allocations"}
      </button>
      {message && <p className="text-[10px] text-emerald-700">{message}</p>}
      {error && <p className="text-[10px] text-red-700">{error}</p>}
      <p className="text-[10px] text-text-muted">
        Repairs only rows classified SAFE_OPEN_ALLOCATION. For bulk repair from
        the shell:{" "}
        <code className="font-mono text-[9px]">
          tsx scripts/backfill-missing-active-allocations.ts
        </code>
      </p>
    </div>
  );
}
