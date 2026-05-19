"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ZohoAssemblyOpStatus } from "@/lib/db/queries/zoho-assembly";
import { resetToPendingAction, resolveManuallyAction } from "./actions";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function OpActionsPanel({
  id,
  status,
}: {
  id: string;
  status: ZohoAssemblyOpStatus;
}) {
  const router = useRouter();
  const [isResetPending, startResetTransition] = useTransition();
  const [isResolvePending, startResolveTransition] = useTransition();

  const [resetError, setResetError] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteValidationError, setNoteValidationError] = useState<string | null>(null);

  const canReset = status === "FAILED" || status === "NEEDS_MAPPING";
  const canResolve = status !== "SUCCEEDED" && status !== "SKIPPED";

  function handleReset() {
    setResetError(null);
    setResolveError(null);
    startResetTransition(async () => {
      const result = await resetToPendingAction(id);
      if (result.error) {
        setResetError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function handleResolve(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResolveError(null);
    setResetError(null);
    setNoteValidationError(null);

    if (!note.trim()) {
      setNoteValidationError("A resolution note is required.");
      return;
    }

    startResolveTransition(async () => {
      const result = await resolveManuallyAction(id, note);
      if (result.error) {
        setResolveError(result.error);
      } else {
        setNote("");
        router.refresh();
      }
    });
  }

  if (!canReset && !canResolve) return null;

  return (
    <div className="space-y-4">
      {canReset && (
        <Card>
          <CardHeader>
            <CardTitle>Reset to Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text-muted mb-3">
              Clears the error and re-queues this op for the worker to retry.
            </p>
            {resetError && (
              <p className="mb-3 text-sm text-danger-700 bg-danger-50 border border-danger-200 rounded px-3 py-2">
                {resetError}
              </p>
            )}
            <button
              type="button"
              onClick={handleReset}
              disabled={isResetPending}
              className="h-9 w-full rounded-md bg-brand-700 hover:bg-brand-800 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {isResetPending ? "Resetting…" : "Reset to Pending"}
            </button>
          </CardContent>
        </Card>
      )}

      {canResolve && (
        <Card>
          <CardHeader>
            <CardTitle>Mark Resolved</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text-muted mb-3">
              Manually mark this op as resolved. Use when the issue has been handled outside of the automated flow.
            </p>
            <form onSubmit={handleResolve} className="space-y-3">
              <div>
                <label
                  htmlFor="resolve-note"
                  className="block text-[10px] uppercase tracking-[0.12em] font-semibold text-text-subtle mb-1"
                >
                  Resolution Note
                </label>
                <textarea
                  id="resolve-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="Describe how this was resolved…"
                  disabled={isResolvePending}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700/20 disabled:opacity-50 resize-none"
                />
                {noteValidationError && (
                  <p className="mt-1 text-xs text-danger-700">{noteValidationError}</p>
                )}
              </div>
              {resolveError && (
                <p className="text-sm text-danger-700 bg-danger-50 border border-danger-200 rounded px-3 py-2">
                  {resolveError}
                </p>
              )}
              <button
                type="submit"
                disabled={isResolvePending}
                className="h-9 w-full rounded-md border border-border bg-surface hover:bg-surface-2 disabled:opacity-50 text-sm font-medium text-text transition-colors"
              >
                {isResolvePending ? "Saving…" : "Mark Resolved"}
              </button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
