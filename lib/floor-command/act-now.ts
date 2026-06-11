// Actionable floor exceptions for the Act Now sidebar — pure
// composition from existing server bundles (no extra DB).

import type { AttentionItem } from "@/lib/floor-command/types";
import {
  bottleneckMetricsHref,
  metricsLaneUrl,
  metricsUrl,
  stageKeyToMetricsLane,
} from "@/lib/floor-command/metrics-links";
import type { FloorManagerSnapshot } from "@/lib/production/floor-manager-snapshot-types";
import type { FloorProductionIntelligence } from "@/lib/production/floor-production-intelligence-types";
import { humanStage, receiptLabel, formatWait } from "@/lib/floor-command/floor-display";
import {
  groupWaitingByStage,
  partitionWip,
} from "@/lib/floor-command/wip-partition";

export type ActNowSeverity = "crit" | "warn" | "info";

export type ActNowItem = {
  id: string;
  severity: ActNowSeverity;
  title: string;
  detail: string;
  href?: string;
};

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

  const { waiting } = partitionWip(snapshot);
  const needsAttention = waiting.filter(
    (b) => b.elapsedMinutes >= 45 || b.isPaused || b.isOnHold,
  );
  const groups = groupWaitingByStage(needsAttention, humanStage);

  for (const g of groups) {
    const sev: ActNowSeverity =
      g.oldestMinutes > 180 || g.bags.some((b) => b.isOnHold)
        ? "crit"
        : g.oldestMinutes > 60 || g.bags.some((b) => b.isPaused)
          ? "warn"
          : "info";

    if (g.count >= 2) {
      items.push({
        id: `waiting-group-${g.stage ?? "unknown"}`,
        severity: sev,
        title: `${g.count} bags stuck — ${g.label.split(" — ")[0] ?? g.label}`,
        detail: `Oldest ${formatWait(g.oldestMinutes)} · between steps`,
        href: "/workflow-submissions",
      });
      continue;
    }

    const bag = g.bags[0]!;
    const label = receiptLabel(bag.receiptNumber, bag.workflowBagId);
    const flags = [
      bag.isPaused ? "paused" : null,
      bag.isOnHold ? "hold" : null,
    ]
      .filter(Boolean)
      .join(", ");
    items.push({
      id: `waiting-${bag.workflowBagId}`,
      severity: sev,
      title: label,
      detail: `${g.label} · ${formatWait(bag.elapsedMinutes)}${flags ? ` · ${flags}` : ""}`,
      href: bag.receiptNumber
        ? `/workflow-submissions?receipt=${encodeURIComponent(bag.receiptNumber)}`
        : "/workflow-submissions",
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
      href: metricsUrl("downtime", 7),
    });
  }

  for (const a of attention) {
    if (a.type === "idle_machine") {
      items.push({
        id: `idle-${a.label}`,
        severity: "warn",
        title: a.label,
        detail: a.detail,
        href: metricsUrl("by-station", 7),
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
    const lane = stageKeyToMetricsLane(
      typeof intelligence.bottleneck.stageKey.value === "string"
        ? intelligence.bottleneck.stageKey.value
        : null,
    );
    items.push({
      id: "lane-imbalance",
      severity: "warn",
      title: "Lane imbalance",
      detail: plant.laneImbalanceLabel,
      href: lane ? metricsLaneUrl(lane, 7) : metricsUrl("cycle-time", 7),
    });
  }

  if (plant.damageClusterActive) {
    items.push({
      id: "damage-cluster",
      severity: "crit",
      title: "Damage cluster",
      detail: "Elevated damage this hour — check packaging QC",
      href: metricsUrl("by-product", 7),
    });
  }

  if (plant.materialRunwayDays != null && plant.materialRunwayDays < 3) {
    items.push({
      id: "runway-critical",
      severity: plant.materialRunwayDays < 1 ? "crit" : "warn",
      title: "Material runway low",
      detail: `${plant.materialRunwayDays.toFixed(1)} days remaining`,
      href: metricsUrl("material-burn", 30),
    });
  }

  const bn = bottleneckLabel(intelligence);
  const stageRaw =
    intelligence.bottleneck.stageKey.confidence !== "MISSING" &&
    typeof intelligence.bottleneck.stageKey.value === "string"
      ? intelligence.bottleneck.stageKey.value
      : null;
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
        typeof oldest === "number" ? `oldest ${formatWait(oldest)}` : null,
        typeof wip === "number" ? `${wip} WIP` : null,
        intelligence.bottleneck.reason.value != null
          ? String(intelligence.bottleneck.reason.value)
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: bottleneckMetricsHref(stageRaw),
    });
  }

  const order: Record<ActNowSeverity, number> = { crit: 0, warn: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 6);
}
