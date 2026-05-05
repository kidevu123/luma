"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setFinishedLotStatusAction } from "../actions";

// Status transitions for a finished lot. Allowed moves:
//   PENDING_QC ↔ ON_HOLD     (QA flag / clear)
//   PENDING_QC → RELEASED    (QA approve)
//   RELEASED   → SHIPPED     (ops mark shipped)
//   any        → RECALLED    (admin only, with required reason)

type Status = "PENDING_QC" | "RELEASED" | "ON_HOLD" | "SHIPPED" | "RECALLED";

const ALLOWED: Record<Status, { next: Status; label: string; danger?: boolean; needsReason?: boolean }[]> = {
  PENDING_QC: [
    { next: "RELEASED", label: "Approve & release" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  ON_HOLD: [
    { next: "PENDING_QC", label: "Clear hold" },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  RELEASED: [
    { next: "SHIPPED", label: "Mark shipped" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  SHIPPED: [{ next: "RECALLED", label: "Recall", danger: true, needsReason: true }],
  RECALLED: [],
};

export function StatusActions({ lotId, status }: { lotId: string; status: string }) {
  const moves = ALLOWED[status as Status] ?? [];
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = React.useState<{ next: Status; label: string } | null>(
    null,
  );
  const [reason, setReason] = React.useState("");

  async function go(next: Status, withReason?: string) {
    setPending(next);
    setError(null);
    const r = await setFinishedLotStatusAction({
      id: lotId,
      status: next,
      reason: withReason,
    });
    setPending(null);
    if (r?.error) setError(r.error);
    else {
      setReasonOpen(null);
      setReason("");
    }
  }

  if (moves.length === 0) {
    return (
      <p className="text-xs text-text-muted">
        Lot is in a terminal state — no further transitions.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {moves.map((m) => (
        <Button
          key={m.next}
          variant={m.danger ? "destructive" : m.next === "RELEASED" ? "primary" : "secondary"}
          size="sm"
          className="w-full"
          disabled={pending !== null}
          onClick={() => {
            if (m.needsReason) setReasonOpen({ next: m.next, label: m.label });
            else go(m.next);
          }}
        >
          {pending === m.next ? "Working…" : m.label}
        </Button>
      ))}

      {reasonOpen && (
        <div className="rounded-md border border-border/70 bg-surface-2/50 p-2.5 space-y-2">
          <p className="text-xs font-medium">{reasonOpen.label} — reason</p>
          <Input
            placeholder="Required"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setReasonOpen(null);
                setReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              variant={
                reasonOpen.next === "RECALLED" ? "destructive" : "primary"
              }
              disabled={!reason.trim() || pending !== null}
              onClick={() => go(reasonOpen.next, reason.trim())}
            >
              Confirm
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}
    </div>
  );
}
