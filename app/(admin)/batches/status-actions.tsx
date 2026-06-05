"use client";

import * as React from "react";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  RotateCcw,
  ShieldAlert,
  Unlock,
  X as XIcon,
} from "lucide-react";
import { setStatusAction, openHoldAction } from "./actions";
import { Button } from "@/components/ui/button";

export function StatusActions({
  batchId,
  status,
}: {
  batchId: string;
  status: string;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [holdOpen, setHoldOpen] = React.useState(false);
  const [holdReason, setHoldReason] = React.useState("");
  const [recallConfirmOpen, setRecallConfirmOpen] = React.useState(false);

  async function call(next: string, confirmRecallOverride = false) {
    setPending(true);
    setError(null);
    try {
      const r = await setStatusAction(batchId, next, undefined, confirmRecallOverride);
      if (r && "error" in r && r.error) setError(r.error);
      else {
        setMenuOpen(false);
        setRecallConfirmOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status change failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative inline-flex items-center justify-end gap-1">
      {status === "RELEASED" && (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => setHoldOpen(true)}
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Hold
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            More <ChevronDown className="h-3 w-3" />
          </Button>
        </>
      )}

      {status === "QUARANTINE" && (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => call("RELEASED")}
          >
            <Unlock className="h-3.5 w-3.5" /> Make available
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setHoldOpen(true)}
          >
            Hold
          </Button>
        </>
      )}

      {status === "ON_HOLD" && (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => call("RELEASED")}
          >
            <Unlock className="h-3.5 w-3.5" /> Release
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            More <ChevronDown className="h-3 w-3" />
          </Button>
        </>
      )}

      {(status === "RECALLED" || status === "EXPIRED" || status === "DEPLETED") && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (status === "RECALLED") setRecallConfirmOpen(true);
            else setMenuOpen(!menuOpen);
          }}
        >
          Actions <ChevronDown className="h-3 w-3" />
        </Button>
      )}

      {error && (
        <span className="ml-1 text-[11px] font-medium text-red-700" title={error}>
          {error.length > 28 ? error.slice(0, 26) + "…" : error}
        </span>
      )}

      {menuOpen && (
        <div
          className="absolute right-0 top-9 z-10 w-48 rounded-md border border-border bg-surface shadow-md py-1"
          onMouseLeave={() => setMenuOpen(false)}
        >
          {status === "RELEASED" && (
            <button
              type="button"
              onClick={() => call("QUARANTINE")}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2"
            >
              <Ban className="h-3 w-3" /> Quarantine / block
            </button>
          )}
          {(status === "RELEASED" || status === "ON_HOLD") && (
            <button
              type="button"
              onClick={() => call("RECALLED")}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2 text-red-700"
            >
              <ShieldAlert className="h-3 w-3" /> Recall
            </button>
          )}
          {(status === "RELEASED" || status === "ON_HOLD") && (
            <>
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
            </>
          )}
          {status === "RECALLED" && (
            <button
              type="button"
              onClick={() => setRecallConfirmOpen(true)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2 text-amber-800"
            >
              <RotateCcw className="h-3 w-3" /> Override recall (admin)
            </button>
          )}
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
              <h3 className="text-sm font-semibold tracking-tight">Place lot on hold</h3>
              <button
                onClick={() => !pending && setHoldOpen(false)}
                className="text-text-subtle hover:text-text"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-text-muted mb-2">
              Holds block production until cleared. Include a reason operators can see.
            </p>
            <textarea
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="Reason — visible on the audit trail."
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
                  setError(null);
                  try {
                    const r = await openHoldAction(batchId, holdReason);
                    if (r && "error" in r && r.error) {
                      setError(r.error);
                      return;
                    }
                    setHoldOpen(false);
                    setHoldReason("");
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Hold failed.");
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? "Saving…" : "Place on hold"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {recallConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => !pending && setRecallConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-surface shadow-xl border border-red-200 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold tracking-tight text-red-800 mb-2">
              Override recalled lot?
            </h3>
            <p className="text-xs text-text-muted mb-4">
              This lot was recalled. Releasing it makes it available for production again.
              Only proceed if QA has cleared the recall in writing.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => !pending && setRecallConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() => call("RELEASED", true)}
              >
                {pending ? "Saving…" : "Confirm release"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
