import type { StationWithLive } from "@/lib/floor-command/types";

export type LiveStationStatus = "running" | "warning" | "idle" | "down";

export function getLiveStationStatus(station: StationWithLive): LiveStationStatus {
  if (!station.lastEventAt) return "idle";
  const now = Date.now();
  const age = now - new Date(station.lastEventAt).getTime();
  if (station.currentWorkflowBagId) {
    return age < 30 * 60 * 1000 ? "running" : "warning";
  }
  if (age > 30 * 60 * 1000) return "down";
  return age < 5 * 60 * 1000 ? "idle" : "down";
}

export function formatBusyTime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const LIVE_STATUS_STYLES: Record<
  LiveStationStatus,
  { border: string; badge: string; label: string; dot: string }
> = {
  running: {
    border: "border-emerald-500/50",
    badge: "bg-emerald-500/15 text-emerald-300",
    label: "Running",
    dot: "bg-emerald-400",
  },
  warning: {
    border: "border-amber-500/50",
    badge: "bg-amber-500/15 text-amber-300",
    label: "Warning",
    dot: "bg-amber-400",
  },
  idle: {
    border: "border-slate-600/40",
    badge: "bg-slate-800/80 text-slate-400",
    label: "Idle",
    dot: "bg-slate-500",
  },
  down: {
    border: "border-red-500/45",
    badge: "bg-red-500/15 text-red-300",
    label: "Down",
    dot: "bg-red-400",
  },
};
