"use client";

// QC-4 — receive rework action on an in-flight row.
//
// Two paths:
//   - Receive full remaining (sets partial=false when received total
//     equals sent; partial=true when this receive closes the row but
//     prior partials exist)
//   - Receive partial (operator-entered quantity, must be > 0 and
//     received_total <= sent_quantity — enforced client-side AND
//     server-side via the qc-events.ts refinement)
//
// Multiple partial receives stack; the loader sums them.

import * as React from "react";
import { Inbox } from "lucide-react";
import { adminReworkReceivedAction } from "./actions";
import { isPartialReceiveValid } from "@/lib/production/qc-review-loaders";

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

type Mode = "idle" | "partial";
type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; what: string }
  | { kind: "error"; message: string };

export function ReceiveReworkRow({
  linkedEventId,
  sentQuantity,
  priorReceivedSum,
  remaining,
  unit,
  reasonCode,
}: {
  linkedEventId: string;
  sentQuantity: number;
  priorReceivedSum: number;
  remaining: number;
  unit: string;
  reasonCode: string;
}) {
  const [mode, setMode] = React.useState<Mode>("idle");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [qty, setQty] = React.useState(remaining > 0 ? remaining : 1);

  async function submit(receiveQty: number) {
    const check = isPartialReceiveValid(sentQuantity, receiveQty, priorReceivedSum);
    if (!check.ok) {
      setStatus({ kind: "error", message: check.reason });
      return;
    }
    setStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("clientEventId", newClientEventId());
    fd.set("linkedEventId", linkedEventId);
    fd.set("sentQuantity", String(sentQuantity));
    fd.set("receivedQuantity", String(receiveQty));
    fd.set("unit", unit);
    fd.set("reasonCode", reasonCode);
    // partial=true when this receive does NOT fully close the row.
    const newTotal = priorReceivedSum + receiveQty;
    fd.set("partial", newTotal < sentQuantity ? "true" : "false");
    const r = await adminReworkReceivedAction(fd);
    if (r.error) {
      setStatus({ kind: "error", message: r.error });
      return;
    }
    setStatus({
      kind: "ok",
      what: newTotal < sentQuantity ? "Partial receive logged" : "Rework closed",
    });
  }

  if (status.kind === "ok") {
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
        {status.what}. Refresh to update list.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {mode === "idle" ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={status.kind === "pending"}
            onClick={() => void submit(remaining)}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-400 bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-200 disabled:opacity-50"
          >
            <Inbox className="h-3 w-3" />
            Receive full remaining ({remaining})
          </button>
          <button
            type="button"
            onClick={() => setMode("partial")}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted hover:bg-page"
          >
            Partial…
          </button>
        </div>
      ) : null}

      {mode === "partial" ? (
        <div className="w-72 space-y-2 rounded-lg border border-sky-200 bg-white p-3 text-xs">
          <p className="font-semibold text-sky-900">Receive partial</p>
          <p className="text-text-muted">
            {priorReceivedSum} of {sentQuantity} {unit} already received. Up to {remaining} can be received now.
          </p>
          <label className="block">
            <span className="text-[11px] font-semibold text-text-muted">Receive quantity</span>
            <input
              type="number"
              min={1}
              max={remaining}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value) || 1)}
              className="mt-0.5 w-full rounded border border-border bg-page px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={status.kind === "pending"}
              onClick={() => void submit(qty)}
              className="rounded border border-sky-400 bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-200 disabled:opacity-50"
            >
              {status.kind === "pending" ? "Submitting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setStatus({ kind: "idle" });
              }}
              className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-text-muted hover:bg-page"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {status.kind === "error" ? (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs text-rose-900">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
