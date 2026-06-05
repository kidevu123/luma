"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type FloorLiveStatus = "connecting" | "live" | "polling" | "stale";

const POLL_MS = 20_000;
const STALE_MS = 45_000;

/** SSE floor events + 20s poll so the board stays fresh even when notify is quiet. */
export function useFloorLiveRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<FloorLiveStatus>("connecting");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const lastRefreshRef = useRef<number>(Date.now());

  const refresh = useCallback(() => {
    lastRefreshRef.current = Date.now();
    setLastUpdatedAt(lastRefreshRef.current);
    router.refresh();
  }, [router]);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let staleInterval: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;
    let closed = false;

    function debouncedRefresh() {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => refresh(), 200);
    }

    function startSSE() {
      es = new EventSource("/api/floor-board/stream");
      es.addEventListener("hello", () => setStatus("live"));
      es.addEventListener("floor", () => {
        setStatus("live");
        debouncedRefresh();
      });
      es.addEventListener("ping", () => setStatus("live"));
      es.onerror = () => {
        if (closed) return;
        es?.close();
        es = null;
        setStatus("polling");
        setTimeout(() => {
          if (!closed && !es) startSSE();
        }, 60_000);
      };
    }

    startSSE();
    pollInterval = setInterval(debouncedRefresh, POLL_MS);
    staleInterval = setInterval(() => {
      const age = Date.now() - lastRefreshRef.current;
      if (age > STALE_MS) setStatus("stale");
    }, 5_000);

    debouncedRefresh();

    return () => {
      closed = true;
      if (pending) clearTimeout(pending);
      if (pollInterval) clearInterval(pollInterval);
      if (staleInterval) clearInterval(staleInterval);
      es?.close();
    };
  }, [refresh]);

  return { status, lastUpdatedAt, refresh };
}
