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
        <h2 className="text-[11px] uppercase tracking-[0.10em] text-slate-300 font-semibold mb-2">
          Packaging output (per-bag rollup)
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} />
          <MetricCard label="Displays" metric={packaging.displaysMade ?? FALLBACK} />
          <MetricCard label="Loose cards" metric={packaging.looseCards ?? FALLBACK} />
          <MetricCard label="Damaged units" metric={packaging.damagedPackaging ?? FALLBACK} />
          <MetricCard label="Ripped cards" metric={packaging.rippedCards ?? FALLBACK} />
          <MetricCard label="Bags finalised" metric={packaging.bagsFinalised ?? FALLBACK} />
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          Damage rate ={" "}
          <span className="font-mono text-slate-300">
            {packaging.damageRatePct?.value != null
              ? `${packaging.damageRatePct.value}%`
              : packaging.damageRatePct?.label ?? "—"}
          </span>{" "}
          ((damaged + ripped) / (cases + displays + loose))
        </div>
      </section>

      <section aria-label="Finished-lot release">
        <h2 className="text-[11px] uppercase tracking-[0.10em] text-slate-300 font-semibold mb-2">
          Finished goods release
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <MetricCard label="Released lots" metric={finished.releasedLots ?? FALLBACK} />
          <MetricCard label="Released units" metric={finished.releasedUnits ?? FALLBACK} />
          <MetricCard label="Released cases" metric={finished.releasedCases ?? FALLBACK} />
          <MetricCard label="Released displays" metric={finished.releasedDisplays ?? FALLBACK} />
          <MetricCard label="Pending QC" metric={finished.pendingQcLots ?? FALLBACK} />
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          On-time completion ={" "}
          <span className="font-mono text-slate-300">
            {finished.onTimeCompletionPct?.value != null
              ? `${finished.onTimeCompletionPct.value}%`
              : finished.onTimeCompletionPct?.label ?? "—"}
          </span>
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
