// Live floor — production command center.
//
// Layout, top-down:
//   1. Top stat strip: completed today, in flight, avg cycle (7d),
//      stations busy, idle cards, available bags
//   2. Two flow lanes side-by-side — BLISTER/CARD and BOTTLE — each
//      a horizontal numbered pipeline of stages with the linked
//      machine label under each node. Active alerts hang to the
//      right.
//   3. Machines grid — split into "Blister / Card" and "Bottle"
//      sections. Each card shows current bag + SKU + start/elapsed
//      time + counter + last scan + today's count + 7-day avg
//      cycle.
//   4. Bag inventory in stock + Out-of-packaging bags tables.
//
// All numbers come from synchronous read models + a few targeted
// joins. pg_notify-driven SSE refreshes the whole view on every
// commit. No polling.

import {
  Activity,
  Hourglass,
  Wrench,
  PackageCheck,
  Boxes,
  AlertTriangle,
  Clock,
  CircleSlash,
  Pill,
  FlaskConical,
  PauseCircle,
} from "lucide-react";
import { db } from "@/lib/db";
import { eq, isNull, isNotNull, desc, sql, and, gte } from "drizzle-orm";
import {
  workflowBags,
  workflowEvents,
  qrCards,
  stations,
  machines,
  products,
  tabletTypes,
  inventoryBags,
  batches,
  batchHolds,
  readBagState,
  readStationLive,
  readDailyThroughput,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { PageHeader, StatusPill, EmptyState } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { LiveRefresh } from "./live-refresh";

export const dynamic = "force-dynamic";

const STAGE_KIND: Record<string, "ok" | "warn" | "info" | "neutral"> = {
  STARTED: "neutral",
  BLISTERED: "info",
  SEALED: "info",
  PACKAGED: "ok",
  FINALIZED: "ok",
};

// Pipeline lanes. Numbers match the screenshot's flow (1→7 cards,
// 1→9 bottles) so an operator scanning the page can find their
// step at a glance.
const BLISTER_LANE = [
  { n: 1, key: "BAG", label: "BAG", hint: "Bag QR scanned" },
  { n: 2, key: "BLISTER", label: "BLISTER", hint: "Blister machine" },
  { n: 4, key: "SEALING", label: "CARD / HEAT SEAL", hint: "Sealing machine" },
  { n: 6, key: "PACKAGING", label: "PACKAGING", hint: "Shared QR timer" },
  { n: 7, key: "FINAL", label: "FINAL", hint: "Lifecycle complete" },
] as const;

const BOTTLE_LANE = [
  { n: 1, key: "BAG", label: "BAG", hint: "Bag QR scanned" },
  { n: 2, key: "BOTTLE_HANDPACK", label: "HAND PACK", hint: "Fill + QA" },
  { n: 5, key: "BOTTLE_STICKER", label: "STICKER", hint: "Stickering" },
  { n: 6, key: "BOTTLE_CAP_SEAL", label: "CAP SEAL", hint: "Bottle sealer" },
  { n: 8, key: "PACKAGING", label: "PACKAGING", hint: "Shared QR timer" },
  { n: 9, key: "FINAL", label: "FINAL", hint: "Lifecycle complete" },
] as const;

// ─── data loaders ─────────────────────────────────────────────────────────

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

async function getMachineGrid() {
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
        blistered: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsBlistered}),0)::int`,
        sealed: sql<number>`COALESCE(SUM(${readDailyThroughput.bagsSealed}),0)::int`,
      })
      .from(readDailyThroughput)
      .where(eq(readDailyThroughput.day, today))
      .groupBy(readDailyThroughput.machineId),
  ]);

  // Per-station current bag detail (for the machine card "Current
  // Bag" line). Pull product name for any station that's currently
  // running a bag.
  const stationsWithBag = stationRows.filter((s) => s.currentBagId);
  const bagDetails =
    stationsWithBag.length > 0
      ? await db
          .select({
            bagId: workflowBags.id,
            startedAt: workflowBags.startedAt,
            productName: products.name,
            productSku: products.sku,
          })
          .from(workflowBags)
          .leftJoin(products, eq(workflowBags.productId, products.id))
          .where(
            sql`${workflowBags.id} IN (${sql.join(
              stationsWithBag.map((s) => sql`${s.currentBagId}`),
              sql`, `,
            )})`,
          )
      : [];
  const bagDetailById = new Map(bagDetails.map((b) => [b.bagId, b]));

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
    todayThroughput.map((r) => [r.machineId, r]),
  );

  return {
    machines: machineRows.map((m) => ({
      machine: m,
      stations: stationsByMachine.get(m.id) ?? [],
      throughput: throughputByMachine.get(m.id) ?? {
        finalized: 0,
        packaged: 0,
        blistered: 0,
        sealed: 0,
      },
    })),
    orphanStations,
    bagDetailById,
  };
}

async function getStageCounts() {
  const rows = await db
    .select({
      stage: readBagState.stage,
      n: sql<number>`count(*)::int`,
    })
    .from(readBagState)
    .where(eq(readBagState.isFinalized, false))
    .groupBy(readBagState.stage);
  const out: Record<string, number> = {
    STARTED: 0,
    BLISTERED: 0,
    SEALED: 0,
    PACKAGED: 0,
  };
  for (const r of rows) out[r.stage ?? "STARTED"] = r.n;
  return out;
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
  return row ?? { blistered: 0, sealed: 0, packaged: 0, finalized: 0 };
}

/** Average cycle time (started → finalized) for bags finalized in
 *  the last 7 days, in minutes. Null when there's no signal. */
async function getAvgCycleMinutes(): Promise<number | null> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 7);
  const rows = await db
    .select({
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
    })
    .from(workflowBags)
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        gte(workflowBags.finalizedAt, since),
      ),
    );
  if (rows.length === 0) return null;
  let total = 0;
  let n = 0;
  for (const r of rows) {
    const start = (r.startedAt as unknown as Date)?.getTime?.() ?? 0;
    const end = (r.finalizedAt as unknown as Date)?.getTime?.() ?? 0;
    if (end > start) {
      total += (end - start) / 60_000;
      n += 1;
    }
  }
  return n > 0 ? total / n : null;
}

/** Bags currently running > 60 minutes — surface as alerts so the
 *  supervisor can investigate stalls. Plus open batch holds and any
 *  bag that's been paused longer than 30 minutes (likely forgotten
 *  by the operator at shift end). */
async function getAlerts() {
  const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const stalled = await db
    .select({
      bagId: workflowBags.id,
      startedAt: workflowBags.startedAt,
      productName: products.name,
      stage: readBagState.stage,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(
      and(
        isNull(workflowBags.finalizedAt),
        sql`${workflowBags.startedAt} < ${sixtyMinAgo}`,
        // Don't double-count paused bags as "stalled" — they get
        // their own entry below.
        sql`COALESCE(${readBagState.isPaused}, false) = false`,
      ),
    )
    .orderBy(workflowBags.startedAt)
    .limit(20);

  const stuckPaused = await db
    .select({
      bagId: workflowBags.id,
      pausedAt: readBagState.pausedAt,
      productName: products.name,
      stage: readBagState.stage,
    })
    .from(readBagState)
    .innerJoin(workflowBags, eq(workflowBags.id, readBagState.workflowBagId))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .where(
      and(
        eq(readBagState.isPaused, true),
        isNotNull(readBagState.pausedAt),
        sql`${readBagState.pausedAt} < ${thirtyMinAgo}`,
        isNull(workflowBags.finalizedAt),
      ),
    )
    .orderBy(readBagState.pausedAt)
    .limit(20);

  const holds = await db
    .select({
      hold: batchHolds,
      batch: batches,
    })
    .from(batchHolds)
    .leftJoin(batches, eq(batchHolds.batchId, batches.id))
    .where(isNull(batchHolds.closedAt))
    .orderBy(desc(batchHolds.openedAt))
    .limit(20);

  return { stalled, stuckPaused, holds };
}

async function getBagInventory() {
  return db
    .select({
      tabletName: tabletTypes.name,
      tabletSku: tabletTypes.sku,
      available: sql<number>`COUNT(*) FILTER (WHERE ${inventoryBags.status} = 'AVAILABLE')::int`,
      inUse: sql<number>`COUNT(*) FILTER (WHERE ${inventoryBags.status} = 'IN_USE')::int`,
      emptied: sql<number>`COUNT(*) FILTER (WHERE ${inventoryBags.status} = 'EMPTIED')::int`,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .groupBy(tabletTypes.id, tabletTypes.name, tabletTypes.sku)
    .orderBy(sql`COUNT(*) FILTER (WHERE ${inventoryBags.status} = 'AVAILABLE') DESC`);
}

// ─── helpers ──────────────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem.toString().padStart(2, "0")}m`;
}

