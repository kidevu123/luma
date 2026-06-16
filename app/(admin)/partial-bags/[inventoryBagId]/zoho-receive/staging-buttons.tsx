"use client";

// ZOHO-STAGING-BUFFER-v1.1.0 — operator buttons on the raw-bag
// receive page. Four actions:
//
//   Hold       — pause the buffer (requires reason)
//   Unhold     — resume the buffer; re-stamps auto_commit_eligible_at
//   Void       — terminal cancel (requires reason)
//   Commit now — operator pushes immediately; bypasses any remaining buffer
//
// No separate "approve" — raw-bag rows seed with implicit approval at
// intake. The buffer + operator-action set IS the approval gate.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  commitNowRawBagReceiveOp,
  holdRawBagReceiveOp,
  unholdRawBagReceiveOp,
  voidRawBagReceiveOp,
} from "./staging-actions";

export type RawBagStagingRow = {
  /** zoho_raw_bag_receives.id — the staged op. */
  opId: string;
  status: string;
  heldAt: Date | null;
  voidedAt: Date | null;
  autoCommitEligibleAt: Date | null;
  mappingBlockers: Array<{ code: string; message: string }> | null;
};

const COMMITTABLE_STATUSES = new Set([
  "PENDING",
  "PREVIEWED",
  "FAILED",
]);

export function RawBagStagingButtons({ row }: { row: RawBagStagingRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const isHeld = row.heldAt != null;
  const isVoided = row.voidedAt != null;
  const isCommittable =
    !isHeld && !isVoided && COMMITTABLE_STATUSES.has(row.status);

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
    <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-text-subtle">
        Staging buffer
      </p>

      {row.status === "NEEDS_REVIEW" ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <p className="font-semibold">Business decision required.</p>
          {row.mappingBlockers?.some(
            (b) => b.code === "OVER_RECEIVE_EXCEEDS_PO_REMAINING",
          ) ? (
            <p className="mt-0.5">
              This receive exceeds the remaining Zoho PO line quantity.
              Decide whether to adjust this receive down, hold until the
              original PO is updated, void it, or create an overs PO
              later.
            </p>
          ) : (
            <p className="mt-0.5">Resolve before commit.</p>
          )}
          {row.mappingBlockers && row.mappingBlockers.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-[11.5px]">
              {row.mappingBlockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {row.status === "NEEDS_MAPPING" ? (
        <div className="rounded border border-orange-300 bg-orange-50 px-3 py-2 text-[12px] text-orange-900">
          <p className="font-semibold">Mapping / config missing.</p>
          <p className="mt-0.5">
            Fix the underlying product / PO / item-id configuration, then
            unhold or commit-now. The buffer does not auto-retry until
            the mapping is fixed.
          </p>
          {row.mappingBlockers && row.mappingBlockers.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-[11.5px]">
              {row.mappingBlockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 text-[12px]">
        {isCommittable ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run("Commit now", () => commitNowRawBagReceiveOp(row.opId))}
            className="rounded border border-brand-700 bg-brand-700 px-3 py-1 font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            Push to Zoho now
          </button>
        ) : null}

        {isHeld ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              run("Unhold", () => unholdRawBagReceiveOp(row.opId))
            }
            className="rounded border border-sky-300 bg-sky-50 px-3 py-1 font-medium text-sky-900 hover:bg-sky-100 disabled:opacity-50"
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
                (reason) => holdRawBagReceiveOp(row.opId, reason),
              )
            }
            className="rounded border border-amber-300 bg-amber-50 px-3 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
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
                "Void this staged receive? This is terminal — give a reason:",
                "Void",
                (reason) => voidRawBagReceiveOp(row.opId, reason),
              )
            }
            className="rounded border border-rose-300 bg-rose-50 px-3 py-1 font-medium text-rose-900 hover:bg-rose-100 disabled:opacity-50"
          >
            Void
          </button>
        ) : null}
      </div>

      {/* Buffer copy */}
      {!isHeld && !isVoided && row.status === "PENDING" && row.autoCommitEligibleAt ? (
        <p className="text-[11px] text-text-muted">
          Auto-commit at {row.autoCommitEligibleAt.toLocaleString()}
          {" · "}
          <span className="text-text-subtle">
            (or push now with the button above)
          </span>
        </p>
      ) : null}
      {!isHeld && !isVoided && row.status === "PENDING" && !row.autoCommitEligibleAt ? (
        <p className="text-[11px] text-text-muted">
          Auto-commit disabled — push manually with the button above.
        </p>
      ) : null}
      {row.status === "COMMITTED" ? (
        <p className="text-[11px] text-emerald-700">
          Already committed to Zoho.
        </p>
      ) : null}
      {isVoided ? (
        <p className="text-[11px] text-rose-700">Voided — will not be sent.</p>
      ) : null}
      {isHeld ? (
        <p className="text-[11px] text-amber-800">
          Held — auto-commit paused. Unhold to resume the buffer.
        </p>
      ) : null}

      {message ? (
        <p
          className={`text-[11.5px] ${
            message.kind === "ok" ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
