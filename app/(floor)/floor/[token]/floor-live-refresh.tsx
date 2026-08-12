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
      // Invariant: polling stops only when a live connection is
      // confirmed (this "hello"), never merely on a reconnect attempt.
      // A black-holed connection (e.g. WiFi drop that doesn't actively
      // refuse) never fires onerror, so clearing the poll fallback on
      // the retry itself — before the new EventSource proves it's
      // live — would leave the tablet with neither SSE nor polling,
      // silently stale for hours on unattended floor hardware.
      es.addEventListener("hello", () => {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      });
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
