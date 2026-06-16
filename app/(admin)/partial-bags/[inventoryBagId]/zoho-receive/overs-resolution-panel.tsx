"use client";

// OVERS-RESOLUTION-v1.2.0 — operator decision panel for NEEDS_REVIEW
// rows that carry an OVER_RECEIVE_EXCEEDS_PO_REMAINING blocker.
//
// Four decisions, one inline panel. The panel only renders when:
//   - row.status === "NEEDS_REVIEW"
//   - blockers contains "OVER_RECEIVE_EXCEEDS_PO_REMAINING"
//
// Other NEEDS_REVIEW codes (future) get their own flow; we don't
// reuse this panel for them.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  clearOversDecisionAction,
  resolveOversBlockerAction,
} from "./staging-actions";
import type { OversDecisionInput } from "@/lib/zoho/overs-resolution";

export type OversResolutionPanelRow = {
  opId: string;
  status: string;
  receivedQuantity: number;
  adjustedReceivedQuantity: number | null;
  oversDecision: string | null;
  oversDecisionNote: string | null;
  /** From the over-receive blocker's optional remaining_quantity hint.
   *  When null, we leave the input blank and show the helper copy. */
  prefillRemainingQuantity: number | null;
  /** From the over-receive blocker's message (operator-facing copy). */
  blockerMessage: string | null;
};

type DecisionKind = OversDecisionInput["kind"];

