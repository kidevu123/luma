"use client";

import * as React from "react";
import { Calculator, AlertTriangle } from "lucide-react";
import { resolveScannedBagAllocationAction } from "./actions";
import type { FloorOpenAllocationBlock } from "@/lib/production/system-derived-allocation-resolution";

/** SPLIT-BAG-1 — floor panel shown when a start/scan is blocked because the
 *  physical raw bag still has an OPEN allocation from a prior product. When the
 *  remaining can be derived from production output, a lead can one-click "Use
 *  calculated remaining" right here instead of leaving for the admin workbench.
 *  Manual count / weigh-back stays available. Nothing happens silently. */
export function OpenAllocationCalcPanel({
  block,
  token,
  stationId,
}: {
  block: FloorOpenAllocationBlock;
  token: string;
  stationId: string;
}) {
  const [leadCode, setLeadCode] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ depleted: boolean; remaining: number } | null>(null);

  const manualLink = (
    <a
      href="/partial-bags"
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-amber-900"
    >
      Use manual count / weigh-back in the Partial Bag Workbench
    </a>
  );

  if (done) {
    return (
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
        <p className="font-semibold">
          {done.depleted
            ? "Calculated remaining saved — the bag is empty; its QR returned to the pool."
            : `Calculated remaining saved (${done.remaining.toLocaleString()} tablets left).`}
        </p>
        <p className="mt-0.5 text-[12px]">
          Re-scan this bag or continue starting the next product.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/70 p-3 space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        This bag is still open from a previous product.
      </p>

      {block.eligible ? (
        <>
          <p className="text-[12px] text-amber-900/90 leading-snug">
            Luma can calculate the remaining balance from the previous
            production counts.
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-amber-900">
            {block.previousProductName ? (
              <>
                <dt className="text-amber-800/70">Previous product</dt>
                <dd>{block.previousProductName}</dd>
              </>
            ) : null}
            <dt className="text-amber-800/70">Output used</dt>
            <dd>
              {block.outputUnits?.toLocaleString()} units ({block.outputStageLabel})
            </dd>
            <dt className="text-amber-800/70">Calculation</dt>
            <dd className="tabular-nums">
              {block.startingTabletCount?.toLocaleString()} start −{" "}
              {block.derivedConsumedTablets?.toLocaleString()} consumed ={" "}
              <span className="font-semibold">
                {block.derivedRemainingTablets?.toLocaleString()} remaining
              </span>
            </dd>
          </dl>
          <p className="rounded bg-amber-100 border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-900">
            System-derived from production output — not a physical count. Using
            it writes a ledger closeout for the prior run.
          </p>

          <label className="block">
            <span className="block text-[11px] font-medium text-amber-900 mb-1">
              Lead badge code (required)
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={leadCode}
              onChange={(e) => setLeadCode(e.target.value)}
              className="block w-full h-11 px-3 rounded-lg bg-surface border border-amber-300 text-base tabular-nums"
            />
          </label>

          {error ? (
            <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[11px] text-red-900">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            disabled={pending || !leadCode.trim()}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const fd = new FormData();
                fd.set("token", token);
                fd.set("stationId", stationId);
                fd.set("inventoryBagId", block.inventoryBagId);
                fd.set("leadCode", leadCode.trim());
                const r = await resolveScannedBagAllocationAction(fd);
                if (r.ok) setDone({ depleted: r.depleted, remaining: r.remaining });
                else setError(r.error);
              } catch {
                setError("Could not use calculated remaining — try again or use a manual count.");
              } finally {
                setPending(false);
              }
            }}
            className="inline-flex items-center gap-1.5 h-11 px-4 rounded-lg bg-amber-700 text-white text-sm font-semibold disabled:opacity-60"
          >
            <Calculator className="h-4 w-4" aria-hidden />
            {pending ? "Saving…" : "Use calculated remaining"}
          </button>

          <p className="text-[11px] text-amber-800/80">Not sure? {manualLink}.</p>
        </>
      ) : (
        <>
          <p className="text-[12px] text-amber-900/90 leading-snug">
            Luma can’t safely calculate the remaining balance: {block.message}
          </p>
          <p className="text-[11px] text-amber-800/80">{manualLink}, then start again.</p>
        </>
      )}
    </div>
  );
}
