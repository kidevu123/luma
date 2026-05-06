// Per-lane metrics deep dive. Mounts at /metrics/blister,
// /metrics/card, /metrics/bottle, /metrics/packaging — one page,
// four flavors. Each renders the same shape: stat strip,
// throughput sparkbars, cycle-time histogram, downtime donut,
// per-machine table, operator table.

import Link from "next/link";
import { ArrowLeft, Download, ChevronDown } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { machines } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DataTable, THead, TR, TH, TD } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  SparkBars,
  Histogram,
  DonutChart,
} from "@/components/charts/inline-charts";
import { loadMetrics, LANE_LABEL, type Lane } from "@/lib/metrics/loader";

export const dynamic = "force-dynamic";

const VALID_LANES: Lane[] = ["blister", "card", "bottle", "packaging"];

function fmtSec(s: number | null | undefined): string {
  if (s == null || s <= 0) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export default async function LaneMetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ lane: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  await requireSession();
  const { lane: laneParam } = await params;
  const lane = laneParam as Lane;
  if (!VALID_LANES.includes(lane)) notFound();
  const sp = await searchParams;
  const days = Math.max(1, Math.min(365, Number(sp.days ?? "30") || 30));

  const m = await loadMetrics(lane, days);

  // Aggregations
  const bagCount = m.bags.length;
  const cycles = m.bags.map((b) => b.totalSeconds);
  const actives = m.bags.map((b) => b.activeSeconds);
  const totalUnits = m.bags.reduce((s, b) => s + b.unitsYielded, 0);
  const totalDamage = m.bags.reduce(
    (s, b) => s + b.damagedPackaging + b.rippedCards,
    0,
  );
  const yieldPcts = m.bags
    .map((b) => Number(b.yieldPct ?? 0))
    .filter((n) => n > 0);

  // Stage to surface based on lane.
  const stageKey: keyof typeof m.bags[number] =
    lane === "blister"
      ? "blisterSeconds"
      : lane === "card"
        ? "sealingSeconds"
        : lane === "bottle"
          ? "bottleHandpackSeconds"
          : "packagingSeconds";
  const stageValues = m.bags
    .map((b) => b[stageKey] as number | null)
    .filter((n): n is number => n != null);

  // Pad daily throughput to N days.
  const dayMap = new Map(m.dailyRows.map((r) => [r.day, r.finalized]));
  const dailySeries: number[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailySeries.push(dayMap.get(key) ?? 0);
  }

  // Machine roll-up (filtered to lane).
  const machineRows = await db.select().from(machines);
  const machineById = new Map(machineRows.map((mm) => [mm.id, mm]));
  const machineAgg = new Map<string, { bags: number; cycles: number[] }>();
  for (const b of m.bags) {
    for (const mid of b.machineIds ?? []) {
      const cur = machineAgg.get(mid) ?? { bags: 0, cycles: [] };
      cur.bags += 1;
      cur.cycles.push(b.totalSeconds);
      machineAgg.set(mid, cur);
    }
  }
  const machineRowsAgg = Array.from(machineAgg.entries())
    .map(([id, v]) => ({
      id,
      name: machineById.get(id)?.name ?? "—",
      kind: machineById.get(id)?.kind ?? "",
      bags: v.bags,
      avgCycle: avg(v.cycles),
    }))
    .sort((a, b) => b.bags - a.bags);

  // Downtime donut data.
  const donutSegments = m.downtimeByReason.map((r) => ({
    label: r.reason.replace(/_/g, " "),
    value: r.total_seconds,
  }));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/metrics"
          className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-2"
        >
          <ArrowLeft className="h-3 w-3" /> Metrics
        </Link>
        <PageHeader
          title={LANE_LABEL[lane]}
          description={`Last ${days} days · ${bagCount} bags · ${totalUnits.toLocaleString()} units yielded`}
          actions={
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                {[7, 30, 90, 365].map((n) => (
                  <Link
                    key={n}
                    href={`/metrics/${lane}?days=${n}`}
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
                  href={`/api/metrics/export?set=bags&lane=${lane}&days=${days}`}
                  target="_blank"
                  rel="noopener"
                >
                  <Download className="h-3.5 w-3.5" /> CSV
                </a>
              </Button>
            </div>
          }
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <Stat label="Bags" value={bagCount.toString()} />
        <Stat label="Units" value={totalUnits.toLocaleString()} />
        <Stat
          label="Avg cycle"
          value={fmtSec(avg(cycles) ? Math.round(avg(cycles)!) : null)}
        />
        <Stat
          label="Median active"
          value={fmtSec(median(actives) ? Math.round(median(actives)!) : null)}
        />
        <Stat
          label="Avg yield"
          value={
            yieldPcts.length === 0
              ? "—"
              : `${avg(yieldPcts)!.toFixed(1)}%`
          }
        />
        <Stat label="Damage" value={totalDamage.toLocaleString()} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Daily throughput ({days}d)</CardTitle>
          </CardHeader>
          <CardContent>
            <SparkBars data={dailySeries} height={64} />
            <p className="text-[11px] text-text-muted mt-1.5">
              Bars are bag-finalized counts per day. Range:{" "}
              {Math.min(...dailySeries)} – {Math.max(...dailySeries)}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {lane === "blister" && "Blister stage time"}
              {lane === "card" && "Sealing stage time"}
              {lane === "bottle" && "Hand-pack stage time"}
              {lane === "packaging" && "Packaging stage time"}{" "}
              <span className="text-xs font-normal text-text-muted">
                (s, n={stageValues.length})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Histogram values={stageValues} bins={10} unit="s" />
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Downtime by reason</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart segments={donutSegments} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By machine</CardTitle>
          </CardHeader>
          <CardContent>
            {machineRowsAgg.length === 0 ? (
              <p className="text-sm text-text-muted">No machine activity.</p>
            ) : (
              <DataTable>
                <THead>
                  <TR>
                    <TH>Machine</TH>
                    <TH>Kind</TH>
                    <TH className="text-right">Bags</TH>
                    <TH className="text-right">Avg cycle</TH>
                  </TR>
                </THead>
                <tbody>
                  {machineRowsAgg.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.name}</TD>
                      <TD className="text-xs text-text-muted">{r.kind}</TD>
                      <TD className="text-right tabular-nums">{r.bags}</TD>
                      <TD className="text-right tabular-nums">
                        {fmtSec(r.avgCycle ? Math.round(r.avgCycle) : null)}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </DataTable>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Operator leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {m.operators.length === 0 ? (
            <p className="text-sm text-text-muted">
              No operator codes captured. Operators type their code on the
              floor PWA to populate this.
            </p>
          ) : (
            <DataTable>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Operator</TH>
                  <TH className="text-right">Bags</TH>
                  <TH className="text-right">Active hours</TH>
                  <TH className="text-right">Damage</TH>
                </TR>
              </THead>
              <tbody>
                {m.operators.map((o, i) => (
                  <TR key={o.operatorCode}>
                    <TD className="text-text-subtle tabular-nums">{i + 1}</TD>
                    <TD className="font-mono">{o.operatorCode}</TD>
                    <TD className="text-right tabular-nums font-semibold">
                      {o.bags}
                    </TD>
                    <TD className="text-right tabular-nums">
                      {(o.activeSeconds / 3600).toFixed(1)}h
                    </TD>
                    <TD className="text-right tabular-nums">{o.damages}</TD>
                  </TR>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums tracking-tight mt-0.5 truncate">
        {value}
      </div>
    </div>
  );
}
