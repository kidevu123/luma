"use client";

// ZOHO-GW-2 — "Test gateway connection" button. Calls
// runConnectivityCheckAction and surfaces gateway health + brand
// selection + per-product token status + overall readiness inline.
// Secret value never displayed.

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

  const Icon =
    result.readiness === "READY_FOR_DRY_RUN"
      ? CheckCircle2
      : result.readiness === "NEEDS_REAUTH" ||
          result.readiness === "NEEDS_SELECTION" ||
          result.readiness === "CONNECTED_HEALTH_ONLY"
        ? AlertTriangle
        : AlertCircle;
  const iconClass =
    result.readiness === "READY_FOR_DRY_RUN"
      ? "text-emerald-700"
      : result.readiness === "UNREACHABLE" ||
          result.readiness === "ERROR" ||
          result.readiness === "NOT_CONFIGURED"
        ? "text-red-700"
        : "text-amber-700";

  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="inline-flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
        <span className="font-medium">Readiness: {result.readiness}</span>
        <span className="text-text-muted">
          {result.gatewayElapsedMs != null ? `${result.gatewayElapsedMs} ms` : ""}
        </span>
      </div>
      <p className="text-text-muted">{result.readinessMessage}</p>

      <div>
        <span className="font-medium">Gateway: {result.gatewayStatus}</span>{" "}
        <span className="text-text-muted">— {result.gatewayMessage}</span>
      </div>

      <div>
        <span className="font-medium">Brand outcome:</span> {result.brandKind}
        {result.brandMessage ? (
          <span className="text-text-muted"> — {result.brandMessage}</span>
        ) : null}
      </div>

      {result.selectedBrand ? (
        <div className="mt-1">
          <span className="font-medium">Selected:</span>{" "}
          <span className="font-mono">{result.selectedBrand.brandKey}</span>
          {result.selectedBrand.organizationId ? (
            <>
              {" "}
              · org{" "}
              <span className="font-mono">
                {result.selectedBrand.organizationId}
              </span>
            </>
          ) : null}
          {result.selectedBrand.region ? (
            <span className="text-text-muted"> · {result.selectedBrand.region}</span>
          ) : null}
          {result.selectedBrand.products.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {result.selectedBrand.products.map((p) => (
                <li key={p.product} className="font-mono text-[11px]">
                  <span>{p.product.padEnd(12)}</span>
                  <span
                    className={
                      p.tokenStatus === "valid"
                        ? "text-emerald-700"
                        : p.tokenStatus === "expired"
                          ? "text-amber-700"
                          : "text-text-muted"
                    }
                  >
                    {p.tokenStatus}
                  </span>
                  {p.expiresAt ? (
                    <span className="text-text-muted ml-2">
                      expires {p.expiresAt.slice(0, 19).replace("T", " ")} UTC
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {result.availableBrands.length > 1 && !result.selectedBrand ? (
        <div className="mt-1">
          <span className="font-medium">Available brands:</span>{" "}
          <span className="font-mono">
            {result.availableBrands.map((b) => b.brandKey).join(", ")}
          </span>
        </div>
      ) : null}

      <p className="text-[10px] text-text-subtle">
        Run id: <span className="font-mono">{result.runId.slice(0, 8)}…</span> · refresh to see the row.
      </p>
    </div>
  );
}