function machineKindLabel(k: string): string {
  return k.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── page ─────────────────────────────────────────────────────────────────

export default async function FloorBoardPage() {
  try {
    return await renderFloorBoard();
  } catch (err) {
    console.error("[floor-board] FATAL:", err);
    return (
      <pre className="m-6 p-4 rounded bg-red-50 border border-red-200 text-xs text-red-900 whitespace-pre-wrap">
        {`floor-board render failed
${err instanceof Error ? err.message : String(err)}
${err instanceof Error && err.stack ? err.stack : ""}`}
      </pre>
    );
  }
}

async function renderFloorBoard() {
  await requireSession();
  const trace = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[floor-board] ${label} failed:`, err);
      throw err;
    }
  };
  const [
    activeBags,
    machineGrid,
    stageCounts,
    todayTotals,
    avgCycleMin,
    alerts,
    bagInventory,
    idleCardsRow,
  ] = await Promise.all([
    trace("getActiveBags", getActiveBags),
    trace("getMachineGrid", getMachineGrid),
    trace("getStageCounts", getStageCounts),
    trace("getTodayTotals", getTodayTotals),
    trace("getAvgCycleMinutes", getAvgCycleMinutes),
    trace("getAlerts", getAlerts),
    trace("getBagInventory", getBagInventory),
    trace("idleCards", () =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(qrCards)
        .where(eq(qrCards.status, "IDLE")),
    ),
  ]);

  const allStations = [
    ...machineGrid.machines.flatMap((m) => m.stations),
    ...machineGrid.orphanStations,
  ];
  const busyStations = allStations.filter((s) => s.currentBagId).length;
  const totalActive = activeBags.length;
  const totalAvailableBags = bagInventory.reduce((s, r) => s + r.available, 0);

  // Flag each lane stage with whether any machine of that kind is
  // currently busy. Drives the green/idle dot under each node.
  const liveKinds = new Set<string>(
    allStations.filter((s) => s.currentBagId).map((s) => s.stationKind as string),
  );

  const blisterMachines = machineGrid.machines.filter((m) =>
    ["BLISTER", "SEALING", "PACKAGING", "COMBINED"].includes(m.machine.kind),
  );
  const bottleMachines = machineGrid.machines.filter((m) =>
    [
      "BOTTLE_HANDPACK",
      "BOTTLE_CAP_SEAL",
      "BOTTLE_STICKER",
    ].includes(m.machine.kind),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live floor"
        description="Production command center — flow lanes, machines, alerts, all live."
        actions={
          <div className="flex items-center gap-3">
            <LiveRefresh />
            <StatusPill kind="ok">
              <Activity className="h-3 w-3" /> {totalActive} active
            </StatusPill>
          </div>
        }
      />

      {/* Top stat strip — six tiles. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile
          icon={PackageCheck}
          label="Finalized today"
          value={todayTotals.finalized.toLocaleString()}
          hint={`${todayTotals.packaged} packaged earlier`}
          tone="ok"
        />
        <Tile
          icon={Boxes}
          label="In flight"
          value={totalActive.toString()}
          hint={`${stageCounts.PACKAGED ?? 0} packaged · ${(stageCounts.STARTED ?? 0) + (stageCounts.BLISTERED ?? 0) + (stageCounts.SEALED ?? 0)} pre-pack`}
        />
        <Tile
          icon={Clock}
          label="Avg cycle (7d)"
          value={avgCycleMin === null ? "—" : `${avgCycleMin.toFixed(0)}m`}
          hint={
            avgCycleMin === null
              ? "no completions yet"
              : `over ${todayTotals.finalized + 0} bags`
          }
        />
        <Tile
          icon={Wrench}
          label="Stations busy"
          value={`${busyStations}/${allStations.length}`}
          hint={
            allStations.length === 0
              ? "no stations yet"
              : `${allStations.length - busyStations} idle`
          }
        />
        <Tile
          icon={Activity}
          label="Idle cards"
          value={(idleCardsRow[0]?.n ?? 0).toLocaleString()}
          hint="ready to scan"
        />
        <Tile
          icon={Pill}
          label="Bags in stock"
          value={totalAvailableBags.toLocaleString()}
          hint={`${bagInventory.length} tablet types`}
        />
      </div>

      {/* Flow lanes + alerts. Two-thirds / one-third split on lg+ */}
      <div className="grid lg:grid-cols-[2fr_1fr] gap-4">
        <div className="space-y-3">
          <FlowLane
            title="Blister / Card flow"
            accent="border-brand-200/80"
            stages={BLISTER_LANE.map((s) => ({
              ...s,
              busy: liveKinds.has(s.key as string),
            }))}
            machinesByStage={blisterMachines}
          />
          <FlowLane
            title="Bottle flow"
            accent="border-emerald-200/80"
            stages={BOTTLE_LANE.map((s) => ({
              ...s,
              busy: liveKinds.has(s.key),
            }))}
            machinesByStage={bottleMachines}
          />
        </div>
        <AlertsPanel
          stalled={alerts.stalled.map((s) => ({
            bagId: s.bagId,
            productName: s.productName,
            stage: s.stage,
            startedAt: s.startedAt as unknown as Date,
          }))}
          stuckPaused={alerts.stuckPaused.flatMap((s) =>
            s.pausedAt
              ? [
                  {
                    bagId: s.bagId,
                    productName: s.productName,
                    stage: s.stage,
                    pausedAt: s.pausedAt as unknown as Date,
                  },
                ]
              : [],
          )}
          holds={alerts.holds.map((h) => ({
            holdId: h.hold.id,
            batchNumber: h.batch?.batchNumber ?? "—",
            reason: h.hold.reason,
            openedAt: h.hold.openedAt as unknown as Date,
          }))}
        />
      </div>

      {/* Machine cards grouped by lane */}
      {blisterMachines.length > 0 && (
        <MachineSection
          title="Blister / Card machines"
          accent="text-brand-700"
          machines={blisterMachines}
          bagDetailById={machineGrid.bagDetailById}
        />
      )}
      {bottleMachines.length > 0 && (
        <MachineSection
          title="Bottle flow machines"
          accent="text-emerald-700"
          machines={bottleMachines}
          bagDetailById={machineGrid.bagDetailById}
        />
      )}
      {machineGrid.orphanStations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Stations without a machine</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {machineGrid.orphanStations.map((s) => (
                <li
                  key={s.stationId}
                  className="flex items-center justify-between gap-2 text-xs rounded border border-border/60 bg-surface px-2 py-1"
                >
                  <span className="truncate">{s.stationLabel}</span>
                  {s.currentBagId ? (
                    <StatusPill kind="info">
                      {s.lastEventType ?? "active"}
                    </StatusPill>
                  ) : (
                    <span className="text-[10px] text-text-subtle">idle</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Bottom data tables */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Bag inventory in stock</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {bagInventory.length === 0 ? (
              <p className="text-sm text-text-muted px-4 py-3">
                No raw inventory yet. Receive a shipment from /inbound.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-2/40 text-[10px] uppercase tracking-wider text-text-subtle">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Tablet</th>
                    <th className="text-left px-4 py-2 font-medium">SKU</th>
                    <th className="text-right px-4 py-2 font-medium">Available</th>
                    <th className="text-right px-4 py-2 font-medium">In use</th>
                    <th className="text-right px-4 py-2 font-medium">Emptied</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {bagInventory.map((r, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2 font-medium">
                        {r.tabletName ?? "—"}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-text-muted">
                        {r.tabletSku ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold">
                        {r.available.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                        {r.inUse.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-subtle">
                        {r.emptied.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Active bags drill-down */}
        <Card>
          <CardHeader>
            <CardTitle>Active bags</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {activeBags.length === 0 ? (
              <div className="px-4 py-8">
                <EmptyState
                  icon={Hourglass}
                  title="No bags running"
                  description="Open /floor/<station-token> on a tablet to start scanning."
                />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-2/40 text-[10px] uppercase tracking-wider text-text-subtle">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Bag</th>
                    <th className="text-left px-4 py-2 font-medium">Product</th>
                    <th className="text-left px-4 py-2 font-medium">Stage</th>
                    <th className="text-left px-4 py-2 font-medium">Elapsed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {activeBags.map((r) => {
                    const startedMs =
                      (r.startedAt as unknown as Date)?.getTime?.() ?? 0;
                    const elapsedMs = startedMs ? Date.now() - startedMs : 0;
                    return (
                      <tr key={r.bagId}>
                        <td className="px-4 py-2 font-mono text-xs">
                          {r.bagId.slice(0, 8)}
                        </td>
                        <td className="px-4 py-2">
                          {r.product?.name ?? (
                            <span className="text-text-subtle">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <StatusPill
                            kind={STAGE_KIND[r.stage ?? "STARTED"] ?? "neutral"}
                          >
                            {r.stage ?? "STARTED"}
                          </StatusPill>
                          {r.isOnHold && (
                            <StatusPill kind="warn">on hold</StatusPill>
                          )}
                        </td>
                        <td className="px-4 py-2 text-text-muted text-xs tabular-nums">
                          {fmtElapsed(elapsedMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── components ───────────────────────────────────────────────────────────

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "ok";
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
          {label}
        </div>
        <div
          className={`h-7 w-7 rounded-md flex items-center justify-center ring-1 ring-inset ${
            tone === "ok"
              ? "bg-emerald-50 ring-emerald-100"
              : "bg-brand-50 ring-brand-100"
          }`}
        >
          <Icon
            className={`h-3.5 w-3.5 ${tone === "ok" ? "text-emerald-700" : "text-brand-700"}`}
            aria-hidden
          />
        </div>
      </div>
      <div
        className={`text-2xl font-semibold tabular-nums tracking-tight ${
          tone === "ok" ? "text-emerald-700" : ""
        }`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[11px] text-text-muted mt-0.5 truncate">{hint}</div>
      )}
    </div>
  );
}

function FlowLane({
  title,
  accent,
  stages,
  machinesByStage,
}: {
  title: string;
  accent: string;
  stages: { n: number; key: string; label: string; hint: string; busy: boolean }[];
  machinesByStage: Array<{
    machine: { id: string; name: string; kind: string };
    stations: Array<{ stationKind: string; currentBagId: string | null }>;
  }>;
}) {
  return (
    <div className={`rounded-xl border-2 ${accent} bg-surface p-4`}>
      <h3 className="text-sm font-semibold tracking-tight mb-3">{title}</h3>
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-2">
        {stages.map((s) => {
          // Find the first machine that maps to this stage (matches by
          // machine kind === stage key). Skips BAG / FINAL pseudo-stages.
          const machine = machinesByStage.find(
            (m) => m.machine.kind === s.key,
          );
          return (
            <div
              key={`${s.n}-${s.key}`}
              className="rounded-lg border border-border/70 bg-surface-2/30 p-2 space-y-1"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                    s.busy
                      ? "bg-emerald-500 text-white"
                      : "bg-text-subtle/20 text-text-muted"
                  }`}
                >
                  {s.n}
                </span>
                <p className="text-[10px] uppercase tracking-wider font-semibold truncate">
                  {s.label}
                </p>
              </div>
              <p className="text-[10px] text-text-muted truncate">{s.hint}</p>
              {machine && (
                <p className="text-[10px] font-mono text-text-subtle truncate">
                  {machine.machine.name}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AlertsPanel({
  stalled,
  stuckPaused,
  holds,
}: {
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
}) {
  const total = stalled.length + stuckPaused.length + holds.length;
  return (
    <Card className={total > 0 ? "border-amber-200" : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle
            className={`h-4 w-4 ${total > 0 ? "text-amber-600" : "text-text-subtle"}`}
          />
          Active alerts
          <span className="text-xs font-normal text-text-muted ml-auto tabular-nums">
            {total}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 max-h-80 overflow-y-auto">
        {total === 0 ? (
          <p className="text-sm text-text-muted px-4 py-3">
            No alerts. Floor's running clean.
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {stalled.map((s) => {
              const elapsed = Date.now() - s.startedAt.getTime();
              return (
                <li
                  key={s.bagId}
                  className="px-4 py-2.5 flex items-start gap-2"
                >
                  <Hourglass className="h-3.5 w-3.5 mt-0.5 text-amber-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">
                      Bag {s.bagId.slice(0, 8)} stuck at {s.stage ?? "STARTED"}
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {s.productName ?? "no product"} · running for{" "}
                      <span className="font-semibold">{fmtElapsed(elapsed)}</span>
                    </p>
                  </div>
                </li>
              );
            })}
            {stuckPaused.map((s) => {
              const elapsed = Date.now() - s.pausedAt.getTime();
              return (
                <li
                  key={`paused-${s.bagId}`}
                  className="px-4 py-2.5 flex items-start gap-2"
                >
                  <PauseCircle className="h-3.5 w-3.5 mt-0.5 text-amber-700 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">
                      Bag {s.bagId.slice(0, 8)} paused at {s.stage ?? "STARTED"}
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {s.productName ?? "no product"} · paused for{" "}
                      <span className="font-semibold">{fmtElapsed(elapsed)}</span>{" "}
                      — likely forgotten
                    </p>
                  </div>
                </li>
              );
            })}
            {holds.map((h) => {
              const elapsed = Date.now() - h.openedAt.getTime();
              return (
                <li
                  key={h.holdId}
                  className="px-4 py-2.5 flex items-start gap-2"
                >
                  <CircleSlash className="h-3.5 w-3.5 mt-0.5 text-red-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">
                      Batch {h.batchNumber} on hold
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {h.reason ?? "no reason given"} ·{" "}
                      {fmtElapsed(elapsed)} ago
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MachineSection({
  title,
  accent,
  machines,
  bagDetailById,
}: {
  title: string;
  accent: string;
  machines: Array<{
    machine: { id: string; name: string; kind: string; cardsPerTurn: number };
    stations: Array<{
      stationLabel: string;
      stationKind: string;
      currentBagId: string | null;
      lastEventType: string | null;
      lastEventAt: Date | null;
    }>;
    throughput: { finalized: number; packaged: number; blistered: number; sealed: number };
  }>;
  bagDetailById: Map<
    string,
    {
      bagId: string;
      startedAt: Date | null;
      productName: string | null;
      productSku: string | null;
    }
  >;
}) {
  return (
    <div>
      <h3 className={`text-sm font-semibold tracking-tight mb-2 ${accent}`}>
        {title}
      </h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {machines.map(({ machine, stations: linked, throughput }) => {
          const busy = linked.find((s) => s.currentBagId);
          const bag = busy?.currentBagId
            ? bagDetailById.get(busy.currentBagId)
            : null;
          const startedMs = bag?.startedAt
            ? (bag.startedAt as unknown as Date).getTime?.()
            : 0;
          const elapsedMs = startedMs ? Date.now() - startedMs : 0;
          const lastScanMs = busy?.lastEventAt
            ? (busy.lastEventAt as unknown as Date).getTime?.()
            : 0;
          // "Today" count keyed off the dominant event for this kind:
          //   BLISTER → blistered, SEALING → sealed,
          //   PACKAGING/BOTTLE_* → packaged, COMBINED → finalized.
          const todayCount =
            machine.kind === "BLISTER"
              ? throughput.blistered
              : machine.kind === "SEALING"
                ? throughput.sealed
                : throughput.finalized > 0
                  ? throughput.finalized
                  : throughput.packaged;
          return (
            <div
              key={machine.id}
              className="rounded-lg border border-border/70 bg-surface p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{machine.name}</p>
                  <p className="text-[11px] text-text-subtle">
                    {machineKindLabel(machine.kind)}
                  </p>
                </div>
                <StatusPill kind={busy ? "info" : "neutral"}>
                  {busy ? "running" : "idle"}
                </StatusPill>
              </div>

              {bag ? (
                <div className="rounded-md bg-surface-2/30 px-2 py-1.5 space-y-0.5">
                  <p className="text-[10px] uppercase tracking-wider text-text-subtle">
                    Current bag
                  </p>
                  <p className="text-xs font-mono">{bag.bagId.slice(0, 8)}</p>
                  <p className="text-[11px] text-text-muted truncate">
                    {bag.productName ?? "—"}
                    {bag.productSku ? ` · ${bag.productSku}` : ""}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-text-muted italic">
                  No active bag
                </p>
              )}

              <div className="grid grid-cols-3 gap-2 text-[11px] text-text-muted">
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-text-subtle">
                    Elapsed
                  </p>
                  <p className="font-mono text-xs text-text">
                    {bag ? fmtElapsed(elapsedMs) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-text-subtle">
                    Last scan
                  </p>
                  <p className="font-mono text-xs text-text">
                    {lastScanMs
                      ? new Date(lastScanMs).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-text-subtle">
                    Today
                  </p>
                  <p className="font-semibold text-text tabular-nums">
                    {todayCount.toLocaleString()}
                  </p>
                </div>
              </div>

              {linked.length > 0 && (
                <div className="pt-1 border-t border-border/50">
                  <p className="text-[9px] uppercase tracking-wider text-text-subtle mb-1">
                    Stations
                  </p>
                  <ul className="space-y-0.5">
                    {linked.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-center justify-between text-[11px]"
                      >
                        <span className="truncate text-text-muted">
                          {s.stationLabel}
                        </span>
                        {s.currentBagId ? (
                          <span className="text-emerald-700 font-medium">
                            {s.lastEventType ?? "active"}
                          </span>
                        ) : (
                          <span className="text-text-subtle">idle</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
