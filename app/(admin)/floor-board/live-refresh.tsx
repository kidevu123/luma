"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// Subscribes to /api/floor-board/stream and calls router.refresh() on
// each event. Falls back to 30s polling if SSE drops permanently.
//
// router.refresh() re-runs the server component without a full page
// nav, so the read-model queries re-execute and the UI swaps in fresh
// data. We debounce (200ms) so a burst of finalizations doesn't kick
// off N refreshes in a row.

export function LiveRefresh() {
  const router = useRouter();
  const [status, setStatus] = React.useState<"connecting" | "live" | "fallback">(
    "connecting",
  );

  React.useEffect(() => {
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;
    let closed = false;

    function debouncedRefresh() {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => {
        router.refresh();
      }, 200);
    }

    function startSSE() {
      es = new EventSource("/api/floor-board/stream");
      es.addEventListener("hello", () => setStatus("live"));
      es.addEventListener("floor", () => debouncedRefresh());
      es.addEventListener("ping", () => {
        // Heartbeat — nothing to do, just confirms the link is alive.
      });
      es.onerror = () => {
        if (closed) return;
        es?.close();
        es = null;
        // SSE retries automatically by reconnecting; if that also
        // fails, switch to polling so the board keeps updating.
        setStatus("fallback");
        if (!pollInterval) {
          pollInterval = setInterval(debouncedRefresh, 30_000);
        }
        // Try SSE again after a minute — proxies sometimes recover.
        setTimeout(() => {
          if (!closed && !es) {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = null;
            startSSE();
          }
        }, 60_000);
      };
    }

    startSSE();
    return () => {
      closed = true;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      if (pollInterval) clearInterval(pollInterval);
      es?.close();
    };
  }, [router]);

  return (
    <div className="text-[10px] text-text-subtle inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          status === "live"
            ? "bg-emerald-500 animate-pulse"
            : status === "connecting"
              ? "bg-amber-400"
              : "bg-text-subtle"
        }`}
      />
      {status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Polling"}
    </div>
  );
}
