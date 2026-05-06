"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

// Error boundary for every page under /(admin). Replaces the generic
// "Application error / Digest: …" with the actual message + stack so
// we can chase server-side bugs without grepping logs.
//
// In production this will only fire when a server component throws
// during render. The full stack comes through error.stack; the
// digest helps us cross-reference with logs if needed.

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Surface to the browser console too so it's visible in DevTools.
    console.error("[admin error boundary]", error);
  }, [error]);

  return (
    <div className="m-4 sm:m-6 lg:m-8 max-w-3xl">
      <div className="rounded-xl border border-red-200 bg-red-50 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="h-5 w-5 text-red-600 mt-0.5 shrink-0"
            aria-hidden
          />
          <div className="flex-1 min-w-0 space-y-2">
            <div>
              <h2 className="text-sm font-semibold text-red-900">
                Page failed to render
              </h2>
              <p className="text-xs text-red-700/80 mt-0.5">
                {error.message ?? "Unknown error"}
              </p>
            </div>
            {error.digest && (
              <p className="text-[11px] text-red-700/70 font-mono">
                digest: {error.digest}
              </p>
            )}
            {error.stack && (
              <details className="text-[11px] text-red-900/80">
                <summary className="cursor-pointer font-medium">
                  Stack trace
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words leading-relaxed font-mono">
                  {error.stack}
                </pre>
              </details>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={reset}
              >
                Try again
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => (window.location.href = "/dashboard")}
              >
                Back to dashboard
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
