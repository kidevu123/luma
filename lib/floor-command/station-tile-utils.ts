import type { StationCommandRow } from "@/lib/production/floor-manager-snapshot-types";

export type CardState = "running" | "warning" | "paused" | "idle" | "down";

export function actionItems(row: StationCommandRow): string[] {
  const items: string[] = [];
  if (row.isPaused) items.push("Paused");
  if (row.isOnHold) items.push("On hold");
  if (row.reworkPending) items.push("Rework pending");
  if (row.workflowBagId && !row.productName) items.push("Product not selected");
  if (
    row.workflowBagId &&
    !row.activeOperatorName &&
    !row.operatorName
  ) {
    items.push("No operator");
  }
  const needsBlister =
    row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER";
  if (needsBlister && row.machineId) {
    const hasPvc = row.activeRolls.some(
      (r) => r.materialRole === "PVC" || r.materialKind?.includes("PVC"),
    );
    const hasFoil = row.activeRolls.some(
      (r) => r.materialRole === "FOIL" || r.materialKind?.includes("FOIL"),
    );
    if (!hasPvc) items.push("PVC roll missing");
    if (!hasFoil) items.push("Foil roll missing");
  }
  if (!row.workflowBagId && (row.queueWip ?? 0) > 0) items.push("Queue waiting");
  if (!row.machineId && row.stationKind !== "PACKAGING") items.push("No machine");
  return items;
}

export function cardState(row: StationCommandRow, actions: string[]): CardState {
  if (!row.machineId && row.stationKind !== "PACKAGING") return "down";
  if (row.isPaused || row.isOnHold) return "paused";
  if (actions.some((a) => a.includes("missing") || a.includes("selected"))) {
    return "warning";
  }
  if (row.workflowBagId) return "running";
  if ((row.queueWip ?? 0) > 0) return "warning";
  return "idle";
}

export const CARD_STATE_LABEL: Record<CardState, string> = {
  running: "Running",
  warning: "Warning",
  paused: "Paused",
  idle: "Idle",
  down: "Down",
};

export function shiftTotalLabel(row: StationCommandRow): string {
  if (row.stationKind === "BLISTER" || row.stationKind === "HANDPACK_BLISTER") {
    return `${row.todayBlistered.toLocaleString()} blistered`;
  }
  if (row.stationKind === "SEALING" || row.stationKind === "COMBINED") {
    return `${row.todaySealed.toLocaleString()} sealed`;
  }
  if (row.stationKind === "PACKAGING") {
    return `${row.todayPackaged.toLocaleString()} packaged`;
  }
  if (row.stationKind === "BOTTLE_HANDPACK") {
    return `${row.todayFinalized.toLocaleString()} filled`;
  }
  return `${row.todayFinalized.toLocaleString()} done`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const left = minutes % 60;
  return left > 0 ? `${hours}h ${left}m` : `${hours}h`;
}

export function machineSubtitle(row: StationCommandRow): string {
  const parts = [
    row.machineName ?? row.machineKind ?? row.stationKind.replace(/_/g, " "),
  ];
  if (row.cardsPerTurn) parts.push(`${row.cardsPerTurn} cards/turn`);
  return parts.join(" · ");
}

export const TV_STATE_COLORS: Record<
  CardState,
  { state: string; border: string; glow: string }
> = {
  running: {
    state: "#45d49d",
    border: "rgba(69,212,157,.38)",
    glow: "rgba(69,212,157,.07)",
  },
  warning: {
    state: "#f3ad3d",
    border: "rgba(243,173,61,.42)",
    glow: "rgba(243,173,61,.06)",
  },
  paused: {
    state: "#ff9a51",
    border: "rgba(255,154,81,.44)",
    glow: "rgba(255,154,81,.06)",
  },
  idle: {
    state: "#66798c",
    border: "rgba(255,255,255,.08)",
    glow: "transparent",
  },
  down: {
    state: "#ff6b68",
    border: "rgba(255,107,104,.44)",
    glow: "rgba(255,107,104,.06)",
  },
};
