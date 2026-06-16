"use client";

// ZOHO-STAGING-BUFFER-v1.1.0 — operator buttons on the production-output
// queue. Two-button approve model (no explicit "Queue"):
//
//   Approve for auto-commit  → cron commits at auto_commit_eligible_at
//   Approve & commit now     → operator pushes immediately, bypassing buffer
//
// Plus Hold / Unhold / Void. Every button respects the same disabled
// rule set so operators can never click a transition that the
// state machine would refuse.
//
// State + visibility matrix (driven by status / held_at / voided_at):
//
//   DRAFT / PREVIEWED:  Approve-for-auto, Approve-and-commit, Hold, Void
//   APPROVED:           Approve-for-auto (→re-queue), Approve-and-commit, Hold, Void
//   QUEUED:             Hold, Void, Commit-now (skips approve since already queued)
//   COMMITTING:         none (in flight)
//   COMMITTED:          none (terminal happy)
//   FAILED:             Hold, Void, Approve-and-commit (retry)
//   NEEDS_MAPPING:      Hold, Void — message: "Fix on product page"
//   NEEDS_REVIEW:       Hold, Void — message: "Business decision required"
//   HELD:               Unhold, Void
//   VOIDED:             none (terminal)

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveProductionOutputForAutoCommit,
  approveAndCommitProductionOutputNow,
  holdProductionOutputOp,
  unholdProductionOutputOp,
  voidProductionOutputOpAction,
} from "./staging-actions";

export type ProductionOutputStagingRow = {
  id: string;
  status: string;
  heldAt: Date | null;
  voidedAt: Date | null;
  autoCommitEligibleAt: Date | null;
  mappingBlockers: Array<{ code: string; message: string }> | null;
};

const COMMITTABLE_STATUSES = new Set([
  "DRAFT",
  "PREVIEWED",
  "APPROVED",
  "QUEUED",
  "FAILED",
]);

const TERMINAL_OR_BLOCKED = new Set([
  "COMMITTED",
  "COMMITTING",
  "NEEDS_MAPPING",
  "NEEDS_REVIEW",
]);

export function ProductionOutputStagingButtons({
  row,
}: {
  row: ProductionOutputStagingRow;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const isHeld = row.heldAt != null;
  const isVoided = row.voidedAt != null;
  const isCommittable =
    !isHeld &&
    !isVoided &&
    COMMITTABLE_STATUSES.has(row.status) &&
    !TERMINAL_OR_BLOCKED.has(row.status);

  function run(
    label: string,
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setMessage({ kind: "ok", text: result.message ?? label });
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error ?? "Failed" });
      }
    });
  }

  function confirmAndRun(
    prompt: string,
    label: string,
    fn: (reason: string) => Promise<{ ok: boolean; message?: string; error?: string }>,
  ) {
    const reason = window.prompt(prompt, "");
    if (reason == null) return;
    run(label, () => fn(reason));
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]">
      {/* NEEDS_REVIEW gets the business-decision message */}
      {row.status === "NEEDS_REVIEW" ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900">
          <p className="font-medium">Business decision required.</p>
          {row.mappingBlockers && row.mappingBlockers.length > 0 ? (
            <ul className="mt-0.5 list-disc pl-4">
              {row.mappingBlockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {row.status === "NEEDS_MAPPING" ? (
        <div className="rounded border border-orange-300 bg-orange-50 px-2 py-1 text-orange-900">
          <p className="font-medium">Mapping / config missing.</p>
          {row.mappingBlockers && row.mappingBlockers.length > 0 ? (
            <ul className="mt-0.5 list-disc pl-4">
              {row.mappingBlockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {isCommittable ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run("Approve for auto-commit", () =>
                  approveProductionOutputForAutoCommit(row.id),
                )
              }
              className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              Approve for auto-commit
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run("Approve & commit now", () =>
                  approveAndCommitProductionOutputNow(row.id),
                )
              }
              className="rounded border border-brand-700 bg-brand-700 px-2 py-0.5 text-white hover:bg-brand-800 disabled:opacity-50"
            >
              Approve &amp; commit now
            </button>
          </>
        ) : null}

        {isHeld ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run("Unhold", () => unholdProductionOutputOp(row.id))}
            className="rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-sky-900 hover:bg-sky-100 disabled:opacity-50"
          >
            Unhold
          </button>
        ) : null}

        {!isHeld && !isVoided && row.status !== "COMMITTED" && row.status !== "COMMITTING" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              confirmAndRun(
                "Hold reason (≤ 500 chars):",
                "Hold",
                (reason) => holdProductionOutputOp(row.id, reason),
              )
            }
            className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            Hold
          </button>
        ) : null}

        {!isVoided && row.status !== "COMMITTED" && row.status !== "COMMITTING" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              confirmAndRun(
                "Void this staged op? This is terminal — give a reason:",
                "Void",
                (reason) => voidProductionOutputOpAction(row.id, reason),
              )
            }
            className="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-rose-900 hover:bg-rose-100 disabled:opacity-50"
          >
            Void
          </button>
        ) : null}
      </div>

      {/* Auto-commit ETA copy */}
      {!isHeld &&
      !isVoided &&
      row.status === "QUEUED" &&
      row.autoCommitEligibleAt ? (
        <p className="text-[10px] text-text-muted">
          Auto-commit at {row.autoCommitEligibleAt.toLocaleString()}
        </p>
      ) : null}
      {!isHeld &&
      !isVoided &&
      row.status === "QUEUED" &&
      !row.autoCommitEligibleAt ? (
        <p className="text-[10px] text-text-muted">
          Auto-commit disabled — use “Commit now” to push.
        </p>
      ) : null}

      {message ? (
        <p
          className={`text-[10.5px] ${
            message.kind === "ok" ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
