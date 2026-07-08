import { formatDateTimeEst } from "@/lib/ui/luma-display";
import { AutoRefreshOnFocus } from "@/components/admin/auto-refresh-on-focus";
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
  inventoryBags,
} from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  countProductionOutputBacklog,
  listProductionOutputBacklogWithEligibility,
  summarizeProductionOutputBacklog,
} from "@/lib/db/queries/production-output-backlog";
import { AutoIssueAllButton } from "./auto-issue-all-button";
import { MetricCard } from "@/components/production/metric-card";
import { ConfidenceBadge } from "@/components/production/confidence-badge";
import { PageHeader } from "@/components/ui/page-header";
import { Package, CheckCircle2, AlertTriangle, TrendingUp } from "lucide-react";
import { BacklogRowActions } from "./backlog-row-actions";
import { BacklogStatusChip, ZohoReadyChip } from "./backlog-status-chip";
import { loadBagProductionSummariesByWorkflowBag } from "@/lib/db/queries/bag-production-summary";
import { BagProductionSummaryInline } from "@/components/admin/bag-production-summary-inline";
import {
  derivePoOutputComparison,
  listPoSummaries,
} from "@/lib/production/po-reconciliation";
// PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — filter bar + results table
// for search/history mode. Default behavior preserved unchanged.
import { parseProductionOutputFilters } from "@/lib/production/production-output-filters";
import { listProductionOutputRowsWithFilters } from "@/lib/db/queries/production-output-rows";
import { ProductionOutputFilterBar } from "./filter-bar";
import { ProductionOutputResultsTable } from "./results-table";

export const dynamic = "force-dynamic";

export const metadata = { title: "Production Output" };

const FALLBACK = {
  value: null,
  unit: null,
  confidence: "MISSING" as const,
  missingInputs: ["metric_api"],
  label: "No data",
};

const LEAD_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "LEAD"]);