export function OversResolutionPanel({ row }: { row: OversResolutionPanelRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<DecisionKind>("adjust_down");
  const [adjustQty, setAdjustQty] = useState<string>(
    row.prefillRemainingQuantity != null ? String(row.prefillRemainingQuantity) : "",
  );
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const currentQty = row.adjustedReceivedQuantity ?? row.receivedQuantity;

  function run(label: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setMessage({ kind: "ok", text: result.message ?? label });
        setOpen(false);
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error ?? "Failed" });
      }
    });
  }

  function submit() {
    let decision: OversDecisionInput;
    switch (picked) {
      case "adjust_down": {
        const qty = Number(adjustQty);
        if (!Number.isFinite(qty)) {
          setMessage({ kind: "error", text: "Enter a numeric adjusted quantity." });
          return;
        }
        decision = { kind: "adjust_down", newQuantity: Math.floor(qty), reason };
        break;
      }
      case "hold_for_po_update":
        decision = { kind: "hold_for_po_update", reason };
        break;
      case "needs_overs_po":
        decision = { kind: "needs_overs_po", note: note.trim() === "" ? null : note };
        break;
      case "reconciled_manually":
        decision = { kind: "reconciled_manually", reason };
        break;
    }
    run("Decision applied", () => resolveOversBlockerAction(row.opId, decision));
  }

  function clearTag() {
    const r = window.prompt("Reason for clearing the overs decision (≤ 500 chars):", "");
    if (r == null) return;
    run("Decision cleared", () => clearOversDecisionAction(row.opId, r));
  }

  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 space-y-2">
      {/* Tagged sub-queue status. Shown when this row has been parked
          for an overs PO. */}
      {row.oversDecision === "needs_overs_po" ? (
        <div className="rounded border border-amber-400 bg-amber-100 px-2 py-1 text-[11.5px]">
          <p className="font-semibold">Awaiting overs PO decision.</p>
          <p className="mt-0.5">
            This receive exceeds the original PO line. Create or update an overs PO later, then return here to resolve.
          </p>
          {row.oversDecisionNote ? (
            <p className="mt-0.5 italic">
              Note: {row.oversDecisionNote}
            </p>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={clearTag}
            className="mt-1 rounded border border-amber-400 bg-amber-50 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            Clear tag
          </button>
        </div>
      ) : null}

      <p className="font-semibold">Business decision required.</p>
      <p>
        {row.blockerMessage ??
          "This receive exceeds the remaining Zoho PO line quantity. Pick how to resolve."}
      </p>
      {row.prefillRemainingQuantity == null ? (
        <p className="text-[11px] text-amber-800/85">
          Remaining Zoho PO-line quantity is unavailable. Enter the adjusted receive quantity manually.
        </p>
      ) : null}

      {!open ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(true)}
          className="rounded border border-amber-500 bg-white px-3 py-1 font-medium hover:bg-amber-100 disabled:opacity-50"
        >
          Resolve overs
        </button>
      ) : (
        <div className="space-y-2 rounded border border-amber-400 bg-white p-2">
          {/* Adjust down */}
          <label className="block">
            <input
              type="radio"
              name="overs-decision"
              checked={picked === "adjust_down"}
              onChange={() => setPicked("adjust_down")}
              disabled={pending}
            />{" "}
            <span className="font-medium">Adjust down to remaining</span>
            <p className="ml-5 text-[11px] text-text-muted">
              Send a smaller receive to Zoho. The bag&apos;s intake count stays at
              the vendor-shipped quantity; the difference will need to be reconciled
              elsewhere (typically a future overs PO).
            </p>
            {picked === "adjust_down" ? (
              <div className="ml-5 mt-1 space-y-1">
                <label className="block text-[11px]">
                  Adjusted receive quantity
                  <input
                    type="number"
                    min={1}
                    max={currentQty - 1}
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    placeholder={
                      row.prefillRemainingQuantity != null
                        ? String(row.prefillRemainingQuantity)
                        : `Less than ${currentQty}`
                    }
                    disabled={pending}
                    className="block w-32 mt-0.5 rounded border border-amber-300 px-2 py-1"
                  />
                </label>
                <label className="block text-[11px]">
                  Reason (required, ≤ 500 chars)
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={pending}
                    rows={2}
                    className="block w-full mt-0.5 rounded border border-amber-300 px-2 py-1"
                  />
                </label>
              </div>
            ) : null}
          </label>

          {/* Hold for PO update */}
          <label className="block">
            <input
              type="radio"
              name="overs-decision"
              checked={picked === "hold_for_po_update"}
              onChange={() => setPicked("hold_for_po_update")}
              disabled={pending}
            />{" "}
            <span className="font-medium">Hold until PO is updated</span>
            <p className="ml-5 text-[11px] text-text-muted">
              Park this receive while Procurement bumps the PO line in Zoho. Unhold once the PO has been updated to retry.
            </p>
            {picked === "hold_for_po_update" ? (
              <label className="ml-5 mt-1 block text-[11px]">
                Reason (required, ≤ 500 chars)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={pending}
                  rows={2}
                  className="block w-full mt-0.5 rounded border border-amber-300 px-2 py-1"
                />
              </label>
            ) : null}
          </label>

          {/* Needs overs PO */}
          <label className="block">
            <input
              type="radio"
              name="overs-decision"
              checked={picked === "needs_overs_po"}
              onChange={() => setPicked("needs_overs_po")}
              disabled={pending}
            />{" "}
            <span className="font-medium">Mark for overs PO</span>
            <p className="ml-5 text-[11px] text-text-muted">
              Tag this receive for a future overs PO. It stays parked here and surfaces in the &ldquo;Awaiting overs PO&rdquo; list.
            </p>
            {picked === "needs_overs_po" ? (
              <label className="ml-5 mt-1 block text-[11px]">
                Note (optional, ≤ 500 chars)
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={pending}
                  rows={2}
                  className="block w-full mt-0.5 rounded border border-amber-300 px-2 py-1"
                />
              </label>
            ) : null}
          </label>

          {/* Reconciled manually */}
          <label className="block">
            <input
              type="radio"
              name="overs-decision"
              checked={picked === "reconciled_manually"}
              onChange={() => setPicked("reconciled_manually")}
              disabled={pending}
            />{" "}
            <span className="font-medium">Reconcile manually (terminal void)</span>
            <p className="ml-5 text-[11px] text-text-muted">
              You&apos;re handling this outside Luma. The receive is voided. Cannot be undone from here.
            </p>
            {picked === "reconciled_manually" ? (
              <label className="ml-5 mt-1 block text-[11px]">
                Reason (required, ≤ 500 chars)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={pending}
                  rows={2}
                  className="block w-full mt-0.5 rounded border border-amber-300 px-2 py-1"
                />
              </label>
            ) : null}
          </label>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={pending}
              onClick={submit}
              className="rounded border border-brand-700 bg-brand-700 px-3 py-1 font-medium text-white hover:bg-brand-800 disabled:opacity-50"
            >
              Apply decision
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setMessage(null);
              }}
              className="rounded border border-amber-400 bg-white px-3 py-1 font-medium hover:bg-amber-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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
