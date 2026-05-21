"use client";

// QC-4 — correction trigger on a recent QC event row.
//
// Renders a "Correct" button; when clicked, expands an inline form
// that posts to submissionCorrectedAction. The original event stays
// in workflow_events untouched — SUBMISSION_CORRECTED is additive
// and links via corrected_event_id.
//
// Per QC-0 §4, the supervisor is recorded as entered_by_user_id; the
// linked event's accountable employee is preserved unchanged. The
// submissionCorrectedAction enforces this server-side.

import * as React from "react";
import { Pencil } from "lucide-react";
import { submissionCorrectedAction } from "./actions";

function newClientEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

const REASONS = [
  "TYPO",
  "WRONG_COUNT",
  "OPERATOR_ERROR",
  "SUPERVISOR_CORRECTION",
  "OTHER",
] as const;

export function CorrectionTrigger({
  eventId,
  eventType,
  originalValueJson,
}: {
  eventId: string;
  eventType: string;
  originalValueJson: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [reason, setReason] = React.useState<(typeof REASONS)[number]>(
    "SUPERVISOR_CORRECTION",
  );
  const [correctedValue, setCorrectedValue] = React.useState(originalValueJson);
  const [notes, setNotes] = React.useState("");

  async function submit() {
    setStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("clientEventId", newClientEventId());
    fd.set("correctedEventId", eventId);
    fd.set("correctedEventType", eventType);
    fd.set("correctionReason", reason);
    fd.set("originalValueJson", originalValueJson);
    fd.set("correctedValueJson", correctedValue.trim());
    if (notes.trim()) fd.set("notes", notes.trim());
    const r = await submissionCorrectedAction(fd);
    if (r.error) {
      setStatus({ kind: "error", message: r.error });
      return;
    }
    setStatus({ kind: "ok" });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-text-muted hover:bg-page"
      >
        <Pencil className="h-2.5 w-2.5" />
        Correct
      </button>
    );
  }

  if (status.kind === "ok") {
    return (
      <p className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
        Correction logged. Refresh to see in Recent.
      </p>
    );
  }

  return (
    <div className="w-72 space-y-2 rounded-lg border border-border bg-white p-3 text-xs">
      <p className="font-semibold">Correct submission</p>
      <p className="text-[11px] text-text-muted">
        Original event stays. Accountable employee preserved.
      </p>
      <label className="block">
        <span className="text-[11px] font-semibold text-text-muted">Reason</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
          className="mt-0.5 w-full rounded border border-border bg-page px-2 py-1.5 text-xs"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold text-text-muted">
          Corrected value (JSON)
        </span>
        <textarea
          rows={3}
          value={correctedValue}
          onChange={(e) => setCorrectedValue(e.target.value)}
          className="mt-0.5 w-full rounded border border-border bg-page px-2 py-1.5 font-mono text-[11px]"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold text-text-muted">
          Notes {reason === "OTHER" ? "(required for OTHER)" : "(optional)"}
        </span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Short note"
          className="mt-0.5 w-full rounded border border-border bg-page px-2 py-1.5 text-xs"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={status.kind === "pending"}
          onClick={() => void submit()}
          className="rounded border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
        >
          {status.kind === "pending" ? "Submitting…" : "Log correction"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setStatus({ kind: "idle" });
          }}
          className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-text-muted hover:bg-page"
        >
          Cancel
        </button>
      </div>
      {status.kind === "error" ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-900">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