export default async function PackagingOutputPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const canMutate = LEAD_ROLES.has(user.role);
  const range = lastNDays(7);

  // PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — parse the workbench filters
  // out of searchParams. When `hasUserFilter` is true, the page
  // switches into "results" mode (search/history). Otherwise the
  // historical dashboard + 20-row backlog queue render unchanged.
  const rawParams = (await searchParams) ?? {};
  const filters = parseProductionOutputFilters(rawParams);

  // P3-PO-VIEW — PO-centric comparison (ordered vs received vs
  // produced vs remaining) driven by the ?poId= selector below.
  const selectedPoId = typeof rawParams.poId === "string" ? rawParams.poId : null;
  const [poSummaries, poComparison] = await Promise.all([
    listPoSummaries(),
    selectedPoId ? derivePoOutputComparison(selectedPoId) : Promise.resolve(null),
  ]);
  const selectedPo = selectedPoId
    ? (poSummaries.find((p) => p.po_id === selectedPoId) ?? null)
    : null;

  const ROLL_KINDS_FOR_EXCLUSION = ["PVC_ROLL", "FOIL_ROLL", "BLISTER_FOIL"];

  // PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — workbench results query
  // runs only when filters are active. Keep the rest of the page's
  // existing parallel-query block intact so default-mode behavior
  // (7-day rollups + 20-row queue) is byte-identical to before.
  const workbenchResultsPromise = filters.hasUserFilter
    ? listProductionOutputRowsWithFilters(filters)
    : Promise.resolve(null);

  // Run all queries in parallel — pack-out queue alongside existing metrics.
  const [packaging, finished, flavorRollup, awaitingLot, awaitingLotTotal, backlogSummary, awaitingFinalize, materialBurnRaw, workbenchResults] = await Promise.all([
    derivePackagingMetrics(range),
    deriveFinishedGoodsMetrics(range),

    // Per-flavor running totals over the window — the vendor-reconciliation
    // view: "this is what we produced of what you sent us", by flavor.
    db
      .select({
        productId: readBagMetrics.productId,
        productName: products.name,
        productSku: products.sku,
        bags: sql<number>`COUNT(*)::int`,
        cases: sql<number>`COALESCE(SUM(${readBagMetrics.masterCases}), 0)::int`,
        displays: sql<number>`COALESCE(SUM(${readBagMetrics.displaysMade}), 0)::int`,
        loose: sql<number>`COALESCE(SUM(${readBagMetrics.looseCards}), 0)::int`,
        units: sql<number>`COALESCE(SUM(${readBagMetrics.unitsYielded}), 0)::int`,
        damaged: sql<number>`COALESCE(SUM(${readBagMetrics.damagedPackaging} + ${readBagMetrics.rippedCards}), 0)::int`,
      })
      .from(readBagMetrics)
      .leftJoin(products, eq(products.id, readBagMetrics.productId))
      .where(
        sql`${readBagMetrics.finalizedAt} >= ${range.from.toISOString()}::timestamptz AND ${readBagMetrics.finalizedAt} <= ${range.to.toISOString()}::timestamptz`,
      )
      .groupBy(readBagMetrics.productId, products.name, products.sku)
      .orderBy(sql`SUM(${readBagMetrics.unitsYielded}) DESC`),

    listProductionOutputBacklogWithEligibility(20),
    countProductionOutputBacklog(),
    // AUTO-ISSUE-BATCH-1 — categorized summary (auto-issue ready / needs review
    // / blocked) across the whole backlog, for the summary cards + batch button.
    summarizeProductionOutputBacklog(300),

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
      .where(
        and(
          eq(readBagState.stage, "PACKAGED"),
          sql`COALESCE(${readBagState.excludedFromOutput}, false) = false`,
        ),
      )
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

    workbenchResultsPromise,
  ]);

  const releasedLotsRaw = finished.releasedLots?.value ?? null;
  const releasedUnitsRaw = finished.releasedUnits?.value ?? null;
  const damageRateRaw = packaging.damageRatePct?.value ?? null;
  const onTimeRaw = finished.onTimeCompletionPct?.value ?? null;
  const producedUnitsRaw = packaging.unitsYielded?.value ?? null;
  const bagsFinalisedRaw = packaging.bagsFinalised?.value ?? null;

  // Coerce metric values to numbers for comparisons (metric values are string | number).
  const releasedLots = typeof releasedLotsRaw === "number" ? releasedLotsRaw : null;
  const releasedUnits = typeof releasedUnitsRaw === "number" ? releasedUnitsRaw : null;
  const damageRate = typeof damageRateRaw === "number" ? damageRateRaw : null;
  const onTime = typeof onTimeRaw === "number" ? onTimeRaw : null;
  const producedUnits = typeof producedUnitsRaw === "number" ? producedUnitsRaw : null;
  const bagsFinalised = typeof bagsFinalisedRaw === "number" ? bagsFinalisedRaw : null;

  const flavorTotals = flavorRollup.reduce(
    (acc, f) => ({
      bags: acc.bags + f.bags,
      cases: acc.cases + f.cases,
      displays: acc.displays + f.displays,
      loose: acc.loose + f.loose,
      units: acc.units + f.units,
      damaged: acc.damaged + f.damaged,
    }),
    { bags: 0, cases: 0, displays: 0, loose: 0, units: 0, damaged: 0 },
  );

  const confidenceTone =
    finished.releasedLots?.confidence === "HIGH"
      ? "High confidence"
      : finished.releasedLots?.confidence === "MEDIUM"
        ? "Estimated"
        : "Missing data";

  const hasQueue = awaitingLotTotal > 0 || awaitingFinalize.length > 0;

  // BAG-PRODUCTION-SUMMARY-1 — read-only source-bag production context for
  // the awaiting-lot queue (received / produced / remaining / allocation).
  const sourceBagSummaries = await loadBagProductionSummariesByWorkflowBag(
    awaitingLot.map((b) => b.workflowBagId),
  );

  type MaterialBurnRow = {
    packaging_material_id: string;
    material_name: string;
    material_kind: string;
    actual_qty: number;
    estimated_qty: number;
    last_consumed_at: string;
  };
  const materialBurn = materialBurnRaw as unknown as MaterialBurnRow[];

  // Status filter dropdown initial value — "all" when no status set.
  const initialStatus = filters.status ?? "all";
  const initialFromIso = filters.from
    ? filters.from.toISOString().slice(0, 10)
    : "";
  const initialToIso = filters.to
    ? filters.to.toISOString().slice(0, 10)
    : "";

  return (
    <div className="space-y-5">
      <AutoRefreshOnFocus />
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

      {/* PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — filter bar */}
      <ProductionOutputFilterBar
        initialQ={filters.q ?? ""}
        initialFrom={initialFromIso}
        initialTo={initialToIso}
        initialStatus={initialStatus}
        initialLimit={filters.limit}
      />

      {/* PRODUCTION-OUTPUT-WORKBENCH-v1.5.0 — search/history results
          table. Rendered only when the operator has applied a filter
          beyond limit. Otherwise we keep the historical 7-day
          dashboard + 20-row queue rendering below unchanged. */}
      {workbenchResults && (
        <ProductionOutputResultsTable
          rows={workbenchResults.rows}
          totalCount={workbenchResults.totalCount}
          hasMore={workbenchResults.hasMore}
          filters={filters}
          canMutate={canMutate}
        />
      )}

      {/* Stats ribbon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <Package className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Units produced</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${producedUnits != null && producedUnits > 0 ? "text-green-700" : "text-text-strong"}`}>
            {producedUnits != null ? producedUnits.toLocaleString() : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">
            Sellable units from {bagsFinalised != null ? bagsFinalised.toLocaleString() : "—"} finalized bags
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <CheckCircle2 className="h-3.5 w-3.5 text-text-subtle mb-1" />
          <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Released</p>
          <p className={`text-2xl font-mono tabular-nums mt-1 ${releasedUnits != null && releasedUnits > 0 ? "text-green-700" : "text-text-strong"}`}>
            {releasedUnits != null ? releasedUnits.toLocaleString() : "—"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">
            Units in {releasedLots != null ? releasedLots.toLocaleString() : "—"} RELEASED lots — rest awaits lot review below
          </p>
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
          <p className="text-[11px] text-text-muted mt-0.5">(damaged + ripped) / units produced</p>
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

      {/* Per-flavor running totals — vendor reconciliation at a glance */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">By flavor</p>
          <h2 className="text-sm font-semibold text-text-strong">Running totals — last 7 days</h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            Everything finalized in the window, grouped by flavor. Pair with the PO view below
            to confirm against what the vendor sent.
          </p>
        </div>
        <div className="px-4 py-4">
          {flavorRollup.length === 0 ? (
            <p className="text-[12px] text-text-muted">No bags finalized in the last 7 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[12.5px] w-full">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Flavor</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Bags</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Cases</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Displays</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Loose</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Sellable units</th>
                    <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Damaged + ripped</th>
                    <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Share of week</th>
                  </tr>
                </thead>
                <tbody>
                  {flavorRollup.map((f) => {
                    const sharePct =
                      flavorTotals.units > 0
                        ? Math.round((f.units / flavorTotals.units) * 100)
                        : 0;
                    return (
                      <tr key={f.productId ?? "unmapped"} className="border-b border-border/30 last:border-0">
                        <td className="py-2 pr-4">
                          <div className="text-text-strong">
                            {f.productName ?? <span className="text-text-subtle italic">Unmapped product</span>}
                          </div>
                          {f.productSku ? (
                            <div className="font-mono text-[10.5px] text-text-muted">{f.productSku}</div>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{f.bags.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{f.cases.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{f.displays.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{f.loose.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums font-medium text-text-strong">{f.units.toLocaleString()}</td>
                        <td className={`py-2 pr-4 text-right tabular-nums ${f.damaged > 0 ? "text-amber-700" : "text-text-subtle"}`}>
                          {f.damaged.toLocaleString()}
                        </td>
                        <td className="py-2 min-w-[8rem]">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-brand-600"
                                style={{ width: `${sharePct}%` }}
                              />
                            </div>
                            <span className="text-[10.5px] tabular-nums text-text-muted w-8 text-right">{sharePct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border/60">
                    <td className="py-2 pr-4 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Total</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium text-text-strong">{flavorTotals.bags.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium text-text-strong">{flavorTotals.cases.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium text-text-strong">{flavorTotals.displays.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium text-text-strong">{flavorTotals.loose.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-semibold text-text-strong">{flavorTotals.units.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right tabular-nums font-medium text-amber-700">{flavorTotals.damaged.toLocaleString()}</td>
                    <td className="py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* P3-PO-VIEW — PO-centric comparison */}
      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border/60 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">PO view</p>
            <h2 className="text-sm font-semibold text-text-strong">
              {selectedPo
                ? `${selectedPo.po_number} · ${selectedPo.vendor_name ?? "unknown vendor"}`
                : "Select a purchase order"}
            </h2>
            <p className="text-[11px] text-text-muted mt-0.5">
              Ordered vs received vs produced per tablet line. Full receipts,
              bags, and lots drill-down on PO reconciliation.
            </p>
          </div>
          <form action="/packaging-output" className="flex items-center gap-2">
            <select
              name="poId"
              defaultValue={selectedPoId ?? ""}
              className="h-9 px-2 rounded-lg bg-surface border border-border text-sm min-w-[14rem]"
            >
              <option value="">— Select PO —</option>
              {poSummaries.map((p) => (
                <option key={p.po_id} value={p.po_id}>
                  {p.po_number} · {p.vendor_name ?? "unknown"} ({p.bag_count} bags)
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="h-9 px-3 rounded-lg bg-brand-700 text-white text-sm font-medium"
            >
              View
            </button>
          </form>
        </div>
        {poComparison && (
          <div className="px-4 py-4">
            {poComparison.length === 0 ? (
              <p className="text-sm text-text-muted">No tablet lines on this PO.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-[12.5px] w-full">
                  <thead>
                    <tr className="border-b border-border/60">
                      <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Tablet line</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Ordered</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Received</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Consumed</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Sellable units produced</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Remaining to receive</th>
                      <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Unproduced on hand</th>
                      <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Status</th>
                      <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Drill-down</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poComparison.map((line) => (
                      <tr key={line.poLineId} className="border-b border-border/30 last:border-0">
                        <td className="py-2 pr-4 text-text-strong">{line.tabletName}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{line.qtyOrdered.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{line.qtyReceived.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{line.rawConsumed.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-text-strong">{line.finishedUnits.toLocaleString()}</td>
                        <td className={`py-2 pr-4 text-right tabular-nums ${line.remainingToReceive > 0 ? "text-amber-700 font-medium" : ""}`}>
                          {line.remainingToReceive.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{line.unproducedOnHand.toLocaleString()}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              line.state === "matched"
                                ? "border-green-300 bg-green-50 text-green-800"
                                : line.state === "short"
                                  ? "border-amber-300 bg-amber-50 text-amber-900"
                                  : line.state === "over"
                                    ? "border-red-300 bg-red-50 text-red-800"
                                    : "border-sky-300 bg-sky-50 text-sky-800"
                            }`}
                          >
                            {line.state === "matched"
                              ? "Matched"
                              : line.state === "short"
                                ? "Short — under-received"
                                : line.state === "over"
                                  ? "Over-received"
                                  : "In progress"}
                          </span>
                        </td>
                        <td className="py-2">
                          <Link
                            href={`/po-reconciliation/${selectedPoId}`}
                            className="text-[11.5px] underline underline-offset-2 text-brand-700 hover:text-brand-800"
                          >
                            Lots · receipts · bags
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pack-out queue — actionable section. The id="output-queue"
          anchor is the deep-link target from the Action Center tile on
          /dashboard, so the user lands on the visible list, not the top
          of the page. */}
      <div id="output-queue" className="rounded-xl border border-border bg-surface overflow-hidden scroll-mt-4">
        <div className="px-4 py-3 border-b border-border/60">
          <p className="text-[10px] uppercase tracking-wider text-text-subtle">Output queue</p>
          <h2 className="text-sm font-semibold text-text-strong">
            {hasQueue
              ? `${awaitingLotTotal > 0 ? `${awaitingLotTotal} bag${awaitingLotTotal === 1 ? "" : "s"} awaiting lot` : ""}${awaitingLotTotal > 0 && awaitingFinalize.length > 0 ? " · " : ""}${awaitingFinalize.length > 0 ? `${awaitingFinalize.length} bag${awaitingFinalize.length === 1 ? "" : "s"} on floor` : ""}`
              : "All clear"}
          </h2>
          <p className="text-[11px] text-text-muted mt-0.5">
            {awaitingLotTotal > awaitingLot.length
              ? `Showing ${awaitingLot.length} of ${awaitingLotTotal} bags needing a finished lot — most recently finalized first. `
              : awaitingLotTotal > 0
                ? `Showing all ${awaitingLotTotal} bag${awaitingLotTotal === 1 ? "" : "s"} needing a finished lot. `
                : ""}
            <span className="font-medium text-text-strong">Finalized</span> means floor work is
            complete and counts are submitted. <span className="font-medium text-text-strong">Finished-lot
            issuance</span> turns that finalized output into an official inventory lot. Clean rows can be
            auto-issued; rows with missing or risky data stay here for review. Zoho output is a separate,
            later admin step — auto-issue never commits to Zoho.
          </p>
        </div>

        {/* AUTO-ISSUE-BATCH-1 — summary cards + batch action */}
        {awaitingLotTotal > 0 ? (
          <div className="px-4 pt-3 pb-1 border-b border-border/60">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
              <div className="rounded-lg border border-green-300/50 bg-green-50/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-green-700 font-medium">Auto-issue ready</p>
                <p className="text-xl font-mono tabular-nums text-green-800">{backlogSummary.autoIssueReady}</p>
              </div>
              <div className="rounded-lg border border-amber-300/50 bg-amber-50/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-amber-700 font-medium">Needs review</p>
                <p className="text-xl font-mono tabular-nums text-amber-800">{backlogSummary.needsReview}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-text-subtle font-medium">Blocked</p>
                <p className="text-xl font-mono tabular-nums text-text-strong">{backlogSummary.blocked}</p>
              </div>
            </div>
            {canMutate ? (
              <AutoIssueAllButton readyCount={backlogSummary.autoIssueReady} />
            ) : (
              <p className="text-[11px] text-text-subtle">
                Lead/admin can auto-issue safe lots in one click.
              </p>
            )}
            {backlogSummary.topReasons.length > 0 ? (
              <p className="mt-2 text-[10.5px] text-text-subtle">
                Top blockers:{" "}
                {backlogSummary.topReasons
                  .map((r) => `${r.label} (${r.count})`)
                  .join(" · ")}
                {backlogSummary.capped ? " · showing first 300" : ""}
              </p>
            ) : null}
          </div>
        ) : null}
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
                    Finalized — needs finished lot
                  </div>
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
                          <th className="text-right py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Sellable units</th>
                          <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Finalized at</th>
                          <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Auto-issue status</th>
                          <th className="text-left py-1.5 pr-4 font-medium text-text-muted text-[11px] uppercase tracking-wide">Next step</th>
                          <th className="text-left py-1.5 font-medium text-text-muted text-[11px] uppercase tracking-wide">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {awaitingLot.map((bag) => (
                          <tr key={bag.workflowBagId} className="border-b border-border/30 last:border-0">
                            <td className="py-2 pr-4 font-mono text-[11.5px] text-text-strong">
                              {bag.receiptNumber ?? <span className="text-text-subtle">—</span>}
                              {sourceBagSummaries.get(bag.workflowBagId) ? (
                                <details className="mt-1 font-sans">
                                  <summary className="cursor-pointer text-[10px] font-medium text-brand-700 hover:underline">
                                    Source bag
                                  </summary>
                                  <div className="mt-1 min-w-[260px]">
                                    <BagProductionSummaryInline
                                      summary={sourceBagSummaries.get(bag.workflowBagId)!}
                                      variant="panel"
                                    />
                                  </div>
                                </details>
                              ) : null}
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
                                ? formatDateTimeEst(bag.finalizedAt)
                                : "—"}
                            </td>
                            <td className="py-2 pr-4">
                              <div className="flex flex-wrap items-center gap-1">
                                <BacklogStatusChip
                                  label={bag.evaluation.label}
                                  code={bag.evaluation.code}
                                  setupReadiness={bag.setupReadiness}
                                />
                                {bag.productId && !bag.setupReadiness.unknown ? (
                                  <ZohoReadyChip ready={bag.setupReadiness.zohoReady} />
                                ) : null}
                              </div>
                              {bag.evaluation.expectedConsumedQty != null ? (
                                <div className="mt-1 text-[10px] text-text-subtle tabular-nums">
                                  Est. {bag.evaluation.expectedConsumedQty.toLocaleString()} tablets
                                </div>
                              ) : null}
                            </td>
                            <td className="py-2 pr-4 text-[11.5px] text-text-muted">
                              {bag.evaluation.nextStep}
                            </td>
                            <td className="py-2">
                              <BacklogRowActions
                                workflowBagId={bag.workflowBagId}
                                evaluation={bag.evaluation}
                                canMutate={canMutate}
                              />
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
              hint="(damaged + ripped) / units produced"
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
