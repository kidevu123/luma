"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// P3-SSE-1 — invisible live refresher for the floor page. Subscribes to
// this station's token-authed stream and re-runs the server component on
// each relevant event (the server already filtered relevance). Renders
// nothing: Phase 3 ships zero visible change. Falls back to 60s polling
// if SSE dies, and keeps retrying SSE every 60s.
export function FloorLiveRefresh({ token }: { token: string }) {
  const router = useRouter();

  React.useEffect(() => {
    let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    let closed = false;

    function debouncedRefresh() {
      if (pendingRefresh) clearTimeout(pendingRefresh);
      pendingRefresh = setTimeout(() => router.refresh(), 200);
    }

    function startSSE() {
      es = new EventSource(`/floor/api/stream/${token}`);
      es.addEventListener("floor", () => debouncedRefresh());
      es.onerror = () => {
        if (closed) return;
        es?.close();
        es = null;
        if (!pollInterval) pollInterval = setInterval(debouncedRefresh, 60_000);
        if (!retryTimeout) {
          retryTimeout = setTimeout(() => {
            retryTimeout = null;
            if (closed) return;
            if (pollInterval) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
            startSSE();
          }, 60_000);
        }
      };
    }

    startSSE();
    return () => {
      closed = true;
      if (pendingRefresh) clearTimeout(pendingRefresh);
      if (pollInterval) clearInterval(pollInterval);
      if (retryTimeout) clearTimeout(retryTimeout);
      es?.close();
    };
  }, [router, token]);

  return null;
}
