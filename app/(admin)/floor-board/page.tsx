// Live floor board — operations dashboard. Five blocks:
//   1. Top stats — bags in flight / today's finalized / busy stations / idle cards
//   2. Production pipeline — horizontal stages with live bag counts + flow
//   3. Machines grid — one card per machine with linked stations + today's throughput
//   4. Stations strip — full per-station status (compact, supplements machines view)
//   5. Active bags — full table for drill-down
//
// All counts come from synchronous read models so this page is
// effectively cost-free and never lags the source of truth. SSE
// (LiveRefresh) calls router.refresh() whenever a workflow_event
// commits.

import {
  Activity,
  Hourglass,
  Wrench,
  PackageCheck,
  Boxes,
  ArrowRight,
} from "lucide-react";
import { db } from "@/lib/db";
import { eq, isNull, desc, sql } from "drizzle-orm";
import {
  workflowBags,
  qrCards,
  stations,
  machines,
  products,
  readBagState,
  readStationLive,
  readDailyThroughput,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { LiveRefresh } from "./live-refresh";

export const dynamic = "force-dynamic";

// Pipeline stages, in order. Drives both the per-stage counts strip
// and the bag-detail row's stage pill.
const STAGES = ["STARTED", "BLISTERED", "SEALED", "PACKAGED"] as const;
type Stage = (typeof STAGES)[number];

const STAGE_KIND: Record<string, "ok" | "warn" | "info" | "neutral"> = {
  STARTED: "neutral",
  BLISTERED: "info",
  SEALED: "info",
  PACKAGED: "ok",
  FINALIZED: "ok",
};

const STAGE_TONE: Record<Stage, string> = {
  STARTED: "border-slate-200 bg-slate-50",
  BLISTERED: "border-brand-200 bg-brand-50",
  SEALED: "border-brand-200 bg-brand-50",
  PACKAGED: "border-emerald-200 bg-emerald-50",
};

async function getActiveBags() {
  return db
    .select({
      bagId: workflowBags.id,
      startedAt: workflowBags.startedAt,
      product: products,
      stage: readBagState.stage,
      lastEventAt: readBagState.lastEventAt,
      isOnHold: readBagState.isOnHold,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(isNull(workflowBags.finalizedAt))
    .orderBy(desc(workflowBags.startedAt));
}

async function getStageCounts(): Promise<Record<Stage, number>> {
  // Count bags currently in each non-finalized stage.
  const rows = await db
    .select({
      stage: readBagState.stage,
      n: sql<number>`count(*)::int`,
    })
    .from(readBagState)
    .where(eq(readBagState.isFinalized, false))
    .groupBy(readBagState.stage);
  const out: Record<Stage, number> = {
    STARTED: 0,
    BLISTERED: 0,
    SEALED: 0,
    PACKAGED: 0,
  };
  for (const r of rows) {
    if (r.stage && (STAGES as readonly string[]).includes(r.stage)) {
      out[r.stage as Stage] = r.n;
    }
  }
  return out;
}

async function getMachineGrid() {
  // Machines + their stations + each station's current bag, plus
  // today's bag-count per machine. Fan-out queries — small set.
  const today = new Date().toISOString().slice(0, 10);
  const [machineRows, stationRows, todayThroughput] = await Promise.all([
    db.select().from(machines).orderBy(machines.name),
    db
      .select({
        stationId: stations.id,
        stationLabel: stations.label,
        stationKind: stations.kind,
        machineId: stations.machineId,
        currentBagId: readStationLive.currentWorkflowBagId,
        lastEventType: readStationLive.lastEventType,
        lastEventAt: readStationLive.lastEventAt,
      })
      .from(stations)
      .leftJoin(readStationLive, eq(readStationLive.stationId, stations.id))
      .orderBy(stations.label),
    db
      .select({
        machineId: readDailyThroughput.machineId,
        finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
        packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
      })
      .from(readDailyThroughput)
      .where(eq(readDailyThroughput.day, today))
      .groupBy(readDailyThroughput.machineId),
  ]);

  const stationsByMachine = new Map<string, typeof stationRows>();
  const orphanStations: typeof stationRows = [];
  for (const s of stationRows) {
    if (s.machineId) {
      const list = stationsByMachine.get(s.machineId) ?? [];
      list.push(s);
      stationsByMachine.set(s.machineId, list);
    } else {
      orphanStations.push(s);
    }
  }

  const throughputByMachine = new Map(
    todayThroughput.map((r) => [
      r.machineId,
      { finalized: r.finalized, packaged: r.packaged },
    ]),
  );

  return {
    machines: machineRows.map((m) => ({
      machine: m,
      stations: stationsByMachine.get(m.id) ?? [],
      throughput: throughputByMachine.get(m.id) ?? { finalized: 0, packaged: 0 },
    })),
    orphanStations,
  };
}

async function getTodayTotals() {
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .select({
      blistered: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsBlistered}),0)::int`,
      sealed: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsSealed}),0)::int`,
      packaged: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsPackaged}),0)::int`,
      finalized: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsFinalized}),0)::int`,
    })
    .from(readDailyThroughput)
    .where(eq(readDailyThroughput.day, today));
  return (
    row ?? { blistered: 0, sealed: 0, packaged: 0, finalized: 0 }
  );
}

