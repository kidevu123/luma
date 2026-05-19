// LUMA-UI-FINAL-1 — packaging output / pack-out metrics.
//
// Chrome rebuilt on the Operations Atelier design language.
// derivePackagingMetrics + deriveFinishedGoodsMetrics unchanged.
// Pack-out queue added at the top (before RibbonStrip) — shows:
//   1. Finalized bags without a finished lot (actionable — "Issue lot")
//   2. PACKAGED (not finalized) bags (informational — "Awaiting finalization")

import Link from "next/link";
import { requireSession } from "@/lib/auth-guards";
import {
  derivePackagingMetrics,
  deriveFinishedGoodsMetrics,
} from "@/lib/production/metrics";
import { lastNDays } from "@/lib/production/time";
import { db } from "@/lib/db";
import {
  workflowBags,
  products,
  readBagState,
  readBagMetrics,
  finishedLots,
} from "@/lib/db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
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

  // Run all queries in parallel — pack-out queue alongside existing metrics.
  const [packaging, finished, awaitingLot, awaitingFinalize] = await Promise.all([
    derivePackagingMetrics(range),
    deriveFinishedGoodsMetrics(range),

    // Finalized bags without a finished lot.
    db
      .select({
        id: workflowBags.id,
        receiptNumber: workflowBags.receiptNumber,
        finalizedAt: workflowBags.finalizedAt,
        productName: products.name,
        productSku: products.sku,
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        looseCards: readBagMetrics.looseCards,
        unitsYielded: readBagMetrics.unitsYielded,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
      .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
      .where(and(sql`${workflowBags.finalizedAt} IS NOT NULL`, isNull(finishedLots.id)))
      .orderBy(desc(workflowBags.finalizedAt))
      .limit(20),

    // PACKAGED (not finalized) bags.
    db
      .select({
        id: workflowBags.id,
        receiptNumber: workflowBags.receiptNumber,
        startedAt: workflowBags.startedAt,
        productName: products.name,
        productSku: products.sku,
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        looseCards: readBagMetrics.looseCards,
        operatorCode: readBagState.currentOperatorCode,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
      .where(eq(readBagState.stage, "PACKAGED"))
      .orderBy(desc(workflowBags.startedAt))
      .limit(20),
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

  const hasQueue = awaitingLot.length > 0 || awaitingFinalize.length > 0;

  return (
    <CommandShell density="wide">
      <PageHero
        eyebrow="Operations · Pack-out"
        title="Packaging output."
        description="Last 7 days. Unit types are separated end-to-end — cases, displays, and loose are never aggregated into a single number. Source: read_bag_metrics + finished_lots."
        badges={heroBadges}
      />

      {/* Pack-out queue — actionable section before metrics ribbon */}
      <SectionCard
        eyebrow="Pack-out queue"
        title={
          hasQueue
            ? `${awaitingLot.length > 0 ? `${awaitingLot.length} bag${awaitingLot.length === 1 ? "" : "s"} awaiting lot` : ""}${awaitingLot.length > 0 && awaitingFinalize.length > 0 ? " · " : ""}${awaitingFinalize.length > 0 ? `${awaitingFinalize.length} bag${awaitingFinalize.length === 1 ? "" : "s"} on floor` : ""}`
            : "All clear"
        }
        subtitle="Finalized bags must have a finished lot before they can be released. PACKAGED bags are still on the floor awaiting finalization."
        tone={awaitingLot.length > 0 ? "warn" : hasQueue ? "info" : "good"}
        reveal="reveal-2"
      >
        {!hasQueue ? (
          <DataEmptyState
            title="No bags pending pack-out"
            body="All finalized bags have finished lots. No bags are staged at PACKAGED."
            tone="good"
          />
        ) : (
          <div className="space-y-5">
            {/* Sub-section 1: Finalized bags awaiting lot */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mb-2">
                Finalized — awaiting lot
              </div>
              {awaitingLot.length === 0 ? (
                <p className="text-[12px] text-text-muted italic">None — all finalized bags have lots.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-[12.5px] w-full">
                    <thead>
                      <tr className="border-b border-border/60">
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Receipt</th>
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Product</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Cases</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Displays</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Loose</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Units</th>
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Finalized at</th>
                        <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {awaitingLot.map((bag) => (
                        <tr key={bag.id} className="border-b border-border/30 last:border-0">
                          <td className="py-2 pr-4 font-mono text-[11.5px] text-text-strong">
                            {bag.receiptNumber ?? <span className="text-text-subtle italic">—</span>}
                          </td>
                          <td className="py-2 pr-4">
                            <div className="text-text-strong">{bag.productName ?? <span className="text-text-subtle italic">Unknown</span>}</div>
                            {bag.productSku ? (
                              <div className="font-mono text-[10.5px] text-text-muted">{bag.productSku}</div>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.masterCases ?? "—"}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.displaysMade ?? "—"}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.looseCards ?? "—"}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.unitsYielded ?? "—"}</td>
                          <td className="py-2 pr-4 text-[11.5px] text-text-muted tabular-nums whitespace-nowrap">
                            {bag.finalizedAt
                              ? new Date(bag.finalizedAt).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </td>
                          <td className="py-2">
                            <Link
                              href="/finished-lots/new"
                              className="inline-flex items-center gap-1 rounded-md border border-warn-500/40 bg-warn-50/60 px-2.5 py-1 text-[11.5px] font-medium text-warn-700 hover:bg-warn-50 transition-colors"
                            >
                              Issue lot
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Sub-section 2: PACKAGED bags awaiting floor finalization */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle mb-2">
                Packaged — awaiting floor finalization
              </div>
              {awaitingFinalize.length === 0 ? (
                <p className="text-[12px] text-text-muted italic">None — no bags currently at PACKAGED stage.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-[12.5px] w-full">
                    <thead>
                      <tr className="border-b border-border/60">
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Receipt</th>
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Product</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Cases</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Displays</th>
                        <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Loose</th>
                        <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Operator</th>
                        <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Started at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {awaitingFinalize.map((bag) => (
                        <tr key={bag.id} className="border-b border-border/30 last:border-0">
                          <td className="py-2 pr-4 font-mono text-[11.5px] text-text-strong">
                            {bag.receiptNumber ?? <span className="text-text-subtle italic">—</span>}
                          </td>
                          <td className="py-2 pr-4">
                            <div className="text-text-strong">{bag.productName ?? <span className="text-text-subtle italic">Unknown</span>}</div>
                            {bag.productSku ? (
                              <div className="font-mono text-[10.5px] text-text-muted">{bag.productSku}</div>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.masterCases ?? "—"}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.displaysMade ?? "—"}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{bag.looseCards ?? "—"}</td>
                          <td className="py-2 pr-4 text-[11.5px] text-text-muted font-mono">
                            {bag.operatorCode ?? <span className="italic">—</span>}
                          </td>
                          <td className="py-2 text-[11.5px] text-text-muted tabular-nums whitespace-nowrap">
                            {bag.startedAt
                              ? new Date(bag.startedAt).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SectionCard>

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
