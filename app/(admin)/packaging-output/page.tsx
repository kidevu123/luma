// Phase E — packaging output dedicated page. Reads
// derivePackagingMetrics + deriveFinishedGoodsMetrics. Strict
// unit-type separation: cases / displays / loose / damages /
// finished goods are each their own column or card.

import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import {
  derivePackagingMetrics,
  deriveFinishedGoodsMetrics,
} from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";

export const dynamic = "force-dynamic";

export default async function PackagingOutputPage() {
  await requireSession();
  const range = lastNDays(7);
  const [packaging, finished] = await Promise.all([
    derivePackagingMetrics(range),
    deriveFinishedGoodsMetrics(range),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Packaging output"
        description="Window: last 7 days. Source: lib/production/metrics.ts → derivePackagingMetrics + deriveFinishedGoodsMetrics. Unit types separated end-to-end; never aggregated into a single number."
      />

      <section aria-label="Packaging output by unit">
        <SectionTitle
          eyebrow="Packaging output"
          title="Per-bag rollup"
          subtitle="One column per unit type. No aggregation across cases / displays / loose."
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
          <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} />
          <MetricCard label="Displays" metric={packaging.displaysMade ?? FALLBACK} />
          <MetricCard label="Loose cards" metric={packaging.looseCards ?? FALLBACK} />
          <MetricCard label="Damaged units" metric={packaging.damagedPackaging ?? FALLBACK} />
          <MetricCard label="Ripped cards" metric={packaging.rippedCards ?? FALLBACK} />
          <MetricCard label="Bags finalised" metric={packaging.bagsFinalised ?? FALLBACK} />
          <MetricCard
            label="Damage rate"
            metric={packaging.damageRatePct ?? FALLBACK}
            hint="(damaged + ripped) / (cases + displays + loose)"
          />
        </div>
      </section>

      <section aria-label="Finished-lot release">
        <SectionTitle
          eyebrow="Finished goods"
          title="Release status"
          subtitle="Released = lot status RELEASED. Pending QC = lot held for QA review. On-time = packed by due date."
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <MetricCard label="Released lots" metric={finished.releasedLots ?? FALLBACK} />
          <MetricCard label="Released units" metric={finished.releasedUnits ?? FALLBACK} />
          <MetricCard label="Released cases" metric={finished.releasedCases ?? FALLBACK} />
          <MetricCard label="Released displays" metric={finished.releasedDisplays ?? FALLBACK} />
          <MetricCard label="Pending QC" metric={finished.pendingQcLots ?? FALLBACK} />
          <MetricCard
            label="On-time completion"
            metric={finished.onTimeCompletionPct ?? FALLBACK}
          />
        </div>
      </section>

      <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-2">
        <ConfidenceBadge confidence="HIGH" />
        <span>
          Packaging columns sourced from <code>read_bag_metrics</code>{" "}
          windowed by <code>finalized_at</code>. Finished-goods columns
          sourced from <code>finished_lots</code>. No unit-type mixing
          and no event-count-as-output.
        </span>
      </div>
    </div>
  );
}

const FALLBACK = {
  value: null,
  unit: null,
  confidence: "MISSING" as const,
  missingInputs: ["metric_api"],
  label: "No data",
};

function SectionTitle({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-border/40 pb-2">
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted font-semibold">
          {eyebrow}
        </div>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
      </div>
      {subtitle && (
        <p className="text-[11px] text-text-muted max-w-md text-right">
          {subtitle}
        </p>
      )}
    </div>
  );
}
