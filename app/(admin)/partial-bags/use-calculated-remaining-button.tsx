"use client";

import * as React from "react";
import { Calculator } from "lucide-react";
import { useCalculatedRemainingAction } from "./actions";

/** SPLIT-BAG-1 — one-click "Use calculated remaining". Resolves the OPEN
 *  allocation session from previous production output so the bag is ready to
 *  reuse, without a manual count / weigh-back. */
export function UseCalculatedRemainingButton({
  inventoryBagId,
  remaining,
}: {
  inventoryBagId: string;
  /** System-derived remaining shown for confirmation. */
  remaining: number;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ remaining: number; depleted: boolean } | null>(null);

  if (done) {
    return (
      <p className="text-[10.5px] font-medium text-emerald-700">
        {done.depleted
          ? "Resolved — bag marked empty, QR returned to the pool."
          : `Resolved — ${done.remaining.toLocaleString()} tablets remaining, ready to reuse.`}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          if (
            !confirm(
              `Use the calculated remaining (${remaining.toLocaleString()} tablets, system-derived from production output) to close the prior run's allocation and make this bag ready for reuse? This is not a physical count.`,
            )
          )
            return;
          setPending(true);
          setError(null);
          try {
            const fd = new FormData();
            fd.set("inventoryBagId", inventoryBagId);
            const r = await useCalculatedRemainingAction(fd);
            if (r.ok) setDone({ remaining: r.remaining, depleted: r.depleted });
            else setError(r.error);
          } catch {
            setError("Failed to resolve — try again or use a manual count.");
          } finally {
            setPending(false);
          }
        }}
        className="inline-flex w-fit items-center gap-1 px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 text-[11px] font-medium hover:bg-emerald-100 transition-colors disabled:opacity-60"
      >
        <Calculator className="h-3 w-3" aria-hidden />
        {pending ? "Resolving…" : "Use calculated remaining"}
      </button>
      {error ? (
        <p className="text-[10px] font-medium text-red-700">{error}</p>
      ) : null}
    </div>
  );
}
