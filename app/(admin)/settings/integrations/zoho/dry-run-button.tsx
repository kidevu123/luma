"use client";

// ZOHO-2A — "Run item/customer dry-run" button.
//
// Calls runItemCustomerDryRunAction (server action). Surfaces:
//   - readiness label
//   - blocked reason (when NEEDS_REAUTH / NEEDS_SELECTION / etc.)
//   - counts (items + customers, per action category)
//   - preview rows (first 25 each)
//   - warnings
//
// Never displays the gateway secret.

import * as React from "react";
import { Play, CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  runItemCustomerDryRunAction,
  type ItemCustomerDryRunResult,
} from "./actions";

export function DryRunButton({ disabled }: { disabled?: boolean }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ItemCustomerDryRunResult | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          const r = await runItemCustomerDryRunAction();
          setPending(false);
          setResult(r);
        }}
      >
        <Play className="h-3.5 w-3.5" />{" "}
        {pending ? "Running…" : "Run item / customer dry-run"}
      </Button>
      {result ? <ResultBlock result={result} /> : null}
    </div>
  );
}

function ResultBlock({ result }: { result: ItemCustomerDryRunResult }) {
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
        {result.itemRunId ? (
          <p className="text-[10px] text-text-subtle">
            Run id: <span className="font-mono">{result.itemRunId.slice(0, 8)}…</span>{" "}
            (one PARTIAL ITEMS row written; no live fetch attempted).
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="inline-flex items-center gap-1.5 text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="font-medium">Dry-run complete · readiness: {result.readiness}</span>
      </div>
      <div className="font-mono">
        Items:&nbsp;
        scanned {result.counts.items.scanned} ·
        create {result.counts.items.createCandidates} ·
        update {result.counts.items.updateCandidates} ·
        no-change {result.counts.items.noChange} ·
        review {result.counts.items.needsReview} ·
        conflicts {result.counts.items.conflicts}
      </div>
      <div className="font-mono">
        Customers:&nbsp;
        scanned {result.counts.customers.scanned} ·
        create {result.counts.customers.createCandidates} ·
        update {result.counts.customers.updateCandidates} ·
        no-change {result.counts.customers.noChange} ·
        review {result.counts.customers.needsReview} ·
        conflicts {result.counts.customers.conflicts}
      </div>
      {result.warnings.items.length > 0 ? (
        <div>
          <span className="font-medium">Item warnings:</span>{" "}
          <ul className="list-disc pl-5">
            {result.warnings.items.map((w, i) => (
              <li key={`iw-${i}`}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.warnings.customers.length > 0 ? (
        <div>
          <span className="font-medium">Customer warnings:</span>{" "}
          <ul className="list-disc pl-5">
            {result.warnings.customers.map((w, i) => (
              <li key={`cw-${i}`}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.preview.items.length > 0 ? (
        <details>
          <summary className="font-medium cursor-pointer">
            Item preview (first {result.preview.items.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {result.preview.items.map((r) => (
              <li key={r.zohoItemId} className="font-mono">
                <span className="text-text-muted">{r.action.padEnd(18)}</span>{" "}
                <span>{r.zohoName}</span>{" "}
                <span className="text-text-muted">
                  ({r.sku ?? "no sku"} · {r.suggestedTarget})
                </span>
                {r.reasons.length > 0 ? (
                  <span className="text-amber-700"> {r.reasons.join(",")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.preview.customers.length > 0 ? (
        <details>
          <summary className="font-medium cursor-pointer">
            Customer preview (first {result.preview.customers.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {result.preview.customers.map((r) => (
              <li key={r.zohoCustomerId} className="font-mono">
                <span className="text-text-muted">{r.action.padEnd(18)}</span>{" "}
                <span>{r.zohoName}</span>{" "}
                <span className="text-text-muted">
                  ({r.customerCodeSuggestion ?? "no code"})
                </span>
                {r.reasons.length > 0 ? (
                  <span className="text-amber-700"> {r.reasons.join(",")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-[10px] text-text-subtle">
        Items run id:{" "}
        <span className="font-mono">{result.itemRunId.slice(0, 8)}…</span> · Customers run id:{" "}
        <span className="font-mono">{result.customerRunId.slice(0, 8)}…</span> · refresh page to
        update the summary block above.
      </p>
    </div>
  );
}
