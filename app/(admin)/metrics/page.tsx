import { formatDateTimeEst } from "@/lib/ui/luma-display";
// Deep metrics. Every cut the system can pull off the read models +
// workflow_events, on a single scrollable page. All time-window
// aggregations honor a single `?days=N` URL param (default 30).
//
// Sections, top-down:
//   1. Top stat strip — 30d totals (bags, units, avg cycle, yield,
//      damage, operator hours, total downtime)
//   2. Cycle time deep dive — overall + per-stage p50 / p90
//   3. Per-product (flavor) — bags, avg cycle, avg yield, damage %
//   4. Per-machine — bags, avg cycle at each stage, utilization,
//      downtime, today's count, 30d total
//   5. Per-station — bags claimed, last activity
//   6. Operator leaderboard — bags, active hours, damage rate
//   7. Downtime breakdown — by reason (PVC swap, machine jam, etc.)
//      with avg + total time
//   8. Daily throughput chart — last 30d bar chart
//   9. Material burn — top consumed materials

import Link from "next/link";
import { ChevronRight, Download, TrendingUp, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { sql, gte, eq } from "drizzle-orm";
import {
  readBagMetrics,
  readDailyThroughput,
  readOperatorDaily,
  readMaterialBurn,
  workflowEvents,
  workflowBags,
  products,
  machines,
  stations,
  packagingMaterials,
  readStationLive,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { MetricsTabs } from "@/components/ui/metrics-tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { MetricsHashScroll } from "@/components/metrics/metrics-hash-scroll";

export const dynamic = "force-dynamic";

// ── helpers ───────────────────────────────────────────────────────────────

function fmtSec(s: number | null | undefined): string {
  if (s == null || s <= 0) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(decimals)}%`;
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function p90(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.9),
  );
  return sorted[idx]!;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

// ── data loaders ──────────────────────────────────────────────────────────

async function getOverall(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const rows = await db
    .select()
    .from(readBagMetrics)
    .where(gte(readBagMetrics.finalizedAt, since));
  return rows;
}

async function getDailyThroughput(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      day: readDailyThroughput.day,
      blistered: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsBlistered}),0)::int`,
      sealed: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsSealed}),0)::int`,
      packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(sql`${readDailyThroughput.day} >= ${sinceStr}`)
    .groupBy(readDailyThroughput.day)
    .orderBy(sql`${readDailyThroughput.day} DESC`);
}

async function getDowntimeByReason(days: number) {
  // Pair every BAG_PAUSED with the next BAG_RESUMED for the same
  // bag and bucket by reason. Closed pauses only — the SQL window
  // is cheap because workflow_events has a (bag, occurred_at, id)
  // index.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return db.execute(sql`
    WITH paired AS (
      SELECT
        p.workflow_bag_id,
        p.station_id,
        COALESCE(p.payload->>'reason', 'other') AS reason,
        p.occurred_at AS paused_at,
        (
          SELECT MIN(r.occurred_at) FROM workflow_events r
          WHERE r.workflow_bag_id = p.workflow_bag_id
            AND r.event_type = 'BAG_RESUMED'
            AND r.occurred_at > p.occurred_at
        ) AS resumed_at
      FROM workflow_events p
      WHERE p.event_type = 'BAG_PAUSED'
        AND p.occurred_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      reason,
      COUNT(*)::int AS occurrences,
      COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS total_seconds,
      COALESCE(AVG(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS avg_seconds
    FROM paired
    WHERE resumed_at IS NOT NULL
    GROUP BY reason
    ORDER BY total_seconds DESC
  `);
}

async function getMachineDowntime(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return db.execute(sql`
    WITH paired AS (
      SELECT
        s.machine_id,
        m.name AS machine_name,
        m.kind AS machine_kind,
        COALESCE(p.payload->>'reason', 'other') AS reason,
        p.occurred_at AS paused_at,
        (
          SELECT MIN(r.occurred_at) FROM workflow_events r
          WHERE r.workflow_bag_id = p.workflow_bag_id
            AND r.event_type = 'BAG_RESUMED'
            AND r.occurred_at > p.occurred_at
        ) AS resumed_at
      FROM workflow_events p
      JOIN stations s ON s.id = p.station_id
      JOIN machines m ON m.id = s.machine_id
      WHERE p.event_type = 'BAG_PAUSED'
        AND p.occurred_at >= ${since.toISOString()}::timestamptz
        AND s.machine_id IS NOT NULL
    )
    SELECT
      machine_id,
      machine_name,
      machine_kind,
      COUNT(*)::int AS pause_events,
      COALESCE(SUM(EXTRACT(EPOCH FROM (resumed_at - paused_at)))::int, 0) AS total_downtime_seconds,
      COUNT(*) FILTER (WHERE reason = 'pvc_swap')::int AS pvc_swaps,
      COUNT(*) FILTER (WHERE reason = 'machine_jam')::int AS jams
    FROM paired
    WHERE resumed_at IS NOT NULL
    GROUP BY machine_id, machine_name, machine_kind
    ORDER BY total_downtime_seconds DESC
  `);
}

async function getStationActivity(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return db
    .select({
      stationId: stations.id,
      stationLabel: stations.label,
      stationKind: stations.kind,
      machineName: machines.name,
      events: sql<number>`(
        SELECT COUNT(*)::int FROM workflow_events we
        WHERE we.station_id = ${stations.id}
          AND we.occurred_at >= ${since.toISOString()}::timestamptz
      )`,
      lastActivity: sql<string | null>`(
        SELECT MAX(we.occurred_at) FROM workflow_events we
        WHERE we.station_id = ${stations.id}
      )`,
    })
    .from(stations)
    .leftJoin(machines, eq(machines.id, stations.machineId))
    .orderBy(stations.label);
}

async function getOperatorPerf(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      operatorCode: readOperatorDaily.operatorCode,
      bags: sql<number>`COALESCE(SUM(${readOperatorDaily.bagsFinalized}),0)::int`,
      activeSeconds: sql<number>`COALESCE(SUM(${readOperatorDaily.activeSecondsTotal}),0)::int`,
      damages: sql<number>`COALESCE(SUM(${readOperatorDaily.damageCountTotal}),0)::int`,
    })
    .from(readOperatorDaily)
    .where(sql`${readOperatorDaily.day} >= ${sinceStr}`)
    .groupBy(readOperatorDaily.operatorCode)
    .orderBy(sql`SUM(${readOperatorDaily.bagsFinalized}) DESC`)
    .limit(20);
}

async function getMaterialBurn(days: number) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  return db
    .select({
      materialId: readMaterialBurn.packagingMaterialId,
      materialName: packagingMaterials.name,
      materialSku: packagingMaterials.sku,
      uom: packagingMaterials.uom,
      consumed: sql<number>`COALESCE(SUM(${readMaterialBurn.qtyConsumed}),0)::int`,
    })
    .from(readMaterialBurn)
    .leftJoin(
      packagingMaterials,
      eq(readMaterialBurn.packagingMaterialId, packagingMaterials.id),
    )
    .where(sql`${readMaterialBurn.day} >= ${sinceStr}`)
    .groupBy(
      readMaterialBurn.packagingMaterialId,
      packagingMaterials.name,
      packagingMaterials.sku,
      packagingMaterials.uom,
    )
    .orderBy(sql`SUM(${readMaterialBurn.qtyConsumed}) DESC`)
    .limit(15);
}

async function getMachines() {
  return db.select().from(machines).orderBy(machines.name);
}

async function getProducts() {
  return db.select().from(products).orderBy(products.name);
}

// ── page ──────────────────────────────────────────────────────────────────

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireSession();
  const sp = await searchParams;
  const days = Math.max(1, Math.min(365, Number(sp.days ?? "30") || 30));

  const [
    bagMetrics,
    daily,
    downtimeByReason,
    machineDowntime,
    stationActivity,
    operatorPerf,
    materialBurn,
    machineRows,
    productRows,
  ] = await Promise.all([
    getOverall(days),
    getDailyThroughput(days),
    getDowntimeByReason(days),
    getMachineDowntime(days),
    getStationActivity(days),
    getOperatorPerf(days),
    getMaterialBurn(days),
    getMachines(),
    getProducts(),
  ]);

  // ── derive cuts from bagMetrics ────────────────────────────────────────
  const totalBags = bagMetrics.length;
  const totalUnits = bagMetrics.reduce((s, b) => s + b.unitsYielded, 0);
  const totalDamage = bagMetrics.reduce(
    (s, b) => s + b.damagedPackaging + b.rippedCards,
    0,
  );
  const totalCardsHandled = bagMetrics.reduce(
    (s, b) =>
      s +
      b.unitsYielded +
      b.damagedPackaging +
      b.rippedCards,
    0,
  );
  const damageRate = totalCardsHandled > 0 ? (totalDamage / totalCardsHandled) * 100 : 0;
  const yieldsWithInput = bagMetrics
    .filter((b) => b.yieldPct !== null)
    .map((b) => Number(b.yieldPct));
  const avgYield = avg(yieldsWithInput);

  const cycles = bagMetrics.map((b) => b.totalSeconds);
  const actives = bagMetrics.map((b) => b.activeSeconds);
  const pauses = bagMetrics.map((b) => b.pausedSeconds);
  const avgCycle = avg(cycles);
  const medianCycle = median(cycles);
  const p90Cycle = p90(cycles);
  const avgActive = avg(actives);
  const avgPause = avg(pauses);

  const stageStats = (
    [
      ["blister", "blisterSeconds"],
      ["sealing", "sealingSeconds"],
      ["packaging", "packagingSeconds"],
      ["bottle handpack", "bottleHandpackSeconds"],
      ["bottle cap-seal", "bottleCapSealSeconds"],
      ["bottle sticker", "bottleStickerSeconds"],
    ] as const
  ).map(([label, col]) => {
    const arr = bagMetrics
      .map((b) => b[col as keyof typeof b] as number | null)
      .filter((n): n is number => n != null);
    return {
      stage: label,
      n: arr.length,
      avg: avg(arr),
      p50: median(arr),
      p90: p90(arr),
    };
  });

  // Per-product (flavor) cuts
  const productAgg = new Map<
    string,
    { bags: number; cycles: number[]; yields: number[]; damages: number; units: number }
  >();
  for (const b of bagMetrics) {
    const k = b.productId ?? "_unassigned";
    const cur = productAgg.get(k) ?? {
      bags: 0,
      cycles: [],
      yields: [],
      damages: 0,
      units: 0,
    };
    cur.bags += 1;
    cur.cycles.push(b.totalSeconds);
    if (b.yieldPct !== null) cur.yields.push(Number(b.yieldPct));
    cur.damages += b.damagedPackaging + b.rippedCards;
    cur.units += b.unitsYielded;
    productAgg.set(k, cur);
  }
  const productById = new Map(productRows.map((p) => [p.id, p]));
  const productRowsAgg = Array.from(productAgg.entries())
    .map(([id, v]) => ({
      productId: id,
      productName: id === "_unassigned" ? "—" : productById.get(id)?.name ?? "—",
      productSku: id === "_unassigned" ? null : productById.get(id)?.sku ?? null,
      ...v,
      avgCycle: avg(v.cycles),
      avgYield: avg(v.yields),
    }))
    .sort((a, b) => b.bags - a.bags);

  // Per-machine cuts
  const machineAgg = new Map<
    string,
    {
      bags: number;
      cycles: number[];
      blister: number[];
      sealing: number[];
      packaging: number[];
    }
  >();
  for (const b of bagMetrics) {
    for (const mid of b.machineIds ?? []) {
      const cur = machineAgg.get(mid) ?? {
        bags: 0,
        cycles: [],
        blister: [],
        sealing: [],
        packaging: [],
      };
      cur.bags += 1;
      cur.cycles.push(b.totalSeconds);
      if (b.blisterSeconds != null) cur.blister.push(b.blisterSeconds);
      if (b.sealingSeconds != null) cur.sealing.push(b.sealingSeconds);
      if (b.packagingSeconds != null) cur.packaging.push(b.packagingSeconds);
      machineAgg.set(mid, cur);
    }
  }
  const machineById = new Map(machineRows.map((m) => [m.id, m]));
  const downtimeByMachineId = new Map(
    (machineDowntime as Array<Record<string, unknown>>).map((r) => [
      String(r.machine_id),
      {
        downtime: Number(r.total_downtime_seconds ?? 0),
        pauses: Number(r.pause_events ?? 0),
        pvcSwaps: Number(r.pvc_swaps ?? 0),
        jams: Number(r.jams ?? 0),
      },
    ]),
  );
  const machinePerf = Array.from(machineAgg.entries())
    .map(([id, v]) => {
      const m = machineById.get(id);
      const dt = downtimeByMachineId.get(id);
      return {
        machineId: id,
        name: m?.name ?? "—",
        kind: m?.kind ?? "",
        bags: v.bags,
        avgCycle: avg(v.cycles),
        avgBlister: avg(v.blister),
        avgSealing: avg(v.sealing),
        avgPackaging: avg(v.packaging),
        downtimeSec: dt?.downtime ?? 0,
        pauses: dt?.pauses ?? 0,
        pvcSwaps: dt?.pvcSwaps ?? 0,
        jams: dt?.jams ?? 0,
      };
    })
    .sort((a, b) => b.bags - a.bags);

  // Top operator (for stat tile)
  const topOperator = operatorPerf[0];

  // Daily throughput max for chart scaling
  const maxDailyFinalized = Math.max(1, ...daily.map((d) => d.finalized));

  return (
    <div className="space-y-5">
      <MetricsHashScroll />
      <MetricsTabs />
      <PageHeader
        title="Metrics"
        description={`Last ${days} days · ${totalBags} finalized bags · ${totalUnits.toLocaleString()} units yielded`}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              {[7, 30, 90, 365].map((n) => (
                <Link
                  key={n}
                  href={`/metrics?days=${n}`}
                  className={`text-xs px-2 py-1 rounded-md ${
                    n === days
                      ? "bg-brand-700 text-white font-semibold"
                      : "text-text-muted hover:bg-surface-2"
                  }`}
                >
                  {n}d
                </Link>
              ))}
            </div>
            <Button asChild size="sm" variant="secondary">
              <a
                href={`/api/metrics/export?set=bags&days=${days}`}
                target="_blank"
                rel="noopener"
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </a>
            </Button>
            <Button asChild size="sm">
              <Link href="/metrics/forecast">
                <TrendingUp className="h-3.5 w-3.5" /> Forecast
              </Link>
            </Button>
          </div>
        }
      />

      {/* Quick-jump tiles into per-station deep dives */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { lane: "blister", label: "Blister station" },
          { lane: "card", label: "Card flow" },
          { lane: "bottle", label: "Bottle flow" },
          { lane: "packaging", label: "Packaging" },
        ].map((l) => (
          <Link
            key={l.lane}
            href={`/metrics/${l.lane}?days=${days}`}
            className="group flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-surface px-3 py-2 hover:border-brand-300 hover:shadow-sm transition-all"
          >
            <span className="text-sm font-medium tracking-tight">
              {l.label}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-text-subtle group-hover:text-brand-700" />
          </Link>
        ))}
      </div>

      {/* Top stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <Stat label="Bags" value={totalBags.toLocaleString()} />
        <Stat label="Units" value={totalUnits.toLocaleString()} />
        <Stat label="Avg cycle" value={fmtSec(avgCycle)} />
        <Stat label="Median cycle" value={fmtSec(medianCycle)} />
        <Stat label="Avg yield" value={fmtPct(avgYield)} />
        <Stat label="Damage rate" value={fmtPct(damageRate, 2)} />
        <Stat
          label="Total downtime"
          value={fmtSec(
            (downtimeByReason as Array<Record<string, unknown>>).reduce(
              (s, r) => s + Number(r.total_seconds ?? 0),
              0,
            ),
          )}
        />
        <Stat
          label="Top operator"
          value={topOperator?.operatorCode ?? "—"}
          {...(topOperator ? { hint: `${topOperator.bags} bags` } : {})}
        />
      </div>

      {/* Cycle time deep dive */}
      <section id="cycle-time" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>Cycle time (across {totalBags} bags)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="Avg total" value={fmtSec(avgCycle)} />
            <Stat label="Avg active" value={fmtSec(avgActive)} />
            <Stat label="Avg paused" value={fmtSec(avgPause)} />
            <Stat label="P90" value={fmtSec(p90Cycle)} />
          </div>
          <DataTable>
            <THead>
              <TR>
                <TH>Stage</TH>
                <TH className="text-right">Bags</TH>
                <TH className="text-right">Avg</TH>
                <TH className="text-right">Median</TH>
                <TH className="text-right">P90</TH>
              </TR>
            </THead>
            <tbody>
              {stageStats.map((s) => (
                <TR key={s.stage}>
                  <TD className="capitalize">{s.stage}</TD>
                  <TD className="text-right tabular-nums">{s.n}</TD>
                  <TD className="text-right tabular-nums">{fmtSec(s.avg ? Math.round(s.avg) : null)}</TD>
                  <TD className="text-right tabular-nums">{fmtSec(s.p50 ? Math.round(s.p50) : null)}</TD>
                  <TD className="text-right tabular-nums">{fmtSec(s.p90)}</TD>
                </TR>
              ))}
            </tbody>
          </DataTable>
        </CardContent>
      </Card>
      </section>

      {/* Per-product (flavor) */}
      <section id="by-product" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>By product / flavor</CardTitle>
        </CardHeader>
        <CardContent>
          {productRowsAgg.length === 0 ? (
            <p className="text-sm text-text-muted">No bags yet.</p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>SKU</TH>
                  <TH className="text-right">Bags</TH>
                  <TH className="text-right">Units</TH>
                  <TH className="text-right">Avg cycle</TH>
                  <TH className="text-right">Avg yield</TH>
                  <TH className="text-right">Damage</TH>
                </TR>
              </THead>
              <tbody>
                {productRowsAgg.map((r) => (
                  <TR key={r.productId}>
                    <TD className="font-medium">{r.productName}</TD>
                    <TD className="font-mono text-xs text-text-muted">
                      {r.productSku ?? "—"}
                    </TD>
                    <TD className="text-right tabular-nums">{r.bags}</TD>
                    <TD className="text-right tabular-nums">{r.units.toLocaleString()}</TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(r.avgCycle ? Math.round(r.avgCycle) : null)}
                    </TD>
                    <TD className="text-right tabular-nums">{fmtPct(r.avgYield)}</TD>
                    <TD className="text-right tabular-nums">{r.damages}</TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Per-machine */}
      <section id="by-machine" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>By machine</CardTitle>
        </CardHeader>
        <CardContent>
          {machinePerf.length === 0 ? (
            <p className="text-sm text-text-muted">No machine activity yet.</p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Machine</TH>
                  <TH>Kind</TH>
                  <TH className="text-right">Bags</TH>
                  <TH className="text-right">Avg blister</TH>
                  <TH className="text-right">Avg sealing</TH>
                  <TH className="text-right">Avg packaging</TH>
                  <TH className="text-right">Downtime</TH>
                  <TH className="text-right">PVC swaps</TH>
                  <TH className="text-right">Jams</TH>
                </TR>
              </THead>
              <tbody>
                {machinePerf.map((m) => (
                  <TR key={m.machineId}>
                    <TD className="font-medium">{m.name}</TD>
                    <TD className="text-xs text-text-muted">{m.kind}</TD>
                    <TD className="text-right tabular-nums">{m.bags}</TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(m.avgBlister ? Math.round(m.avgBlister) : null)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(m.avgSealing ? Math.round(m.avgSealing) : null)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(m.avgPackaging ? Math.round(m.avgPackaging) : null)}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(m.downtimeSec)}
                    </TD>
                    <TD className="text-right tabular-nums">{m.pvcSwaps}</TD>
                    <TD className="text-right tabular-nums">{m.jams}</TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Per-station activity */}
      <section id="by-station" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>By station</CardTitle>
        </CardHeader>
        <CardContent>
          {stationActivity.length === 0 ? (
            <p className="text-sm text-text-muted">No stations defined.</p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Station</TH>
                  <TH>Kind</TH>
                  <TH>Machine</TH>
                  <TH className="text-right">Events ({days}d)</TH>
                  <TH>Last activity</TH>
                </TR>
              </THead>
              <tbody>
                {stationActivity.map((s) => (
                  <TR key={s.stationId}>
                    <TD className="font-medium">{s.stationLabel}</TD>
                    <TD className="text-xs text-text-muted">{s.stationKind}</TD>
                    <TD className="text-xs text-text-muted">{s.machineName ?? "—"}</TD>
                    <TD className="text-right tabular-nums">{s.events}</TD>
                    <TD className="text-xs text-text-muted">
                      {s.lastActivity
                        ? formatDateTimeEst(s.lastActivity as unknown as string)
                        : "never"}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Operator leaderboard */}
      <section id="operators" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>Operator leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {operatorPerf.length === 0 ? (
            <p className="text-sm text-text-muted">
              No operator codes captured yet. Tell operators to type their
              code on the floor PWA at scan time.
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Operator</TH>
                  <TH className="text-right">Bags finalized</TH>
                  <TH className="text-right">Active hours</TH>
                  <TH className="text-right">Avg active / bag</TH>
                  <TH className="text-right">Damages</TH>
                </TR>
              </THead>
              <tbody>
                {operatorPerf.map((o, i) => (
                  <TR key={o.operatorCode}>
                    <TD className="text-text-subtle tabular-nums">{i + 1}</TD>
                    <TD className="font-mono">{o.operatorCode}</TD>
                    <TD className="text-right tabular-nums font-semibold">{o.bags}</TD>
                    <TD className="text-right tabular-nums">
                      {(o.activeSeconds / 3600).toFixed(1)}h
                    </TD>
                    <TD className="text-right tabular-nums">
                      {fmtSec(o.bags > 0 ? Math.round(o.activeSeconds / o.bags) : null)}
                    </TD>
                    <TD className="text-right tabular-nums">{o.damages}</TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Downtime breakdown */}
      <section id="downtime" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>Downtime by reason</CardTitle>
        </CardHeader>
        <CardContent>
          {(downtimeByReason as Array<unknown>).length === 0 ? (
            <p className="text-sm text-text-muted">
              No paused bags in this window.
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Reason</TH>
                  <TH className="text-right">Occurrences</TH>
                  <TH className="text-right">Total time</TH>
                  <TH className="text-right">Avg pause</TH>
                </TR>
              </THead>
              <tbody>
                {(downtimeByReason as Array<Record<string, unknown>>).map(
                  (r, i) => (
                    <TR key={i}>
                      <TD className="font-medium capitalize">
                        {String(r.reason).replace(/_/g, " ")}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {Number(r.occurrences ?? 0)}
                      </TD>
                      <TD className="text-right tabular-nums font-semibold">
                        {fmtSec(Number(r.total_seconds ?? 0))}
                      </TD>
                      <TD className="text-right tabular-nums">
                        {fmtSec(Number(r.avg_seconds ?? 0))}
                      </TD>
                    </TR>
                  ),
                )}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Daily throughput chart */}
      <section id="daily-throughput" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>Daily throughput ({days}d)</CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <p className="text-sm text-text-muted">No throughput data yet.</p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Day</TH>
                  <TH className="text-right">Blistered</TH>
                  <TH className="text-right">Sealed</TH>
                  <TH className="text-right">Packaged</TH>
                  <TH className="text-right">Finalized</TH>
                  <TH>Bar</TH>
                </TR>
              </THead>
              <tbody>
                {daily.map((d) => (
                  <TR key={d.day}>
                    <TD className="font-mono text-xs">{d.day}</TD>
                    <TD className="text-right tabular-nums">{d.blistered}</TD>
                    <TD className="text-right tabular-nums">{d.sealed}</TD>
                    <TD className="text-right tabular-nums">{d.packaged}</TD>
                    <TD className="text-right tabular-nums font-semibold">
                      {d.finalized}
                    </TD>
                    <TD>
                      <div className="h-2 bg-surface-2 rounded-full overflow-hidden w-32">
                        <div
                          className="h-full bg-emerald-600"
                          style={{
                            width: `${Math.round((d.finalized / maxDailyFinalized) * 100)}%`,
                          }}
                        />
                      </div>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>

      {/* Material burn */}
      <section id="material-burn" className="scroll-mt-20">
      <Card>
        <CardHeader>
          <CardTitle>Material burn ({days}d)</CardTitle>
        </CardHeader>
        <CardContent>
          {materialBurn.length === 0 ? (
            <p className="text-sm text-text-muted">
              Populates from product BOM × units when finished lots are issued.
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>Material</TH>
                  <TH>SKU</TH>
                  <TH>UoM</TH>
                  <TH className="text-right">Consumed</TH>
                </TR>
              </THead>
              <tbody>
                {materialBurn.map((m) => (
                  <TR key={m.materialId ?? "_"}>
                    <TD className="font-medium">{m.materialName ?? "—"}</TD>
                    <TD className="font-mono text-xs text-text-muted">
                      {m.materialSku ?? "—"}
                    </TD>
                    <TD className="text-text-muted text-xs">{m.uom ?? "—"}</TD>
                    <TD className="text-right tabular-nums font-semibold">
                      {m.consumed.toLocaleString()}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums tracking-tight mt-0.5 truncate">
        {value}
      </div>
      {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
    </div>
  );
}
