import { formatDateTimeEst } from "@/lib/ui/luma-display";
// packaging output / pack-out metrics.
//
// derivePackagingMetrics + deriveFinishedGoodsMetrics unchanged.
// Pack-out queue added at the top (before stats) — shows:
//   1. Finalized bags without a finished lot (actionable — "Review / issue lot")
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
  inventoryBags,
} from "@/lib/db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { PageHeader } from "@/components/ui/page-header";
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

  const ROLL_KINDS_FOR_EXCLUSION = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"];

  // Run all queries in parallel — pack-out queue alongside existing metrics.
  const [packaging, finished, awaitingLot, awaitingFinalize, materialBurnRaw] = await Promise.all([
    derivePackagingMetrics(range),
    deriveFinishedGoodsMetrics(range),

    // Finalized bags without a finished lot.
    db
      .select({
        id: workflowBags.id,
        receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
        finalizedAt: workflowBags.finalizedAt,
        productName: products.name,
        productSku: products.sku,
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        looseCards: readBagMetrics.looseCards,
        unitsYielded: readBagMetrics.unitsYielded,
      })
      .from(workflowBags)
      .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
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
        receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
        startedAt: workflowBags.startedAt,
        productName: products.name,
        productSku: products.sku,
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        looseCards: readBagMetrics.looseCards,
        operatorCode: readBagState.currentOperatorCode,
      })
      .from(workflowBags)
      .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
      .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
      .where(eq(readBagState.stage, "PACKAGED"))
      .orderBy(desc(workflowBags.startedAt))
      .limit(20),

    // Material burn: actual + estimated consumption last 7 days, excluding rolls.
    db.execute<{
      packaging_material_id: string;
      material_name: string;
      material_kind: string;
      actual_qty: number;
      estimated_qty: number;
      last_consumed_at: string;
    }>(sql`
      SELECT
        mie.packaging_material_id::text,
        pm.name AS material_name,
        pm.kind::text AS material_kind,
        COALESCE(SUM(CASE WHEN mie.event_type = 'MATERIAL_CONSUMED_ACTUAL' THEN mie.quantity_units ELSE 0 END), 0)::int AS actual_qty,
        COALESCE(SUM(CASE WHEN mie.event_type = 'MATERIAL_CONSUMED_ESTIMATED' THEN mie.quantity_units ELSE 0 END), 0)::int AS estimated_qty,
        MAX(mie.occurred_at)::text AS last_consumed_at
      FROM material_inventory_events mie
      JOIN packaging_materials pm ON pm.id = mie.packaging_material_id
      WHERE mie.event_type IN ('MATERIAL_CONSUMED_ACTUAL', 'MATERIAL_CONSUMED_ESTIMATED')
        AND mie.occurred_at >= NOW() - INTERVAL '7 days'
        AND pm.kind::text NOT IN (${ROLL_KINDS_FOR_EXCLUSION[0]}, ${ROLL_KINDS_FOR_EXCLUSION[1]}, ${ROLL_KINDS_FOR_EXCLUSION[2]})
      GROUP BY mie.packaging_material_id, pm.name, pm.kind
      ORDER BY MAX(mie.occurred_at) DESC
    `),
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

  const confidenceTone =
    finished.releasedLots?.confidence === "HIGH"
      ? "High confidence"
      : finished.releasedLots?.confidence === "MEDIUM"
        ? "Estimated"
        : "Missing data";

  const hasQueue = awaitingLot.length > 0 || awaitingFinalize.length > 0;

  type MaterialBurnRow = {
    packaging_material_id: string;
    material_name: string;
    material_kind: string;
    actual_qty: number;
    estimated_qty: number;
    last_consumed_at: string;
  };
  const materialBurn = materialBurnRaw as unknown as MaterialBurnRow[];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Production output"
        description="Last 7 days. Unit types are separated end-to-end — cases, displays, and loose are never aggregated into a single number. Source: read_bag_metrics + finished_lots."
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-medium bg-sky-50/80 border-sky-300/50 text-sky-700">
              Last 7 days
            </span>
            <span className={`inline-flex items-center h-5 px-1.5 rounded border text-[10px] font-medium ${
              finished.releasedLots?.confidence === "HIGH"
                ? "bg-green-50/80 border-green-300/50 text-green-700"
                : finished.releasedLots?.confidence === "MEDIUM"
                  ? "bg-amber-50/80 border-amber-300/50 text-amber-700"
                  : "bg-surface-2 border-border text-text-subtle"
            }`}>
              {confidenceTone}
            </span>
          </div>
        }
      />

      {/* Stats ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <CheckCircle2 className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Released lots</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${releasedLots != null && releasedLots > 0 ? "text-green-700" : "text-text-strong"}`}>
            {releasedLots != null ? releasedLots.toLocaleString() : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Lots with status RELEASED</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <Package className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Released units</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${releasedUnits != null && releasedUnits > 0 ? "text-green-700" : "text-text-strong"}`}>
            {releasedUnits != null ? releasedUnits.toLocaleString() : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Individual units released this week</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <AlertTriangle className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Damage rate</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${
            damageRate == null
              ? "text-text-strong"
              : damageRate > 5
                ? "text-red-700"
                : damageRate > 2
                  ? "text-amber-700"
                  : "text-green-700"
          }`}>
            {damageRate != null ? `${damageRate.toFixed(1)}%` : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">(damaged + ripped) / (cases + displays + loose)</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <TrendingUp className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">On-time</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${
            onTime == null
              ? "text-text-strong"
              : onTime < 80
                ? "text-red-700"
                : onTime < 90
                  ? "text-amber-700"
                  : "text-green-700"
          }`}>
            {onTime != null ? `${onTime.toFixed(0)}%` : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">Lots packed by due date</p>
        </div>
      </div>

      {/* Pack-out queue — actionable section */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Output queue</p>
          <h2 className="text-sm font-semibold text-text-strong">
            {hasQueue
              ? `${awaitingLot.length > 0 ? `${awaitingLot.length} bag${awaitingLot.length === 1 ? "" : "s"} awaiting lot` : ""}${awaitingLot.length > 0 && awaitingFinalize.length > 0 ? " · " : ""}${awaitingFinalize.length > 0 ? `${awaitingFinalize.length} bag${awaitingFinalize.length === 1 ? "" : "s"} on floor` : ""}`
              : "All clear"}
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Full-bag packaging normally creates and releases the finished lot automatically. Rows here need admin review because a prerequisite was missing or the bag predates automation. PACKAGED bags are still on the floor awaiting finalization.
          </p>
        </div>
        <div className="px-4 py-4">
          {!hasQueue ? (
            <div className="px-4 py-8 text-center">
              <CheckCircle2 className="h-8 w-8 mx-auto text-text-subtle mb-3" />
              <p className="text-sm font-medium text-text-muted">No bags pending output</p>
              <p className="text-[12px] text-text-subtle mt-1">All finalized bags have finished lots. No bags are staged at PACKAGED.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Sub-section 1: Finalized bags awaiting lot */}
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-subtle">
                    Finalized — needs lot review
                  </div>
                  {awaitingLot.some((b) => !b.productName) && (
                    <span className="text-[10px] text-text-subtle">· product blank = bag not yet mapped via PRODUCT_MAPPED event</span>
                  )}
                </div>
                {awaitingLot.length === 0 ? (
                  <p className="text-[12px] text-text-muted">None — all finalized bags have lots.</p>
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
                              {bag.receiptNumber ?? <span className="text-text-subtle">—</span>}
                            </td>
                            <td className="py-2 pr-4">
                              <div className="text-text-strong">{bag.productName ?? <span className="text-text-subtle text-[11px]">—</span>}</div>
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
                                href={`/finished-lots/new?bagId=${encodeURIComponent(bag.id)}`}
                                className="inline-flex items-center gap-1 rounded-md border border-warn-500/40 bg-warn-50/60 px-2.5 py-1 text-[11.5px] font-medium text-warn-700 hover:bg-warn-50 transition-colors"
                              >
                                Review / issue lot
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
                  <p className="text-[12px] text-text-muted">None — no bags currently at PACKAGED stage.</p>
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
                              {bag.receiptNumber ?? <span className="text-text-subtle">—</span>}
                            </td>
                            <td className="py-2 pr-4">
                              <div className="text-text-strong">{bag.productName ?? <span className="text-text-subtle text-[11px]">—</span>}</div>
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
        </div>
      </div>

      {/* Per-bag packaging breakdown */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Production output</p>
          <h2 className="text-sm font-semibold text-text-strong">Per-bag rollup — last 7 days</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            One column per unit type. No aggregation across cases / displays / loose. Source: read_bag_metrics windowed by finalized_at.
          </p>
        </div>
        <div className="px-4 py-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
            <MetricCard label="Cases" metric={packaging.masterCases ?? FALLBACK} variant="light" />
            <MetricCard label="Displays" metric={packaging.displaysMade ?? FALLBACK} variant="light" />
            <MetricCard label="Loose cards" metric={packaging.looseCards ?? FALLBACK} variant="light" />
            <MetricCard label="Damaged" metric={packaging.damagedPackaging ?? FALLBACK} variant="light" />
            <MetricCard label="Ripped cards" metric={packaging.rippedCards ?? FALLBACK} variant="light" />
            <MetricCard label="Bags finalised" metric={packaging.bagsFinalised ?? FALLBACK} variant="light" />
            <MetricCard
              label="Damage rate"
              metric={packaging.damageRatePct ?? FALLBACK}
              hint="(damaged + ripped) / (cases + displays + loose)"
              variant="light"
            />
          </div>
        </div>
      </div>

      {/* Finished lot release status */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Finished goods</p>
          <h2 className="text-sm font-semibold text-text-strong">Release status — last 7 days</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Released = lot status RELEASED. Pending QC = lot held for QA review. On-time = packed by due date. Source: finished_lots.
          </p>
        </div>
        <div className="px-4 py-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <MetricCard label="Released lots" metric={finished.releasedLots ?? FALLBACK} variant="light" />
            <MetricCard label="Released units" metric={finished.releasedUnits ?? FALLBACK} variant="light" />
            <MetricCard label="Released cases" metric={finished.releasedCases ?? FALLBACK} variant="light" />
            <MetricCard label="Released displays" metric={finished.releasedDisplays ?? FALLBACK} variant="light" />
            <MetricCard label="Pending QC" metric={finished.pendingQcLots ?? FALLBACK} variant="light" />
            <MetricCard label="On-time" metric={finished.onTimeCompletionPct ?? FALLBACK} variant="light" />
          </div>
        </div>
      </div>

      {/* Material consumption burn — last 7 days, no rolls */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Material consumption</p>
          <h2 className="text-sm font-semibold text-text-strong">Recent material burn — last 7 days</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Actual = deducted from inventory. Estimated = BOM-calculated but no lot found. PVC/foil tracked separately via roll counter.
          </p>
        </div>
        <div className="px-4 py-4">
          {materialBurn.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Package className="h-8 w-8 mx-auto text-text-subtle mb-3" />
              <p className="text-sm font-medium text-text-muted">No consumption events in last 7 days</p>
              <p className="text-[12px] text-text-subtle mt-1">Material deductions are written when PACKAGING_COMPLETE fires. Check that packaging specs (BOM) are configured for active products.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[12.5px] w-full">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Material</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Actual qty</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Estimated qty</th>
                    <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Last consumed</th>
                  </tr>
                </thead>
                <tbody>
                  {materialBurn.map((row) => {
                    const needsReceipt =
                      row.estimated_qty > 0 &&
                      (row.actual_qty === 0 || row.estimated_qty > row.actual_qty);
                    return (
                    <tr key={row.packaging_material_id} className="border-b border-border/30 last:border-0">
                      <td className="py-2 pr-4">
                        <div className="text-text-strong">{row.material_name}</div>
                        <div className="font-mono text-[10.5px] text-text-muted">{row.material_kind}</div>
                        {needsReceipt && (
                          <span className="mt-1 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-900">
                            Estimated · Needs receipt
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-text-strong">
                        {row.actual_qty > 0 ? row.actual_qty.toLocaleString() : <span className="text-text-subtle">—</span>}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.estimated_qty > 0 ? (
                          <span className="text-amber-700">{row.estimated_qty.toLocaleString()}</span>
                        ) : (
                          <span className="text-text-subtle">—</span>
                        )}
                      </td>
                      <td className="py-2 text-[11.5px] text-text-muted tabular-nums whitespace-nowrap">
                        {row.last_consumed_at
                          ? new Date(row.last_consumed_at).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : "—"}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

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
    </div>
  );
}
