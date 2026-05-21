"use client";

// LOT-1G — gated "Send to Nexus" button.
//
// Only renders when the server-side sendability gate passes. The
// underlying action enforces every gate too (defense in depth);
// the button hides itself purely as a UX courtesy.

import * as React from "react";
import { Send } from "lucide-react";
import { sendFinishedLotToNexusAction } from "./nexus-actions";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; sentAt: string; message: string | null }
  | { kind: "error"; message: string };

export function SendToNexusButton({
  finishedLotId,
  sendable,
  alreadySentAt,
  lastSendError,
}: {
  finishedLotId: string;
  sendable: boolean;
  alreadySentAt: string | null;
  lastSendError: string | null;
}) {
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  async function onSend() {
    setStatus({ kind: "pending" });
    const fd = new FormData();
    fd.set("finishedLotId", finishedLotId);
    const r = await sendFinishedLotToNexusAction(fd);
    if (r.ok) {
      setStatus({ kind: "ok", sentAt: r.sentAt, message: r.message });
    } else {
      setStatus({ kind: "error", message: r.error });
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={!sendable || status.kind === "pending"}
        onClick={onSend}
        title="Send to Nexus creates a customer-facing finished-lot record for issue reporting. It does not create a complaint ticket."
        className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-[12px] font-semibold ${
          sendable
            ? "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
            : "border-slate-300 bg-slate-100 text-slate-500 cursor-not-allowed"
        }`}
      >
        <Send className="h-3.5 w-3.5" />
        {status.kind === "pending"
          ? "Sending…"
          : alreadySentAt
            ? "Resend to Nexus"
            : "Send to Nexus"}
      </button>
      <p className="text-[10px] text-text-muted italic">
        Send to Nexus creates a customer-facing finished-lot record for
        issue reporting. It does not create a complaint ticket.
      </p>
      {alreadySentAt && (
        <p className="text-[11px] text-emerald-800">
          Sent to Nexus at {alreadySentAt}
        </p>
      )}
      {lastSendError && status.kind !== "ok" && (
        <p className="text-[11px] text-amber-800">
          Last send error: {lastSendError}
        </p>
      )}
      {status.kind === "ok" && (
        <p className="text-[11px] text-emerald-800">
          ✓ Sent at {status.sentAt}
          {status.message ? ` — ${status.message}` : ""}
        </p>
      )}
      {status.kind === "error" && (
        <p className="text-[11px] text-red-700">{status.message}</p>
      )}
    </div>
  );
}
