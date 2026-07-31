// Pure idle-timeout helpers for station operator sessions on kiosk
// tablets. Threshold lives next to other session constants in
// station-operator-session.ts; this module only does the math.

import { STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MINUTES } from "@/lib/production/station-operator-session";

export const STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS =
  STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;

/** True when lastActivity is at least timeoutMs before now. */
export function isOperatorSessionIdle(
  lastActivityAtMs: number,
  nowMs: number,
  timeoutMs: number = STATION_OPERATOR_SESSION_IDLE_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastActivityAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  if (timeoutMs <= 0) return false;
  return nowMs - lastActivityAtMs >= timeoutMs;
}