export default async function FloorBoardPage() {
  await requireSession();
  const [rows, stageCounts, todayTotals, machineGrid, idleCards] =
    await Promise.all([
      getActiveBags(),
      getStageCounts(),
      getTodayTotals(),
      getMachineGrid(),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(qrCards)
        .where(eq(qrCards.status, "IDLE")),
    ]);
  const allStations = [
    ...machineGrid.machines.flatMap((m) => m.stations),
    ...machineGrid.orphanStations,
  ];
  const busyStations = allStations.filter((s) => s.currentBagId).length;
  const totalActive = rows.length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live floor"
        description="Operations dashboard. Stages, machines, and active bags — all live, all real-time."
        actions={
          <div className="flex items-center gap-3">
            <LiveRefresh />
            <StatusPill kind="ok">
              <Activity className="h-3 w-3" /> {totalActive} active
            </StatusPill>
          </div>
        }
      />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile
          icon={Boxes}
          label="Bags in flight"
          value={totalActive.toString()}
          hint={`${stageCounts.STARTED + stageCounts.BLISTERED + stageCounts.SEALED} pre-pack · ${stageCounts.PACKAGED} packed`}
        />
        <Tile
          icon={PackageCheck}
          label="Finalized today"
          value={todayTotals.finalized.toLocaleString()}
          hint={`${todayTotals.packaged} packaged earlier today`}
        />
        <Tile
          icon={Wrench}
          label="Stations busy"
          value={`${busyStations}/${allStations.length}`}
          hint={
            allStations.length === 0
              ? "no stations defined"
              : `${allStations.length - busyStations} idle`
          }
        />
        <Tile
          icon={Activity}
          label="Idle QR cards"
          value={(idleCards[0]?.n ?? 0).toLocaleString()}
          hint="ready for next scan"
        />
      </div>

      {/* Pipeline */}
      <Card>
        <CardHeader>
          <CardTitle>Production pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {STAGES.map((stage, i) => {
              const count = stageCounts[stage];
              const next = STAGES[i + 1];
              return (
                <div
                  key={stage}
                  className={`relative rounded-lg border ${STAGE_TONE[stage]} p-3`}
                >
                  <p className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
                    {stage}
                  </p>
                  <p className="text-3xl font-semibold tabular-nums mt-0.5">
                    {count}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    bag{count === 1 ? "" : "s"} in stage
                  </p>
                  {next && (
                    <ArrowRight
                      className="hidden sm:block absolute -right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-subtle/60 z-10"
                      aria-hidden
                    />
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-text-subtle mt-3">
            Today's totals: {todayTotals.blistered} blistered ·{" "}
            {todayTotals.sealed} sealed · {todayTotals.packaged} packaged ·{" "}
            <span className="font-semibold text-emerald-700">
              {todayTotals.finalized} finalized
            </span>
            .
          </p>
        </CardContent>
      </Card>

      {/* Machines grid */}
      {machineGrid.machines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Machines</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {machineGrid.machines.map(({ machine, stations: linked, throughput }) => {
                const machineBusy = linked.some((s) => s.currentBagId);
                return (
                  <div
                    key={machine.id}
                    className="rounded-lg border border-border/70 bg-surface p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{machine.name}</p>
                        <p className="text-[11px] text-text-subtle">
                          {machine.kind} · {machine.cardsPerTurn} card
                          {machine.cardsPerTurn === 1 ? "" : "s"}/turn
                        </p>
                      </div>
                      <StatusPill kind={machineBusy ? "info" : "neutral"}>
                        {machineBusy ? "running" : "idle"}
                      </StatusPill>
                    </div>
                    <div className="text-[11px] text-text-muted">
                      Today:{" "}
                      <span className="font-semibold text-text">
                        {throughput.finalized}
                      </span>{" "}
                      finalized · {throughput.packaged} packaged
                    </div>
                    {linked.length === 0 ? (
                      <p className="text-[11px] text-text-subtle italic">
                        No stations linked
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {linked.map((s) => (
                          <li
                            key={s.stationId}
                            className="flex items-center justify-between text-xs gap-2"
                          >
                            <span className="truncate text-text-muted">
                              {s.stationLabel}
                            </span>
                            {s.currentBagId ? (
                              <StatusPill kind="info">
                                {s.lastEventType ?? "active"}
                              </StatusPill>
                            ) : (
                              <span className="text-[10px] text-text-subtle">
                                idle
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
            {machineGrid.orphanStations.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/60">
                <p className="text-[11px] uppercase tracking-wider text-text-subtle mb-1.5">
                  Stations without a machine
                </p>
                <ul className="grid sm:grid-cols-2 gap-1.5">
                  {machineGrid.orphanStations.map((s) => (
                    <li
                      key={s.stationId}
                      className="flex items-center justify-between gap-2 text-xs rounded border border-border/60 bg-surface px-2 py-1"
                    >
                      <span className="truncate">{s.stationLabel}</span>
                      {s.currentBagId ? (
                        <StatusPill kind="info">{s.lastEventType ?? "active"}</StatusPill>
                      ) : (
                        <span className="text-[10px] text-text-subtle">idle</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Active bags drill-down */}
      {rows.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="No bags running"
          description="Open /floor/<station-token> on a tablet to start scanning."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Active bags</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-surface-2/50 text-xs text-text-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Bag
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Product
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Stage
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Last event
                  </th>
                  <th className="text-left px-4 py-2 font-medium uppercase tracking-wider text-[11px]">
                    Started
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.bagId} className="border-t border-border/50">
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.bagId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      {r.product?.name ?? <span className="text-text-subtle">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        kind={STAGE_KIND[r.stage ?? "STARTED"] ?? "neutral"}
                      >
                        {r.stage ?? "STARTED"}
                      </StatusPill>
                      {r.isOnHold && <StatusPill kind="warn">on hold</StatusPill>}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs tabular-nums">
                      {r.lastEventAt
                        ? new Date(
                            r.lastEventAt as unknown as string,
                          ).toLocaleTimeString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {r.startedAt
                        ? new Date(
                            r.startedAt as unknown as string,
                          ).toLocaleTimeString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
          {label}
        </div>
        <div className="h-7 w-7 rounded-md bg-brand-50 flex items-center justify-center ring-1 ring-inset ring-brand-100">
          <Icon className="h-3.5 w-3.5 text-brand-700" aria-hidden />
        </div>
      </div>
      <div className="text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      {hint && (
        <div className="text-[11px] text-text-muted mt-0.5 truncate">{hint}</div>
      )}
    </div>
  );
}
