"use client";

// GUIDED-CLOSEOUT-1 — full-height "Close this PO" overlay. URL-addressable
// (?guided=1&step=n): every step advance is a plain navigation, so the
// server recomputes the queue from live data — steps disappear as work
// completes (by anyone). The overlay adds no mutation logic of its own:
// step 0 wraps the existing PO batch actions; bag steps render the Phase-1
// drawer (existing panels + existing server actions).

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import type { GuidedStep } from "@/lib/production/guided-closeout";
import type { BagCloseoutRowFacts } from "@/lib/db/queries/bag-closeout-detail";
import { BagDrawer } from "../_drawer/bag-drawer";
import { SafeBatchStep } from "./safe-batch-step";

export type GuidedBagStep = GuidedStep & { rowFacts: BagCloseoutRowFacts };

export function GuidedOverlay({
  poId,
  poNumber,
  step,
  totalSteps,
  hasSafeBatch,
  issueReady,
  releaseReady,
  bagStep,
  finish,
}: {
  poId: string;
  poNumber: string;
  /** 0-based current step (0 = safe batch when hasSafeBatch). */
  step: number;
  totalSteps: number;
  hasSafeBatch: boolean;
  issueReady: number;
  releaseReady: number;
  /** The current bag step, when this step is a bag step. */
  bagStep: GuidedBagStep | null;
  /** Finish rollup, when past the last step. */
  finish: {
    done: number;
    readyForAction: number;
    needsReview: number;
    blocked: number;
    topBlockers: Array<{ reason: string; count: number }>;
  } | null;
}) {
  const stepHref = (n: number) => `/po-closeout/${poId}?guided=1&step=${n}`;
  const exitHref = `/po-closeout/${poId}`;
  const isSafeBatchStep = hasSafeBatch && step === 0 && !finish;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40 p-3 sm:p-6">
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
              Close this PO — {poNumber}
            </p>
            <p className="text-sm font-semibold text-text-strong">
              {finish
                ? "Finished — where this PO stands"
                : isSafeBatchStep
                  ? `Step 1 of ${totalSteps}: apply all safe actions`
                  : `Step ${step + 1} of ${totalSteps}: ${bagStep?.actionLabel ?? "review"}`}
            </p>
          </div>
          <Link
            href={exitHref}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" aria-hidden /> Exit
          </Link>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {finish ? (
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
          ) : isSafeBatchStep ? (
            <SafeBatchStep poId={poId} issueReady={issueReady} releaseReady={releaseReady} />
          ) : bagStep ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-text-strong">
                {bagStep.receiptNumber ?? "—"}
                {bagStep.tabletName ? ` · ${bagStep.tabletName}` : ""}
                {bagStep.bagNumber != null ? ` · Bag ${bagStep.bagNumber}` : ""}
              </p>
              {bagStep.floorOnly ? (
                <p className="rounded border border-border bg-surface-2/60 px-3 py-2 text-xs text-text-muted">
                  Needs the floor — skip for now. This bag is waiting on floor
                  work (start or finalize the run); there is nothing for an
                  admin to fix here.
                </p>
              ) : null}
              <BagDrawer
                inventoryBagId={bagStep.inventoryBagId}
                poId={poId}
                row={bagStep.rowFacts}
                reason={bagStep.reason}
              />
            </div>
          ) : (
            <p className="text-sm text-text-muted">Nothing to do on this step.</p>
          )}
        </div>

        {/* Footer nav — plain links: each advance is a fresh server render,
            so the queue recomputes from live data. */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <Link
            href={step > 0 ? stepHref(step - 1) : exitHref}
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-surface-2"
          >
            {step > 0 ? "Back" : "Exit"}
          </Link>
          <p className="text-[10px] text-text-subtle">
            Queue recomputes from live data at every step.
          </p>
          {finish ? (
            <Link
              href={exitHref}
              className="rounded bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Done — back to closeout
            </Link>
          ) : (
            <Link
              href={stepHref(step + 1)}
              className="rounded bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
            >
              {bagStep?.floorOnly ? "Skip for now" : "Next"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
