"use client";

import * as React from "react";
import { Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { bulkReleaseQuarantinedAction, previewBulkReleaseAction } from "./actions";

export function BulkReleasePanel({ quarantineCount }: { quarantineCount: number }) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [preview, setPreview] = React.useState<{
    eligibleCount: number;
    skippedCount: number;
  } | null>(null);
  const [result, setResult] = React.useState<{
    releasedCount: number;
    skippedCount: number;
    skipped: Array<{ batchNumber: string; reason: string }>;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function loadPreview() {
    setError(null);
    const r = await previewBulkReleaseAction();
    if ("error" in r) {
      setError(r.error);
      return;
    }
    setPreview({ eligibleCount: r.eligibleCount, skippedCount: r.skippedCount });
  }

  async function runRelease() {
    setPending(true);
    setError(null);
    try {
      const r = await bulkReleaseQuarantinedAction();
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setResult({
        releasedCount: r.releasedCount,
        skippedCount: r.skippedCount,
        skipped: r.skipped,
      });
    } finally {
      setPending(false);
    }
  }

  if (quarantineCount === 0) return null;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setOpen(true); void loadPreview(); }}>
        <Unlock className="h-3.5 w-3.5" /> Release eligible quarantined lots
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => !pending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-surface shadow-xl border border-border p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Release eligible quarantined lots
              </h3>
              <p className="text-xs text-text-muted mt-1">
                Makes lots with quantity on hand available for production. Skips expired lots,
                open holds, and lots with QA block notes.
              </p>
            </div>

            {preview && !result && (
              <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs space-y-1">
                <div>
                  <span className="font-semibold tabular-nums">{preview.eligibleCount}</span>{" "}
                  eligible to release
                </div>
                <div className="text-text-muted">
                  <span className="tabular-nums">{preview.skippedCount}</span> will be skipped
                </div>
              </div>
            )}

            {result && (
              <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs space-y-2">
                <div>
                  Released{" "}
                  <span className="font-semibold tabular-nums">{result.releasedCount}</span> lots
                </div>
                {result.skippedCount > 0 && (
                  <div>
                    Skipped{" "}
                    <span className="tabular-nums">{result.skippedCount}</span>:
                    <ul className="mt-1 max-h-32 overflow-y-auto text-text-muted">
                      {result.skipped.slice(0, 20).map((s) => (
                        <li key={`${s.batchNumber}-${s.reason}`} className="font-mono text-[10px]">
                          {s.batchNumber}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                {result ? "Close" : "Cancel"}
              </Button>
              {!result && (
                <Button
                  disabled={pending || !preview || preview.eligibleCount === 0}
                  onClick={() => void runRelease()}
                >
                  {pending ? "Releasing…" : "Release eligible lots"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
