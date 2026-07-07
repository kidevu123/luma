"use client";

// CLOSEOUT-FRESHNESS-1 — keep operational command-center pages current.
//
// Server rendering is already per-request (force-dynamic + no-store), but an
// admin who leaves the tab open while data changes elsewhere (another page,
// another user, the floor PWA, or a direct ops repair) is looking at a stale
// snapshot until something triggers a reload. This component calls
// router.refresh() — a data-only RSC refetch, no full page reload, no scroll
// loss — when the tab regains focus/visibility and on a slow interval.
// Read-only: it only refetches; it never mutates.

import * as React from "react";
import { useRouter } from "next/navigation";

const MIN_REFRESH_GAP_MS = 15_000;

export function AutoRefreshOnFocus({
  intervalMs = 60_000,
}: {
  /** Background poll while the tab stays visible. 0 disables the interval. */
  intervalMs?: number;
}) {
  const router = useRouter();
  const lastRefreshRef = React.useRef<number>(Date.now());

  React.useEffect(() => {
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) return;
      lastRefreshRef.current = now;
      router.refresh();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer =
      intervalMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") refresh();
          }, intervalMs)
        : null;

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [router, intervalMs]);

  return null;
}
