"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ZohoAssemblyOpStatus } from "@/lib/db/queries/zoho-assembly";
import { resetToPendingAction, resolveManuallyAction } from "./actions";
import { dryRunValidationAction } from "./dry-run-action";
import type { DryRunOperationResult } from "@/lib/zoho/dry-run-client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function OpActionsPanel({
  id,
  status,
  dryRunEnabled,
}: {
  id: string;
  status: ZohoAssemblyOpStatus;
  dryRunEnabled: boolean;
}) {
  const router = useRouter();
  const [isResetPending, startResetTransition] = useTransition();
  const [isResolvePending, startResolveTransition] = useTransition();
  const [isDryRunPending, startDryRunTransition] = useTransition();

  const [resetError, setResetError] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteValidationError, setNoteValidationError] = useState<string | null>(null);

  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunOperationResult | null>(null);

  const canReset = status === "FAILED" || status === "NEEDS_MAPPING";
  const canResolve = status !== "SUCCEEDED" && status !== "SKIPPED";
  const canDryRun =
    status === "PENDING" ||
    status === "NEEDS_MAPPING" ||
    status === "FAILED" ||
    status === "IN_PROGRESS";

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

  function handleDryRun() {
    setDryRunError(null);
    setDryRunResult(null);
    startDryRunTransition(async () => {
      const response = await dryRunValidationAction(id);
      if (response.error) {
        setDryRunError(response.error);
      } else if (response.result) {
        setDryRunResult(response.result);
        router.refresh();
      }
    });
  }

  if (!canReset && !canResolve && !canDryRun) return null;

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

      {canDryRun && (
        <Card>
          <CardHeader>
            <CardTitle>Dry-run Validation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text-muted mb-3">
              Validates the payload and calls the Zoho Integration Service with{" "}
              <span className="font-mono text-xs">dry_run=true</span>. No status changes
              or retries are recorded.
            </p>

            {!dryRunEnabled ? (
              <>
                <button
                  type="button"
                  disabled
                  className="h-9 w-full rounded-md border border-border bg-surface disabled:opacity-40 text-sm font-medium text-text-subtle transition-colors mb-2"
                >
                  Run Dry-Run Validation
                </button>
                <p className="text-xs text-text-muted">
                  Dry-run validation is disabled. Set{" "}
                  <span className="font-mono">ZOHO_DRY_RUN_WRITES_ENABLED=true</span> to enable.
                </p>
              </>
            ) : (
              <>
                {dryRunError && (
                  <p className="mb-3 text-sm text-danger-700 bg-danger-50 border border-danger-200 rounded px-3 py-2">
                    {dryRunError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleDryRun}
                  disabled={isDryRunPending}
                  className="h-9 w-full rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 text-sm font-medium text-amber-800 transition-colors"
                >
                  {isDryRunPending ? "Running…" : "Run Dry-Run Validation"}
                </button>
              </>
            )}

            {dryRunResult && (
              <div className="mt-4 space-y-2">
                <p className="text-[10px] uppercase tracking-[0.12em] font-bold text-amber-700">
                  DRY RUN ONLY — NOT EXECUTED IN ZOHO
                </p>
                <DryRunResultDisplay result={dryRunResult} />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DryRunResultDisplay({ result }: { result: DryRunOperationResult }) {
  if (result.kind === "GUARD_DISABLED") {
    return (
      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
        <p className="text-sm font-medium text-amber-800">Dry-run is currently disabled.</p>
        <p className="text-sm text-amber-700 mt-0.5">{result.message}</p>
      </div>
    );
  }

  if (result.kind === "OP_NOT_FOUND") {
    return (
      <div className="rounded-md bg-danger-50 border border-danger-200 px-3 py-2">
        <p className="text-sm font-medium text-danger-700">Operation not found.</p>
      </div>
    );
  }

  if (result.kind === "PAYLOAD_BLOCKED") {
    return (
      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 space-y-2">
        <p className="text-sm font-medium text-amber-800">
          Validation blocked. Missing fields:
        </p>
        <ul className="space-y-1">
          {result.blockers.map((blocker, i) => (
            <li key={i} className="text-sm text-amber-700">
              <span className="font-mono text-xs font-semibold">{blocker.field}</span>:{" "}
              {blocker.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (result.kind === "SERVICE_ERROR") {
    return (
      <div className="rounded-md bg-danger-50 border border-danger-200 px-3 py-2">
        <p className="text-sm font-medium text-danger-700">
          Zoho Integration Service error{result.httpStatus != null ? ` (HTTP ${result.httpStatus})` : ""}:
        </p>
        <p className="text-sm text-danger-700 mt-0.5">{result.message}</p>
      </div>
    );
  }

  // kind === "OK"
  return (
    <div className="rounded-md bg-good-50 border border-good-200 px-3 py-2 space-y-2">
      <p className="text-sm font-medium text-good-700">
        Dry-run validation passed (HTTP {result.httpStatus}).
      </p>
      {result.warnings.length > 0 && (
        <ul className="space-y-1">
          {result.warnings.map((warning, i) => (
            <li key={i} className="text-xs text-amber-700">
              <span className="font-mono font-semibold">{warning.field}</span>:{" "}
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
