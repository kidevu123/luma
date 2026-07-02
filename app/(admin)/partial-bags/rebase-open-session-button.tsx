"use client";

import * as React from "react";
import { Scale } from "lucide-react";
import { rebaseOpenSessionStartingBalanceAction } from "./actions";

/** REBASE-OPEN-SESSION-1 — corrects an OPEN session's wrong starting balance to
 *  the prior returned balance, IN PLACE. The session stays OPEN so the run can
 *  still accept production numbers later; the QR stays assigned. Admin action,
 *  audited. */
export function RebaseOpenSessionButton({
  inventoryBagId,
  currentStarting,
  newStarting,
}: {
  inventoryBagId: string;
  currentStarting: number | null;
  newStarting: number;
}) {
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<number | null>(null);

  if (done != null) {
    return (
      <p className="text-[12px] font-medium text-emerald-700">
        Starting balance corrected to {done.toLocaleString()} tablets. The session
        stays open — the run can still receive production numbers.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-[11px] font-medium text-text-strong mb-1">
          Note (optional)
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Prior run returned 3,598 to stock; session opened before v1.16.0 at declared 7,197."
          className="block w-full h-9 px-2.5 rounded-lg border border-border bg-surface-2/60 text-xs"
        />
      </label>
      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-800">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          if (
            !confirm(
              `Correct the open session's starting balance from ${
                currentStarting != null ? currentStarting.toLocaleString() : "unknown"
              } to ${newStarting.toLocaleString()} (prior returned balance)? The session stays OPEN, the QR stays assigned, and no production numbers change.`,
            )
          )
            return;
          setPending(true);
          setError(null);
          try {
            const fd = new FormData();
            fd.set("inventoryBagId", inventoryBagId);
            if (note.trim()) fd.set("note", note.trim());
            const r = await rebaseOpenSessionStartingBalanceAction(fd);
            if (r.ok) setDone(r.newStartingBalance);
            else setError(r.error);
          } catch {
            setError("Could not correct the starting balance — try again.");
          } finally {
            setPending(false);
          }
        }}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-brand-600 text-white text-[12px] font-semibold hover:bg-brand-700 disabled:opacity-60"
      >
        <Scale className="h-3.5 w-3.5" aria-hidden />
        {pending
          ? "Correcting…"
          : `Correct starting balance to ${newStarting.toLocaleString()}`}
      </button>
    </div>
  );
}
