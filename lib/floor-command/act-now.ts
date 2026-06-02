// Actionable floor exceptions for the Act Now sidebar — pure
// composition from existing server bundles (no extra DB).

import type { AttentionItem } from "@/lib/floor-command/types";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";

export type ActNowSeverity = "crit" | "warn" | "info";

export type ActNowItem = {
  id: string;
  severity: ActNowSeverity;
  title: string;
  detail: string;
  href?: string;
};

function formatStage(stage: string | null): string {
  if (!stage) return "unknown stage";
  return stage.replace(/_/g, " ").toLowerCase();
}

function bottleneckLabel(intelligence: FloorProductionIntelligence): string {
  const b = intelligence.bottleneck.stageKey;
  if (b.confidence === "MISSING") return b.label ?? "—";
  const v = b.value;
  if (typeof v !== "string" || !v) return String(v ?? "—");
  return v.replace(/_/g, " ").toLowerCase();
}

/** Build prioritized act-now rows for shift leads. */
export function buildActNowPanel(
  snapshot: FloorManagerSnapshot,
  attention: AttentionItem[],
  intelligence: FloorProductionIntelligence,
): ActNowItem[] {
  const items: ActNowItem[] = [];
  const { plant } = snapshot;

  for (const bag of snapshot.inFlight.slice(0, 6)) {
    const sev: ActNowSeverity =
      bag.elapsedMinutes > 180 || bag.isOnHold
        ? "crit"
        : bag.elapsedMinutes > 60 || bag.isPaused
          ? "warn"
          : "info";
    if (bag.elapsedMinutes < 45 && !bag.isPaused && !bag.isOnHold) continue;

    const flags = [
      bag.isPaused ? "paused" : null,
      bag.isOnHold ? "hold" : null,
    ]
      .filter(Boolean)
      .join(", ");

    items.push({
      id: `inflight-${bag.receiptNumber ?? bag.elapsedMinutes}`,
      severity: sev,
      title: bag.receiptNumber ?? "Bag in flight",
      detail: `${formatStage(bag.stage)} · ${bag.elapsedMinutes}m${flags ? ` · ${flags}` : ""}${bag.productName ? ` · ${bag.productName}` : ""}`,
      ...(bag.receiptNumber
        ? {
            href: `/workflow-submissions?receipt=${encodeURIComponent(bag.receiptNumber)}`,
          }
        : {}),
    });
  }

  const pausedMetric = intelligence.dashboard.pausedBagsOverThreshold;
  const pausedCount =
    pausedMetric?.confidence !== "MISSING" && typeof pausedMetric?.value === "number"
      ? pausedMetric.value
      : 0;
  if (pausedCount > 0) {
    items.push({
      id: "paused-threshold",
      severity: pausedCount > 2 ? "crit" : "warn",
      title: `${pausedCount} bag${pausedCount === 1 ? "" : "s"} paused >30m`,
      detail: "Check floor for forgotten work",
    });
  }

  for (const a of attention) {
    if (a.type === "idle_machine") {
      items.push({
        id: `idle-${a.label}`,
        severity: "warn",
        title: a.label,
        detail: a.detail,
      });
    }
    if (a.type === "rework_pending") {
      items.push({
        id: `rework-${a.label}`,
        severity: "warn",
        title: "Rework pending",
        detail: `${a.label} · ${a.detail}`,
      });
    }
  }

  if (plant.laneImbalanceLabel) {
    items.push({
      id: "lane-imbalance",
      severity: "warn",
      title: "Lane imbalance",
      detail: plant.laneImbalanceLabel,
    });
  }

  if (plant.damageClusterActive) {
    items.push({
      id: "damage-cluster",
      severity: "crit",
      title: "Damage cluster",
      detail: "Elevated damage this hour — check packaging QC",
      href: "/metrics",
    });
  }

  if (plant.materialRunwayDays != null && plant.materialRunwayDays < 3) {
    items.push({
      id: "runway-critical",
      severity: plant.materialRunwayDays < 1 ? "crit" : "warn",
      title: "Material runway low",
      detail: `${plant.materialRunwayDays.toFixed(1)} days remaining`,
      href: "/material-alerts",
    });
  }

  const bn = bottleneckLabel(intelligence);
  const oldest = intelligence.bottleneck.oldestAgeMinutes.value;
  const wip = intelligence.bottleneck.wip.value;
  if (bn && bn !== "—" && bn !== "no bottleneck — queues clear") {
    items.push({
      id: "bottleneck",
      severity:
        typeof oldest === "number" && oldest > 120
          ? "crit"
          : typeof oldest === "number" && oldest > 60
            ? "warn"
            : "info",
      title: `Bottleneck: ${bn}`,
      detail: [
        typeof oldest === "number" ? `oldest ${oldest}m` : null,
        typeof wip === "number" ? `${wip} WIP` : null,
        intelligence.bottleneck.reason.value != null
          ? String(intelligence.bottleneck.reason.value)
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: "/metrics",
    });
  }

  const order: Record<ActNowSeverity, number> = { crit: 0, warn: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}
