"use client";

// GUIDED-CLOSEOUT-1 / SIMPLIFY-D — full-height "Close this PO" overlay.
// Steps are bag-addressed (?guided=1&bag=<inventoryBagId|batch|finish>), never
// index-addressed, so a bag resolved out-of-band (by anyone, from anywhere)
// shortens the queue instead of desyncing a step counter. Every nav action
// (Back/Next/Exit/Continue) is a router.replace — the overlay never leaves a
// history entry a browser Back button could resurrect. The overlay adds no
// mutation logic of its own: the batch mode wraps the existing PO batch
// actions; bag steps render the Phase-1 drawer in single-action mode
// (existing panels + existing server actions).

import * as React from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { GuidedStep, GuidedTarget } from "@/lib/production/guided-closeout";
import type { BagCloseoutRowFacts } from "@/lib/db/queries/bag-closeout-detail";
import { useRefreshSuppression } from "@/lib/ui/refresh-suppression";
import { BagDrawer } from "../_drawer/bag-drawer";
import { SafeBatchStep } from "./safe-batch-step";

export type GuidedBagStep = GuidedStep & { rowFacts: BagCloseoutRowFacts };

export function GuidedOverlay({
  poId,
  poNumber,
  mode,
  stepNumber,
  totalSteps,
  excluded,
  issueReady,
  releaseReady,
  bagStep,
  doneReceipt,
  finish,
  prevTarget,
  nextTarget,
}: {
  poId: string;
  poNumber: string;
  mode: "batch" | "bag" | "bag-done" | "finish";
  /** 1-based display position. */
  stepNumber: number;
  totalSteps: number;
  excluded: { onFloor: number; empty: number };
  issueReady: number;
  releaseReady: number;
  /** The current bag step, when mode === "bag". */
  bagStep: GuidedBagStep | null;
  /** The requested bag id's receipt, when mode === "bag-done" and known. */
  doneReceipt: string | null;
  /** Finish rollup, when mode === "finish". */
  finish: {
    done: number;
    readyForAction: number;
    needsReview: number;
    blocked: number;
    topBlockers: Array<{ reason: string; count: number }>;
  } | null;
  prevTarget: GuidedTarget | null;
  nextTarget: GuidedTarget;
}) {
  useRefreshSuppression();
  const router = useRouter();
  const hrefFor = (t: GuidedTarget) => `/po-closeout/${poId}?guided=1&bag=${t}`;
  const exitHref = `/po-closeout/${poId}`;
  const go = (t: GuidedTarget) => router.replace(hrefFor(t));
  const exit = () => router.replace(exitHref);

  const headline =
    mode === "finish"
      ? "Finished — where this PO stands"
      : mode === "batch"
        ? `Step ${stepNumber} of ${totalSteps}: apply all safe actions`
        : mode === "bag-done"
          ? "Already handled"
          : `Step ${stepNumber} of ${totalSteps}: ${bagStep?.actionLabel ?? "review"}`;

  const hasExclusions = excluded.onFloor + excluded.empty > 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40 p-3 sm:p-6">
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
              Close this PO — {poNumber}
            </p>
            <p className="text-sm font-semibold text-text-strong">{headline}</p>
            {hasExclusions ? (
              <p className="text-[10px] text-text-subtle">
                {excluded.onFloor > 0 ? `${excluded.onFloor} bag${excluded.onFloor === 1 ? "" : "s"} on floor` : null}
                {excluded.onFloor > 0 && excluded.empty > 0 ? ", " : null}
                {excluded.empty > 0 ? `${excluded.empty} empty bag${excluded.empty === 1 ? "" : "s"}` : null}
                {" — not shown (nothing for an admin to do here)."}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={exit}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" aria-hidden /> Exit
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {mode === "finish" && finish ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Done", finish.done, "text-good-700"],
                  ["Ready", finish.readyForAction, "text-brand-700"],
                  ["Needs review", finish.needsReview, "text-warn-700"],
                  ["Blocked", finish.blocked, "text-crit-700"],
                ].map(([label, value, tone]) => (
                  <div key={String(label)} className="rounded border border-border bg-surface-2/50 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-text-subtle">{label}</p>
                    <p className={`text-xl font-mono tabular-nums ${tone}`}>{value}</p>
                  </div>
                ))}
              </div>
              {finish.topBlockers.length > 0 ? (
                <div className="rounded border border-warn-200 bg-warn-50/60 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-warn-700">
                    Still open
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-warn-800">
                    {finish.topBlockers.map((b) => (
                      <li key={b.reason}>
                        {b.count}× {b.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-xs text-text-muted">
                This PO flips to Closed when every bag is resolved and Zoho
                output is queued or committed — nothing is marked done early.
              </p>
            </div>
          ) : mode === "batch" ? (
            <SafeBatchStep
              poId={poId}
              issueReady={issueReady}
              releaseReady={releaseReady}
              continueHref={`/po-closeout/${poId}?guided=1`}
            />
          ) : mode === "bag-done" ? (
            <div className="rounded border border-good-200 bg-good-50/50 px-3 py-2 text-sm text-good-800">
              {doneReceipt ?? "This bag"} is already handled — it left the queue while you were working.
            </div>
          ) : bagStep ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-text-strong">
                {bagStep.receiptNumber ?? "—"}
                {bagStep.tabletName ? ` · ${bagStep.tabletName}` : ""}
                {bagStep.bagNumber != null ? ` · Bag ${bagStep.bagNumber}` : ""}
              </p>
              <BagDrawer
                inventoryBagId={bagStep.inventoryBagId}
                poId={poId}
                row={bagStep.rowFacts}
                reason={bagStep.reason}
                primaryOnly
              />
            </div>
          ) : null}
        </div>

        {/* Footer nav — every action replaces the current history entry, so
            Back cannot resurrect the overlay; each advance re-derives the
            queue from live data. */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          {prevTarget ? (
            <button
              type="button"
              onClick={() => go(prevTarget)}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-2"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={exit}
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-2"
            >
              Exit
            </button>
          )}
          <p className="text-[10px] text-text-subtle">
            Queue recomputes from live data at every step.
          </p>
          {mode === "finish" ? (
            <button
              type="button"
              onClick={exit}
              className="rounded bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Done — back to closeout
            </button>
          ) : (
            <button
              type="button"
              onClick={() => go(nextTarget)}
              className="rounded bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
            >
              {mode === "bag-done" ? "Continue" : "Next"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
