"use client";

import * as React from "react";
import { CheckCircle2, AlertTriangle, X as XIcon, ChevronDown } from "lucide-react";
import { setStatusAction, openHoldAction } from "./actions";
import { Button } from "@/components/ui/button";

export function StatusActions({
  batchId,
  status,
}: {
  batchId: string;
  status: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [holdOpen, setHoldOpen] = React.useState(false);
  const [holdReason, setHoldReason] = React.useState("");

  async function call(next: string) {
    setPending(true);
    await setStatusAction(batchId, next);
    setPending(false);
    setOpen(false);
  }

  return (
    <div className="relative inline-flex items-center gap-1.5">
      {status === "QUARANTINE" && (
        <Button size="sm" variant="primary" disabled={pending} onClick={() => call("RELEASED")}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Release
        </Button>
      )}
      {status === "RELEASED" && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setHoldOpen(true)}>
          <AlertTriangle className="h-3.5 w-3.5" /> Hold
        </Button>
      )}
      {(status === "ON_HOLD" || status === "RELEASED") && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(!open)}>
          More <ChevronDown className="h-3 w-3" />
        </Button>
      )}
      {open && (
        <div
          className="absolute right-0 top-9 z-10 w-44 rounded-md border border-border bg-surface shadow-md py-1"
          onClick={() => setOpen(false)}
        >
          {status === "ON_HOLD" && (
            <button
              type="button"
              onClick={() => call("RELEASED")}
              className="block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
            >
              Release
            </button>
          )}
          <button
            type="button"
            onClick={() => call("RECALLED")}
            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 text-red-700"
          >
            Recall
          </button>
          <button
            type="button"
            onClick={() => call("EXPIRED")}
            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
          >
            Mark expired
          </button>
          <button
            type="button"
            onClick={() => call("DEPLETED")}
            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2"
          >
            Mark depleted
          </button>
        </div>
      )}

      {holdOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => !pending && setHoldOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-surface shadow-xl border border-border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold tracking-tight">Place batch on hold</h3>
              <button onClick={() => !pending && setHoldOpen(false)} className="text-text-subtle hover:text-text">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="Reason — visible on the batch detail audit trail."
              rows={4}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-700/30"
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={() => !pending && setHoldOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending || !holdReason.trim()}
                onClick={async () => {
                  setPending(true);
                  await openHoldAction(batchId, holdReason);
                  setPending(false);
                  setHoldOpen(false);
                  setHoldReason("");
                }}
              >
                {pending ? "Saving…" : "Place on hold"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
