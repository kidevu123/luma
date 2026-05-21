"use client";

// COMMERCIAL-TRACE-3 — "Run invoice dry-run" button.
//
// Mirrors the ZOHO-2A item/customer dry-run button. Calls
// runZohoInvoiceDryRunAction (server action). Surfaces:
//   - readiness label
//   - blocked reason when NEEDS_REAUTH / NEEDS_SELECTION / etc.
//   - counts (invoices + lines)
//   - preview rows (first 25 headers, 50 lines)
//   - warnings
//
// Never displays the gateway secret. Disabled when the gateway URL is
// not configured. When tokens are expired, the button is enabled so an
// operator can capture a blocked-state audit row; clicking it does NOT
// call /invoices/list or /invoices/get.

import * as React from "react";
import { Play, CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runZohoInvoiceDryRunAction,
  type InvoiceDryRunActionResult,
} from "./actions";

export function InvoiceDryRunButton({ disabled }: { disabled?: boolean }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<InvoiceDryRunActionResult | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          const r = await runZohoInvoiceDryRunAction();
          setPending(false);
          setResult(r);
        }}
      >
        <Play className="h-3.5 w-3.5" />{" "}
        {pending ? "Running…" : "Run invoice dry-run"}
      </Button>
      {result ? <ResultBlock result={result} /> : null}
    </div>
  );
}

function ResultBlock({ result }: { result: InvoiceDryRunActionResult }) {
  if (result.kind === "error") {
    return (
      <div className="text-[12px] text-red-700 inline-flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" /> {result.message}
      </div>
    );
  }

  if (result.kind === "blocked") {
    return (
      <div className="space-y-1 text-[12px]">
        <div className="inline-flex items-center gap-1.5 text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="font-medium">Blocked: {result.readiness}</span>
        </div>
        <p className="text-text-muted">{result.reason}</p>
        {result.runId ? (
          <p className="text-[10px] text-text-subtle">
            Run id: <span className="font-mono">{result.runId.slice(0, 8)}…</span>{" "}
            (one PARTIAL INVOICES row written; no /invoices/list or /invoices/get call attempted).
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="inline-flex items-center gap-1.5 text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="font-medium">
          Invoice dry-run complete · readiness: {result.readiness}
        </span>
      </div>
      <div className="font-mono">
        Invoices:&nbsp;
        scanned {result.counts.invoicesScanned} ·
        create {result.counts.createCandidates} ·
        update {result.counts.updateCandidates} ·
        no-change {result.counts.noChange} ·
        review {result.counts.needsReview} ·
        conflicts {result.counts.conflicts}
      </div>
      <div className="font-mono">
        Lines:&nbsp;
        scanned {result.counts.linesScanned}
      </div>
      {result.warnings.length > 0 ? (
        <div>
          <span className="font-medium">Warnings:</span>
          <ul className="list-disc pl-5">
            {result.warnings.map((w, i) => (
              <li key={`iw-${i}`}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.headers.length > 0 ? (
        <details>
          <summary className="font-medium cursor-pointer">
            Invoice header preview (first {result.headers.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {result.headers.map((h) => (
              <li key={h.zohoInvoiceId} className="font-mono">
                <span className="text-text-muted">{h.action.padEnd(18)}</span>{" "}
                <span>{h.invoiceNumber ?? "(no number)"}</span>{" "}
                <span className="text-text-muted">
                  ({h.customerName ?? "(no customer)"} · lines {h.lineCount})
                </span>
                {h.reasons.length > 0 ? (
                  <span className="text-amber-700"> {h.reasons.join(",")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.lines.length > 0 ? (
        <details>
          <summary className="font-medium cursor-pointer">
            Invoice line preview (first {result.lines.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {result.lines.map((ln, i) => (
              <li key={`l-${i}`} className="font-mono">
                <span className="text-text-muted">{ln.action.padEnd(18)}</span>{" "}
                <span>{ln.invoiceNumber ?? "(no number)"}</span>{" "}
                <span>{ln.itemName}</span>{" "}
                <span className="text-text-muted">
                  ({ln.sku ?? "no sku"} · qty {ln.quantity ?? "?"})
                </span>
                {ln.reasons.length > 0 ? (
                  <span className="text-amber-700"> {ln.reasons.join(",")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-[10px] text-text-subtle">
        Invoices run id:{" "}
        <span className="font-mono">{result.runId.slice(0, 8)}…</span> · refresh page to update the
        summary block above.
      </p>
    </div>
  );
}
