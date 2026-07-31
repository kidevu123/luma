"use client";

import * as React from "react";
import {
  KIOSK_BUILD_POLL_INTERVAL_MS,
  shouldReloadForDeployDrift,
} from "@/lib/kiosk/deploy-drift";

/**
 * Floor kiosk shell — wake lock, offline banner, deploy-drift reload.
 * Mounted once in the station layout so every /floor/[token]/* page
 * gets the same long-lived-tab defenses.
 */
export function KioskShell({ servedSha }: { servedSha: string }) {
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  React.useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let cancelled = false;

    async function requestWakeLock() {
      if (cancelled) return;
      const api = navigator.wakeLock;
      if (!api || typeof api.request !== "function") return;
      try {
        wakeLock = await api.request("screen");
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
        });
      } catch {
        // Unsupported / denied — kiosk OS settings own always-on.
      }
    }

    void requestWakeLock();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void wakeLock?.release();
      wakeLock = null;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetch("/api/kiosk/build-info", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { sha?: unknown };
        const remoteSha =
          typeof body.sha === "string" ? body.sha : "";
        if (shouldReloadForDeployDrift(servedSha, remoteSha)) {
          window.location.reload();
        }
      } catch {
        // Offline / transient — offline banner covers visibility.
      }
    }

    const id = window.setInterval(() => {
      void poll();
    }, KIOSK_BUILD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [servedSha]);

  if (!offline) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 bg-red-700 px-4 py-3 text-center text-sm font-semibold text-white shadow-md"
    >
      No connection — taps will not save
    </div>
  );
}
