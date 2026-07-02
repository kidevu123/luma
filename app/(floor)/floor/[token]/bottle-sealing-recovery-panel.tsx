"use client";

import * as React from "react";
import { AlertTriangle, Wrench } from "lucide-react";
import { recoverBottleSealingHoldAction } from "./actions";

/** BOTTLE-SEALING-RECOVERY-1 — packaging-station panel for a bottle bag stuck at
 *  BLISTERED because its cap-seal / sticker completions were never recorded (the
 *  bag physically left finishing without a scan). Explains the accurate bottle
 *  state (no card/blister language) and offers a lead-gated "Clear stale sealing
 *  hold" action that records the missing finishing so packaging unlocks. It does
 *  NOT release the QR, touch the allocation balance, or finalize/deplete. */
export function BottleSealingRecoveryPanel({
  token,
  stationId,
  workflowBagId,
}: {
  token: string;
  stationId: string;
  workflowBagId: string;
}) {
  const [leadCode, setLeadCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  if (done) {
    return (
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <p className="font-semibold">Bottle sealing marked complete — packaging unlocked.</p>
        <p className="text-xs mt-0.5">
          Refreshing… you can now complete packaging for this bottle bag.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/70 px-3 py-2.5 text-sm text-amber-900 space-y-2">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        Bottle cap-seal / sticker not marked complete.
      </p>
      <p className="text-xs leading-snug">
        Packaging stays locked until this bottle bag&apos;s cap-seal and sticker
        steps are recorded. If the bag has physically left the finishing stations
        already, a lead can clear the stale hold and unlock packaging.
      </p>

      <details className="rounded-md border border-amber-300/70 bg-amber-100/40">
        <summary className="cursor-pointer list-none px-2.5 py-2 min-h-[40px] flex items-center gap-1.5 text-[12.5px] font-medium [&::-webkit-details-marker]:hidden">
          <Wrench className="h-3.5 w-3.5" aria-hidden />
          Lead: clear stale sealing hold
        </summary>
        <div className="border-t border-amber-300/70 px-2.5 py-2 space-y-2">
          <label className="block">
            <span className="block text-[11px] font-medium mb-1">Lead badge code</span>
            <input
              type="text"
              inputMode="numeric"
              value={leadCode}
              onChange={(e) => setLeadCode(e.target.value)}
              className="block w-full h-11 px-3 rounded-lg bg-surface border border-amber-300 text-base tabular-nums"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium mb-1">
              Reason / note (required)
            </span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. bag cap-sealed + stickered, scan missed"
              className="block w-full h-11 px-3 rounded-lg bg-surface border border-amber-300 text-sm"
            />
          </label>
          <p className="text-[11px] text-amber-800/80 leading-snug">
            Records the missing cap-seal + sticker completion and unlocks
            packaging. Does not release the QR card, change the raw-bag balance,
            or finalize the bag.
          </p>
          {error ? (
            <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[11px] text-red-900">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending || !leadCode.trim() || note.trim().length < 3}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const fd = new FormData();
                fd.set("token", token);
                fd.set("stationId", stationId);
                fd.set("workflowBagId", workflowBagId);
                fd.set("leadCode", leadCode.trim());
                fd.set("note", note.trim());
                const r = await recoverBottleSealingHoldAction(fd);
                if (r.ok) setDone(true);
                else setError(r.error);
              } catch {
                setError("Could not clear the sealing hold — try again.");
              } finally {
                setPending(false);
              }
            }}
            className="inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-amber-700 text-white text-sm font-semibold disabled:opacity-60"
          >
            <Wrench className="h-4 w-4" aria-hidden />
            {pending ? "Clearing…" : "Clear stale sealing hold & unlock packaging"}
          </button>
        </div>
      </details>
    </div>
  );
}
