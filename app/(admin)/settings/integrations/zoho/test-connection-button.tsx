"use client";

// ZOHO-1 — "Test gateway connection" button. Calls the
// runConnectivityCheckAction server action and surfaces the structured
// result inline. Never displays the gateway secret.

import * as React from "react";
import { Plug, CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runConnectivityCheckAction, type ConnectivityCheckResult } from "./actions";

export function TestConnectionButton({ disabled }: { disabled?: boolean }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ConnectivityCheckResult | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          const r = await runConnectivityCheckAction();
          setPending(false);
          setResult(r);
        }}
      >
        <Plug className="h-3.5 w-3.5" /> {pending ? "Probing…" : "Test gateway connection"}
      </Button>
      {result ? <ResultBlock result={result} /> : null}
    </div>
  );
}

function ResultBlock({ result }: { result: ConnectivityCheckResult }) {
  if (result.kind === "error") {
    return (
      <div className="text-[12px] text-red-700 inline-flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" /> {result.message}
      </div>
    );
  }

  const tone =
    result.gatewayStatus === "CONNECTED" && (result.orgsKind === "OK" || result.orgsKind === "SKIPPED")
      ? "good"
      : result.gatewayStatus === "CONNECTED"
        ? "warn"
        : "error";

  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="inline-flex items-center gap-1.5">
        {tone === "good" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
        ) : tone === "warn" ? (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-red-700" />
        )}
        <span className="font-medium">Gateway: {result.gatewayStatus}</span>
        <span className="text-text-muted">
          {result.gatewayElapsedMs != null ? `${result.gatewayElapsedMs} ms` : ""}
        </span>
      </div>
      <p className="text-text-muted">{result.gatewayMessage}</p>
      {result.gatewayStatus === "CONNECTED" ? (
        <div>
          <div className="inline-flex items-center gap-1.5">
            <span className="font-medium">Organizations:</span>{" "}
            <span>{result.orgsKind}</span>
            {result.orgsCount > 0 ? (
              <span className="text-text-muted">({result.orgsCount})</span>
            ) : null}
          </div>
          {result.orgsMessage ? (
            <p className="text-text-muted">{result.orgsMessage}</p>
          ) : null}
          {result.orgs.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {result.orgs.map((o) => (
                <li key={o.id} className="font-mono text-[11px]">
                  <span className="text-text-muted">{o.id}</span>{" "}
                  <span className="text-text">— {o.name}</span>
                  {o.state ? (
                    <span className="text-text-muted"> · {o.state}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-[10px] text-text-subtle">
        Run id: <span className="font-mono">{result.runId.slice(0, 8)}…</span> · refresh the page to see the latest run row.
      </p>
    </div>
  );
}
