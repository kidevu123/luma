"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { endOperatorSessionAction } from "./operator-session-actions";
import {
  STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  isOperatorSessionIdle,
} from "@/lib/kiosk/idle-timeout";

/**
 * Auto-closes an open operator session after idle timeout so a
 * walked-away shift cannot silently attribute overnight taps.
 * Reuses endOperatorSessionAction (same path as End shift). When
 * blister stations refuse because a bag needs a shift-end pause,
 * the session stays open and the idle timer resets.
 */
export function IdleOperatorGuard({
  token,
  stationId,
}: {
  token: string;
  stationId: string;
}) {
  const router = useRouter();
  const lastActivityRef = React.useRef(Date.now());
  const closingRef = React.useRef(false);

  React.useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "touchstart",
      "keydown",
      "mousemove",
      "scroll",
    ];
    for (const ev of events) {
      window.addEventListener(ev, bump, { passive: true });
    }

    const tickMs = 30_000;
    const id = window.setInterval(() => {
      if (closingRef.current) return;
      if (
        !isOperatorSessionIdle(
          lastActivityRef.current,
          Date.now(),
          STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS,
        )
      ) {
        return;
      }
      closingRef.current = true;
      void (async () => {
        try {
          const fd = new FormData();
          fd.set("token", token);
          fd.set("stationId", stationId);
          const result = await endOperatorSessionAction(fd);
          if (result?.error) {
            // e.g. blister bag needs shift-end pause — keep session,
            // reset idle so we do not hammer the action.
            lastActivityRef.current = Date.now();
            return;
          }
          router.refresh();
        } catch {
          lastActivityRef.current = Date.now();
        } finally {
          closingRef.current = false;
        }
      })();
    }, tickMs);

    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, bump);
      }
      window.clearInterval(id);
    };
  }, [token, stationId, router]);

  return null;
}
