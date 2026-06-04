/** Plain-language labels for floor board — no jargon. */

export function humanStage(stage: string | null | undefined): string {
  if (!stage) return "Stage unknown";
  const s = stage.toUpperCase();
  const map: Record<string, string> = {
    STARTED: "Received — not on a machine yet",
    BLISTERED: "Blistered — sitting between steps",
    SEALED: "Sealed — waiting for packaging",
    PACKAGED: "Packed — not finalized yet",
    FINALIZED: "Finalized",
  };
  return map[s] ?? stage.replace(/_/g, " ").toLowerCase();
}

export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Ignore cycle times from stuck/ghost bags when showing shift averages. */
export const MAX_TRUSTED_CYCLE_SEC = 8 * 3600;

export function trustedCycleSec(sec: number | null | undefined): number | null {
  if (sec == null || sec <= 0 || sec > MAX_TRUSTED_CYCLE_SEC) return null;
  return sec;
}

export function formatCycleSec(sec: number | null): string {
  if (sec == null || sec <= 0) return "—";
  return formatWait(Math.floor(sec / 60));
}

export function receiptLabel(
  receipt: string | null,
  fallbackId?: string | null,
): string {
  const r = receipt?.trim();
  if (r) return r;
  if (fallbackId) {
    const short = fallbackId.replace(/-/g, "").slice(-8).toUpperCase();
    return `ID ${short}`;
  }
  return "Missing receipt";
}
