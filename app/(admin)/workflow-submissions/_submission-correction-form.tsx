"use client";

import * as React from "react";
import { useActionState } from "react";
import { Pencil } from "lucide-react";
import { workflowSubmissionCorrectAction } from "./actions";
import {
  SUBMISSION_CORRECTION_FIELDS,
  readSubmissionFieldValue,
  type CorrectableSubmissionEventType,
} from "@/lib/production/submission-correction-fields";

function newClientEventId(): string {
  return crypto.randomUUID();
}

const REASONS = [
  "TYPO",
  "WRONG_COUNT",
  "OPERATOR_ERROR",
  "SUPERVISOR_CORRECTION",
  "OTHER",
] as const;

export function SubmissionCorrectionForm({
  eventId,
  eventType,
  payload,
  bagFinalized,
}: {
  eventId: string;
  eventType: CorrectableSubmissionEventType;
  payload: Record<string, unknown>;
  bagFinalized: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState(
    workflowSubmissionCorrectAction,
    null,
  );

  const fields = SUBMISSION_CORRECTION_FIELDS[eventType];
  const [reason, setReason] = React.useState<(typeof REASONS)[number]>(
    "SUPERVISOR_CORRECTION",
  );
  const [notes, setNotes] = React.useState("");
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      const v = readSubmissionFieldValue(payload, f.key);
      init[f.key] = v !== null ? String(v) : "";
    }
    return init;
  });

  const fieldValuesJson = JSON.stringify(
    Object.fromEntries(
      fields.map((f) => [f.key, values[f.key] === "" ? null : Number(values[f.key])]),
    ),
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-text-muted hover:bg-surface-2"
      >
        <Pencil className="h-2.5 w-2.5" />
        Correct
      </button>
    );
  }

  if (state?.ok) {
    return (
      <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] text-emerald-900">
        Correction logged. Collapse and re-expand the row to refresh.
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-2 space-y-2 rounded border border-amber-200 bg-amber-50/60 p-2">
      <input type="hidden" name="clientEventId" value={newClientEventId()} />
      <input type="hidden" name="correctedEventId" value={eventId} />
      <input type="hidden" name="fieldValuesJson" value={fieldValuesJson} />
      <p className="text-[10px] font-semibold text-amber-950">Correct submission</p>
      {bagFinalized ? (
        <p className="text-[10px] text-amber-900 leading-snug">
          This bag is finalized. Corrected counts may mark the finished lot and Zoho output for review.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => {
          const orig = readSubmissionFieldValue(payload, f.key);
          return (
            <label key={f.key} className="block text-[10px]">
              <span className="font-medium text-text-muted">{f.label}</span>
              <div className="mt-0.5 flex items-center gap-1">
                <span className="font-mono text-[9px] text-text-subtle tabular-nums">
                  was {orig !== null ? orig : "—"}
                </span>
                <span className="text-text-subtle">→</span>
                <input
                  type="number"
                  min={0}
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  className="h-7 w-full rounded border border-border bg-white px-1.5 font-mono text-[11px] tabular-nums"
                />
              </div>
            </label>
          );
        })}
      </div>
      <label className="block text-[10px]">
        <span className="font-medium text-text-muted">Reason</span>
        <select
          name="correctionReason"
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[10px]">
        <span className="font-medium text-text-muted">
          Notes {reason === "OTHER" ? "(required)" : "(optional)"}
        </span>
        <input
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1 text-[11px]"
        />
      </label>
      {state?.error ? (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-800">
          {state.error}
        </p>
      ) : null}
      {state?.warnings?.map((w) => (
        <p key={w} className="rounded border border-amber-300 bg-amber-100 px-2 py-1 text-[10px] text-amber-950">
          {w}
        </p>
      ))}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-amber-800 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Log correction"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-border bg-surface px-2 py-1 text-[10px] text-text-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
