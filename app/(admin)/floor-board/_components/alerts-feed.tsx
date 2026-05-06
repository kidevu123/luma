// Rich alerts feed. Combines:
//   - forgotten bags (red, paused > 30m, with finalize CTA)
//   - stalled bags (amber, only if active in last 14d)
//   - stuck-paused (amber, distinct from forgotten — these were paused
//     but the operator did acknowledge it via reason)
//   - batch holds (red)
//   - lane imbalance chip
//   - damage cluster (red, only when synthesized signal exists)
//   - vendor barcode mismatch (placeholder — no detector yet)
//
// Each row: icon + headline + 1-line context + click-to-action.

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Hourglass,
  PauseCircle,
  CircleSlash,
  Wrench,
  Activity,
  PackageX,
  ScanLine,
  ChevronRight,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const ONE_MIN = 60_000;

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem.toString().padStart(2, "0")}m`;
}

export type AlertItem = {
  key: string;
  severity: "red" | "amber";
  icon: React.ComponentType<{ className?: string }>;
  headline: string;
  detail: string;
  href?: string;
  hrefLabel?: string;
};

export function AlertsFeed({
  forgotten,
  stalled,
  stuckPaused,
  holds,
  laneImbalanceSide,
  laneImbalanceDetail,
  damageCluster,
}: {
  forgotten: Array<{
    bagId: string;
    pausedAt: Date;
    productName: string | null;
    receiptNumber: string | null;
    stage: string | null;
  }>;
  stalled: Array<{
    bagId: string;
    productName: string | null;
    stage: string | null;
    startedAt: Date;
  }>;
  stuckPaused: Array<{
    bagId: string;
    productName: string | null;
    stage: string | null;
    pausedAt: Date;
  }>;
  holds: Array<{
    holdId: string;
    batchNumber: string;
    reason: string | null;
    openedAt: Date;
  }>;
  laneImbalanceSide: "card" | "bottle" | null;
  laneImbalanceDetail: string | null;
  damageCluster: {
    hasData: boolean;
    isCluster: boolean;
    thisHourDamage: number;
    rollingMean: number;
    rollingStdDev: number;
  };
}) {
  const items: AlertItem[] = [];

  // Forgotten — top of list.
  for (const f of forgotten.slice(0, 8)) {
    const elapsed = Date.now() - f.pausedAt.getTime();
    items.push({
      key: `forgotten-${f.bagId}`,
      severity: "red",
      icon: Hourglass,
      headline: `${f.productName ?? "Bag"} paused ${fmtElapsed(elapsed)}`,
      detail: `${f.receiptNumber ?? f.bagId.slice(0, 8)} · ${f.stage ?? "STARTED"} — likely forgotten`,
      href: `/bags/${f.bagId}`,
      hrefLabel: "Investigate",
    });
  }

  // Damage cluster (only when synthesized signal exists + actionable).
  if (damageCluster.hasData && damageCluster.isCluster) {
    items.push({
      key: "damage-cluster",
      severity: "red",
      icon: PackageX,
      headline: `Damage spike: ${damageCluster.thisHourDamage} this hour`,
      detail: `Mean ${damageCluster.rollingMean.toFixed(1)} ± ${damageCluster.rollingStdDev.toFixed(1)} (7d hourly)`,
      href: "/metrics?days=7",
      hrefLabel: "View damage trend",
    });
  }

  // Batch holds.
  for (const h of holds) {
    const elapsed = Date.now() - h.openedAt.getTime();
    items.push({
      key: `hold-${h.holdId}`,
      severity: "red",
      icon: CircleSlash,
      headline: `Batch ${h.batchNumber} on hold`,
      detail: `${h.reason ?? "no reason given"} · open ${fmtElapsed(elapsed)}`,
      href: `/batches`,
      hrefLabel: "Review",
    });
  }

  // Lane imbalance.
  if (laneImbalanceSide) {
    items.push({
      key: "lane-imbalance",
      severity: "amber",
      icon: Wrench,
      headline: `${laneImbalanceSide === "card" ? "Card" : "Bottle"} lane imbalanced`,
      detail: laneImbalanceDetail ?? "ratio outside 0.77–1.3 (24h)",
    });
  }

  // Stuck-paused (separate from forgotten — recent pause with reason).
  for (const s of stuckPaused.slice(0, 6)) {
    const elapsed = Date.now() - s.pausedAt.getTime();
    items.push({
      key: `paused-${s.bagId}`,
      severity: "amber",
      icon: PauseCircle,
      headline: `Bag paused at ${s.stage ?? "STARTED"}`,
      detail: `${s.productName ?? "no product"} · paused ${fmtElapsed(elapsed)}`,
      href: `/bags/${s.bagId}`,
      hrefLabel: "Open",
    });
  }

  // Stalled (running but no end event).
  for (const s of stalled.slice(0, 6)) {
    const elapsed = Date.now() - s.startedAt.getTime();
    items.push({
      key: `stalled-${s.bagId}`,
      severity: "amber",
      icon: Activity,
      headline: `Bag stalled at ${s.stage ?? "STARTED"}`,
      detail: `${s.productName ?? "no product"} · running ${fmtElapsed(elapsed)}`,
      href: `/bags/${s.bagId}`,
      hrefLabel: "Open",
    });
  }

  // Vendor barcode mismatch — no detector yet (Phase-2). Surfaced as
  // an empty-state hint at the bottom when the panel is otherwise quiet
  // so the lead knows the slot exists.
  const hasVendorBarcodeDetector = false;

  const total = items.length;
  const reds = items.filter((i) => i.severity === "red").length;

  return (
    <Card className={total > 0 ? (reds > 0 ? "border-red-200" : "border-amber-200") : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle
            className={`h-4 w-4 ${
              reds > 0
                ? "text-red-600"
                : total > 0
                  ? "text-amber-600"
                  : "text-text-subtle"
            }`}
          />
          Active alerts
          <span className="text-xs font-normal text-text-muted ml-auto tabular-nums">
            {reds > 0 && (
              <span className="text-red-700 font-semibold">{reds} red</span>
            )}
            {reds > 0 && total > reds && " · "}
            {total > reds && <span>{total - reds} amber</span>}
            {total === 0 && "all clear"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 max-h-[480px] overflow-y-auto">
        {total === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-text-muted">
              Floor's running clean — no active alerts.
            </p>
            {!hasVendorBarcodeDetector && damageCluster.hasData === false && (
              <p className="text-[11px] text-text-subtle italic mt-2">
                Damage-cluster + vendor-barcode-mismatch detectors light up
                once the synthesizer runs.
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {items.map((it) => (
              <AlertRow key={it.key} item={it} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AlertRow({ item }: { item: AlertItem }) {
  const iconColor =
    item.severity === "red" ? "text-red-700" : "text-amber-700";
  const inner = (
    <div
      className={`px-3 py-2 flex items-start gap-2.5 ${
        item.href
          ? "hover:bg-surface-2/40 transition-colors cursor-pointer"
          : ""
      }`}
    >
      <item.icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${iconColor}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-text leading-tight truncate">
          {item.headline}
        </p>
        <p className="text-[11px] text-text-muted leading-tight truncate">
          {item.detail}
        </p>
      </div>
      {item.href && (
        <span className="text-[10px] text-text-subtle shrink-0 inline-flex items-center gap-0.5 self-center font-medium">
          {item.hrefLabel ?? "Open"}
          <ChevronRight className="h-3 w-3" />
        </span>
      )}
    </div>
  );
  return (
    <li>
      {item.href ? (
        <Link href={item.href} className="block">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}
