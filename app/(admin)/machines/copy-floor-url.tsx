"use client";

import * as React from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

// Renders the full floor-PWA URL for a station and a one-click copy
// button. The base URL is read from window.location at render time so
// it adapts whether the operator's tablet sits on the LAN
// (192.168.x.x) or hits the app via a domain. Falls back to relative
// path display when the page isn't yet hydrated.

export function CopyFloorUrl({ token }: { token: string }) {
  const [copied, setCopied] = React.useState(false);
  const [base, setBase] = React.useState<string>("");

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      setBase(window.location.origin);
    }
  }, []);

  const path = `/floor/${token}`;
  const fullUrl = base ? `${base}${path}` : path;

  return (
    <div className="flex items-center gap-1.5">
      <code className="flex-1 truncate font-mono text-[11px] text-text-muted bg-surface-2/40 rounded px-1.5 py-0.5 max-w-[260px]">
        {fullUrl}
      </code>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(fullUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          } catch {
            /* clipboard refused — fall back to selecting the code */
          }
        }}
        title={copied ? "Copied" : "Copy URL"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button size="sm" variant="ghost" type="button" asChild title="Open in new tab">
        <a href={path} target="_blank" rel="noopener">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}
