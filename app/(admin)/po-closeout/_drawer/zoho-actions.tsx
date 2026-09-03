"use client";

// CLOSEOUT-DRAWER-1 — Zoho output queue/retry, inline. Calls the EXISTING
// zoho-production-operations server actions verbatim. Queueing keeps its
// explicit confirm; nothing is ever committed by this panel.

import * as React from "react";
import Link from "next/link";
import {
  queueProductionOutputOpAction,
  retryPreviewProductionOutputOpAction,
} from "@/app/(admin)/zoho-production-operations/actions";
import type { ProductSetupReadiness } from "@/lib/production/product-setup-readiness";

const QUEUEABLE_STATUSES = new Set(["READY", "FAILED"]);

export function ZohoActions({
  mode,
  op,
  setup,
  poId,
  onDone,
}: {
  mode: "QUEUE" | "RETRY";
  op: { id: string; status: string } | null;
  setup: ProductSetupReadiness | null;
  poId: string;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const blockers = setup?.missingFields.filter((f) => f.kind === "ZOHO_PUSH_BLOCKER") ?? [];

  // For QUEUE mode: the button is only enabled when the op is in a queueable state.
  const notQueueable =
    mode === "QUEUE" && op != null && !QUEUEABLE_STATUSES.has(op.status);

  return (
    <div className="rounded border border-border bg-surface px-3 py-2 space-y-1.5">
      <p className="text-[11px] font-semibold text-text-strong">
        {mode === "RETRY" ? "Retry Zoho preview" : "Queue Zoho output"}
      </p>
      <p className="text-[10.5px] text-text-muted">
        Queueing hands the op to the worker; nothing is committed by this
        click. Committing stays a separate, gated step.
      </p>
      {blockers.length > 0 ? (
        <ul className="space-y-0.5 text-[10.5px] text-warn-700">
          {blockers.map((b) => (
            <li key={b.code}>{b.label} — fix product setup first.</li>
          ))}
        </ul>
      ) : null}
      {!op ? (
        <p className="text-[10.5px] text-text-muted">
          No active op yet — create the preview from the Zoho operations page.
        </p>
      ) : (
        <>
          <p className="text-[10.5px]">
            Op <span className="font-mono text-[9.5px]">{op.id.slice(0, 8)}</span> —{" "}
            <span className="font-medium">{op.status}</span>
          </p>
          {notQueueable ? (
            <p className="text-[10.5px] text-text-muted">
              Cannot queue: op is {op.status} — resolve the blocker first (fix
              mapping / confirm the source bag&apos;s Zoho receive), then Retry preview.
            </p>
          ) : null}
          {mode === "QUEUE" && !notQueueable ? (
            <label className="flex items-start gap-2 text-[10.5px]">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>I confirm this output should be queued for Zoho.</span>
            </label>
          ) : null}
          {actionError ? (
            <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10.5px] text-red-800">
              {actionError}
            </p>
          ) : null}
          <button
            type="button"
            disabled={
              pending ||
              notQueueable ||
              (mode === "QUEUE" && (!confirmed || blockers.length > 0))
            }
            onClick={async () => {
              setPending(true);
              setActionError(null);
              const fd = new FormData();
              fd.set("opId", op.id);
              const result =
                mode === "RETRY"
                  ? await retryPreviewProductionOutputOpAction(fd)
                  : await queueProductionOutputOpAction(fd);
              setPending(false);
              if (!result.ok) {
                setActionError(result.error);
              } else {
                onDone();
              }
            }}
            className="rounded bg-brand-700 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Working…" : mode === "RETRY" ? "Retry preview" : "Queue for Zoho"}
          </button>
        </>
      )}
      <Link
        href={`/zoho-production-operations?po=${poId}`}
        className="inline-block text-[10.5px] font-medium text-brand-700 hover:underline"
      >
        Open Zoho operations
      </Link>
    </div>
  );
}
