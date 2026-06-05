"use client";

import * as React from "react";
import { useActionState } from "react";
import { RouteOff } from "lucide-react";
import { workflowRecoveryAction } from "./actions";

type RecoveryKind = "WRONG_ROUTE" | "WRONG_PRODUCT" | "WRONG_QR_ASSIGNMENT";

export function WorkflowRecoveryForm({
  workflowBagId,
  bagFinalized,
  hasFinishedLot,
}: {
  workflowBagId: string;
  bagFinalized: boolean;
  hasFinishedLot: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState(workflowRecoveryAction, null);
  const [kind, setKind] = React.useState<RecoveryKind>("WRONG_ROUTE");
  const [confirmed, setConfirmed] = React.useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-800 hover:bg-red-100"
      >
        <RouteOff className="h-3 w-3" />
        Recover wrong route
      </button>
    );
  }

  if (state?.ok) {
    return (
      <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
        Recovery recorded. History is preserved; restart the correct workflow separately when ready.
      </p>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-3 space-y-2 rounded border border-red-200 bg-red-50/40 p-3"
    >
      <input type="hidden" name="workflowBagId" value={workflowBagId} />
      <input type="hidden" name="confirm" value={confirmed ? "true" : ""} />
      <p className="text-[11px] font-semibold text-red-900">Wrong route / assignment recovery</p>
      <p className="text-[10px] text-red-900/90 leading-snug">
        This does not erase history. It appends recovery events and may release the QR card so the
        correct workflow can be started.
        {bagFinalized || hasFinishedLot
          ? " This bag is finalized or has a finished lot — simple reset is blocked; output will be voided from sync and marked for review."
          : null}
      </p>
      <label className="block text-[10px]">
        <span className="font-medium">Recovery type</span>
        <select
          name="recoveryKind"
          value={kind}
          onChange={(e) => setKind(e.target.value as RecoveryKind)}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        >
          <option value="WRONG_ROUTE">Wrong route / wrong production type</option>
          <option value="WRONG_PRODUCT">Wrong product selected</option>
          <option value="WRONG_QR_ASSIGNMENT">Wrong QR / card / receipt assigned</option>
        </select>
      </label>
      <label className="block text-[10px]">
        <span className="font-medium">Detailed reason</span>
        <textarea
          name="reason"
          required
          minLength={10}
          rows={3}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
          placeholder="Example: Bag was run on cards but should have been bottles for SKU X."
        />
      </label>
      <label className="block text-[10px]">
        <span className="font-medium">Notes (optional)</span>
        <input
          name="notes"
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        />
      </label>
      <label className="flex items-start gap-2 text-[10px] text-red-950">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I confirm this recovery is intentional. Luma will append events only — not delete station
          history.
        </span>
      </label>
      {state?.error ? (
        <p className="rounded border border-red-300 bg-red-100 px-2 py-1 text-[10px] text-red-900">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !confirmed}
          className="rounded bg-red-800 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Recording…" : "Record recovery"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirmed(false);
          }}
          className="rounded border border-border bg-surface px-3 py-1.5 text-[10px] text-text-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
