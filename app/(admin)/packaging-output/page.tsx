// LUMA-UI-FINAL-1 — packaging output / pack-out metrics.
//
// Chrome rebuilt on the Operations Atelier design language.
// derivePackagingMetrics + deriveFinishedGoodsMetrics unchanged.

import { requireSession } from "@/lib/auth-guards";
import {
  derivePackagingMetrics,
  deriveFinishedGoodsMetrics,
} from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import {
  CommandShell,
  PageHero,
  RibbonStrip,
  SectionCard,
  DataEmptyState,
  type HeroBadge,
  type RibbonSegmentData,
} from "@/components/production/luma-ui";
import { Package, CheckCircle2, AlertTriangle, TrendingUp } from "lucide-react";

export const dynamic = "force-dynamic";

const FALLBACK = {
  value: null,
  unit: null,
  confidence: "MISSING" as const,
  missingInputs: ["metric_api"],
  label: "No data",
};

export default async function PackagingOutputPage() {
  await requireSession();
  const range = lastNDays(7);
  const [packaging, finished] = await Promise.all([
    derivePackagingMetrics(range),
    deriveFinishedGoodsMetrics(range),
  ]);

  const releasedLotsRaw = finished.releasedLots?.value ?? null;
  const releasedUnitsRaw = finished.releasedUnits?.value ?? null;
  const damageRateRaw = packaging.damageRatePct?.value ?? null;
  const onTimeRaw = finished.onTimeCompletionPct?.value ?? null;

  // Coerce metric values to numbers for comparisons (metric values are string | number).
  const releasedLots = typeof releasedLotsRaw === "number" ? releasedLotsRaw : null;
  const releasedUnits = typeof releasedUnitsRaw === "number" ? releasedUnitsRaw : null;
  const damageRate = typeof damageRateRaw === "number" ? damageRateRaw : null;
  const onTime = typeof onTimeRaw === "number" ? onTimeRaw : null;

  const heroBadges: HeroBadge[] = [
    { label: "Last 7 days", tone: "info", mono: true },
    {
      label:
        finished.releasedLots?.confidence === "HIGH"
          ? "High confidence"
          : finished.releasedLots?.confidence === "MEDIUM"
            ? "Estimated"
            : "Missing data",
      tone:
        finished.releasedLots?.confidence === "HIGH"
          ? "good"
          : finished.releasedLots?.confidence === "MEDIUM"
            ? "warn"
            : "muted",
    },
  ];

  const ribbonSegments: RibbonSegmentData[] = [
    {
      label: "Released lots",
      value: releasedLots != null ? releasedLots.toLocaleString() : "—",
      tone: releasedLots != null && releasedLots > 0 ? "good" : "muted",
      icon: CheckCircle2,
      live: true,
      hint: "Lots with status RELEASED",
    },
    {
      label: "Released units",
      value: releasedUnits != null ? releasedUnits.toLocaleString() : "—",
      tone: releasedUnits != null && releasedUnits > 0 ? "good" : "muted",
      icon: Package,
      hint: "Individual units released this week",
    },
    {
      label: "Damage rate",
      value: damageRate != null ? `${damageRate.toFixed(1)}%` : "—",
      tone:
        damageRate == null
          ? "muted"
          : damageRate > 5
            ? "crit"
            : damageRate > 2
              ? "warn"
              : "good",
      icon: AlertTriangle,
      hint: "(damaged + ripped) / (cases + displays + loose)",
    },
    {
      label: "On-time",
      value: onTime != null ? `${onTime.toFixed(0)}%` : "—",
      tone:
        onTime == null
          ? "muted"
          : onTime < 80
            ? "crit"
            : onTime < 90
              ? "warn"
              : "good",
      icon: TrendingUp,
      hint: "Lots packed by due date",
    },
  ];

  return (
    <CommandShell density="wide">
      <PageHero
        eyebrow="Operations · Pack-out"
        title="Packaging output."
        description="Last 7 days. Unit types are separated end-to-end — cases, displays, and loose are never aggregated into a single number. Source: read_bag_metrics + finished_lots."
        badges={heroBadges}
      />

      <RibbonStrip reveal="reveal-2" segments={ribbonSegments} />

      {/* Per-bag packaging breakdown */}
      <SectionCard
        eyebrow="Packaging output"
        title="Per-bag rollup — last 7 days"
        subtitle="One column per unit type. No aggregation across cases / displays / loose. Source: read_bag_metrics windowed by finalized_at."
        tone="info"
        reveal="reveal-3"
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
          <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} />
          <MetricCard
            label="Displays"
            metric={packaging.displaysMade ?? FALLBACK}
          />
          <MetricCard
            label="Loose cards"
            metric={packaging.looseCards ?? FALLBACK}
          />
          <MetricCard
            label="Damaged"
            metric={packaging.damagedPackaging ?? FALLBACK}
          />
          <MetricCard
            label="Ripped cards"
            metric={packaging.rippedCards ?? FALLBACK}
          />
          <MetricCard
            label="Bags finalised"
            metric={packaging.bagsFinalised ?? FALLBACK}
          />
          <MetricCard
            label="Damage rate"
            metric={packaging.damageRatePct ?? FALLBACK}
            hint="(damaged + ripped) / (cases + displays + loose)"
          />
        </div>
      </SectionCard>

      {/* Finished lot release status */}
      <SectionCard
        eyebrow="Finished goods"
        title="Release status — last 7 days"
        subtitle="Released = lot status RELEASED. Pending QC = lot held for QA review. On-time = packed by due date. Source: finished_lots."
        tone={
          typeof finished.pendingQcLots?.value === "number" &&
          finished.pendingQcLots.value > 0
            ? "warn"
            : "good"
        }
        reveal="reveal-4"
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <MetricCard
            label="Released lots"
            metric={finished.releasedLots ?? FALLBACK}
          />
          <MetricCard
            label="Released units"
            metric={finished.releasedUnits ?? FALLBACK}
          />
          <MetricCard
            label="Released cases"
            metric={finished.releasedCases ?? FALLBACK}
          />
          <MetricCard
            label="Released displays"
            metric={finished.releasedDisplays ?? FALLBACK}
          />
          <MetricCard
            label="Pending QC"
            metric={finished.pendingQcLots ?? FALLBACK}
          />
          <MetricCard
            label="On-time"
            metric={finished.onTimeCompletionPct ?? FALLBACK}
          />
        </div>
      </SectionCard>

      {/* Data source note */}
      <div className="flex items-center gap-2.5 text-[11px] text-text-muted px-1">
        <ConfidenceBadge confidence="HIGH" />
        <span>
          Packaging columns sourced from{" "}
          <code className="font-mono text-[10.5px] bg-surface-2 border border-border rounded px-1">
            read_bag_metrics
          </code>{" "}
          windowed by{" "}
          <code className="font-mono text-[10.5px] bg-surface-2 border border-border rounded px-1">
            finalized_at
          </code>
          . Finished-goods columns sourced from{" "}
          <code className="font-mono text-[10.5px] bg-surface-2 border border-border rounded px-1">
            finished_lots
          </code>
          . No unit-type mixing.
        </span>
      </div>
    </CommandShell>
  );
}
