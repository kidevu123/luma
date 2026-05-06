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
import { eq, isNull, isNotNull, desc, sql, and, gte, lt } from "drizzle-orm";
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

/** Active bags for the live floor's cards list. Bounded to 200 —
 *  legacy import seeded ~5,300 unfinalized workflow_bags from old TT
 *  data and rendering them all is slow and useless on a live floor.
 *  The 200 cap shows the most recent activity; older legacy bags
 *  are still in the DB for reporting/audit. */
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
    .orderBy(desc(workflowBags.startedAt))
    .limit(200);
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
        lt(workflowBags.startedAt, sixtyMinAgo),
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
        lt(readBagState.pausedAt, thirtyMinAgo),
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

// ─── act-now metrics (per metrics-strategy.md §13.2) ─────────────

/** Forgotten-bag detector — paused for > 30 min and not finalized.
 *  This is the highest-priority lead-action signal (§3.8). Returns
 *  the freshest 20 with product + receipt for the panel. */
async function getForgottenBags(): Promise<
  Array<{
    bagId: string;
    pausedAt: Date;
    productName: string | null;
    receiptNumber: string | null;
    stage: string | null;
  }>
> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const rows = await db
    .select({
      bagId: workflowBags.id,
      pausedAt: readBagState.pausedAt,
      productName: products.name,
      receiptNumber: workflowBags.receiptNumber,
      stage: readBagState.stage,
    })
    .from(readBagState)
    .innerJoin(workflowBags, eq(workflowBags.id, readBagState.workflowBagId))
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .where(
      and(
        eq(readBagState.isPaused, true),
        isNotNull(readBagState.pausedAt),
        lt(readBagState.pausedAt, thirtyMinAgo),
        isNull(workflowBags.finalizedAt),
      ),
    )
    .orderBy(readBagState.pausedAt)
    .limit(20);
  return rows.flatMap((r) =>
    r.pausedAt
      ? [
          {
            bagId: r.bagId,
            pausedAt: r.pausedAt as unknown as Date,
            productName: r.productName,
            receiptNumber: r.receiptNumber,
            stage: r.stage,
          },
        ]
      : [],
  );
}

/** Aged unfinalized inventory — bags with started_at older than 30
 *  days and no finalized_at (§7.5). Owner-actionable urgency: those
 *  bags are sitting on cash. Returns count + units (bag.pillCount sum)
 *  + the top 5 oldest for the drill-down. */
async function getAgedUnfinalized(): Promise<{
  count: number;
  unitsTied: number;
  oldest: Array<{
    bagId: string;
    daysOld: number;
    productName: string | null;
    receiptNumber: string | null;
  }>;
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [agg] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
      unitsTied: sql<number>`COALESCE(SUM(${inventoryBags.pillCount}), 0)::int`,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .where(
      and(
        isNull(workflowBags.finalizedAt),
        lt(workflowBags.startedAt, thirtyDaysAgo),
      ),
    );
  const oldestRows = await db
    .select({
      bagId: workflowBags.id,
      startedAt: workflowBags.startedAt,
      productName: products.name,
      receiptNumber: workflowBags.receiptNumber,
    })
    .from(workflowBags)
    .leftJoin(products, eq(workflowBags.productId, products.id))
    .where(
      and(
        isNull(workflowBags.finalizedAt),
        lt(workflowBags.startedAt, thirtyDaysAgo),
      ),
    )
    .orderBy(workflowBags.startedAt)
    .limit(5);
  const now = Date.now();
  return {
    count: agg?.count ?? 0,
    unitsTied: agg?.unitsTied ?? 0,
    oldest: oldestRows.map((r) => ({
      bagId: r.bagId,
      daysOld: Math.floor(
        (now - (r.startedAt as unknown as Date).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
      productName: r.productName,
      receiptNumber: r.receiptNumber,
    })),
  };
}

/** Lane-imbalance ratio — last 24h `bags_blistered / bags_packaged`
 *  per lane (§1.29). Ratio > 1.3 = blistering ahead, < 0.77 =
 *  packaging ahead. Returns ratio per lane + the actionable verdict. */
async function getLaneImbalance(): Promise<{
  cardLane: { blistered: number; packaged: number; ratio: number | null };
  bottleLane: { handpacked: number; packaged: number; ratio: number | null };
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [counts] = await db
    .select({
      cardBlistered: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BLISTER_COMPLETE')::int`,
      cardPackaged: sql<number>`COUNT(*) FILTER (WHERE event_type::text IN ('PACKAGING_SNAPSHOT','PACKAGING_COMPLETE'))::int`,
      bottleHandpacked: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_HANDPACK_COMPLETE')::int`,
      bottlePackaged: sql<number>`COUNT(*) FILTER (WHERE event_type::text = 'BOTTLE_STICKER_COMPLETE')::int`,
    })
    .from(workflowEvents)
    .where(gte(workflowEvents.occurredAt, since));
  const card = {
    blistered: counts?.cardBlistered ?? 0,
    packaged: counts?.cardPackaged ?? 0,
    ratio:
      (counts?.cardPackaged ?? 0) > 0
        ? (counts?.cardBlistered ?? 0) / (counts?.cardPackaged ?? 1)
        : null,
  };
  const bottle = {
    handpacked: counts?.bottleHandpacked ?? 0,
    packaged: counts?.bottlePackaged ?? 0,
    ratio:
      (counts?.bottlePackaged ?? 0) > 0
        ? (counts?.bottleHandpacked ?? 0) / (counts?.bottlePackaged ?? 1)
        : null,
  };
  return { cardLane: card, bottleLane: bottle };
}

/** Bottleneck-of-the-hour — across the last 60 min of stage events,
 *  which stage type accumulated the most cycle time (§1.16). Crude:
 *  takes the avg gap between events of each stage in the last hour
 *  and ranks them. Returns the slowest one. */
async function getBottleneckOfHour(): Promise<{
  stage: string | null;
  avgSeconds: number;
  events: number;
}> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = (await db.execute(sql`
    WITH e AS (
      SELECT
        we.event_type::text AS stage_event,
        we.occurred_at,
        LAG(we.occurred_at) OVER (
          PARTITION BY we.workflow_bag_id, we.event_type ORDER BY we.occurred_at
        ) AS prev_at
      FROM workflow_events we
      WHERE we.occurred_at >= ${sinceIso}::timestamptz
        AND we.event_type::text IN (
          'BLISTER_COMPLETE','SEALING_COMPLETE',
          'PACKAGING_SNAPSHOT','PACKAGING_COMPLETE',
          'BOTTLE_HANDPACK_COMPLETE','BOTTLE_CAP_SEAL_COMPLETE',
          'BOTTLE_STICKER_COMPLETE'
        )
    )
    SELECT
      stage_event,
      COUNT(*)::int AS events,
      COALESCE(AVG(EXTRACT(EPOCH FROM (occurred_at - prev_at))) FILTER (WHERE prev_at IS NOT NULL), 0)::int AS avg_sec
    FROM e
    GROUP BY stage_event
    ORDER BY avg_sec DESC
    LIMIT 1
  `)) as unknown as Array<{ stage_event: string; events: number; avg_sec: number }>;
  const r = rows[0];
  if (!r) return { stage: null, avgSeconds: 0, events: 0 };
  return { stage: r.stage_event, avgSeconds: r.avg_sec, events: r.events };
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

function bottleneckLabel(eventType: string): string {
  switch (eventType) {
    case "BLISTER_COMPLETE": return "Blister";
    case "SEALING_COMPLETE": return "Sealing";
    case "PACKAGING_SNAPSHOT":
    case "PACKAGING_COMPLETE": return "Packaging";
    case "BOTTLE_HANDPACK_COMPLETE": return "Bottle handpack";
    case "BOTTLE_CAP_SEAL_COMPLETE": return "Bottle cap seal";
    case "BOTTLE_STICKER_COMPLETE": return "Bottle sticker";
    default: return eventType;
  }
}

// ─── page ─────────────────────────────────────────────────────────────────

export default async function FloorBoardPage() {
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
    forgottenBags,
    agedUnfinalized,
    laneImbalance,
    bottleneck,
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
    trace("getForgottenBags", getForgottenBags),
    trace("getAgedUnfinalized", getAgedUnfinalized),
    trace("getLaneImbalance", getLaneImbalance),
    trace("getBottleneckOfHour", getBottleneckOfHour),
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

      {/* Act-Now strip — exception-first tiles per metrics-strategy §13.2.
          The lead glances here for "what needs me right now," not for
          throughput (that's on the TV). Tone:
            - red    = action needed now
            - amber  = watch
            - ok     = clear */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile
          icon={Hourglass}
          label="Forgotten bags"
          value={forgottenBags.length.toLocaleString()}
          hint={
            forgottenBags.length === 0
              ? "no paused bags > 30m"
              : "paused > 30 min — investigate below"
          }
          tone={forgottenBags.length > 0 ? "danger" : "ok"}
        />
        <Tile
          icon={Hourglass}
          label="Aged unfinalized"
          value={agedUnfinalized.count.toLocaleString()}
          hint={
            agedUnfinalized.count === 0
              ? "all bags fresh"
              : `${agedUnfinalized.unitsTied.toLocaleString()} units tied up · click for list`
          }
          tone={agedUnfinalized.count > 0 ? "warn" : "ok"}
        />
        <Tile
          icon={Activity}
          label="Bottleneck (1h)"
          value={
            bottleneck.stage
              ? bottleneckLabel(bottleneck.stage)
              : "—"
          }
          hint={
            bottleneck.stage
              ? `~${Math.round(bottleneck.avgSeconds / 60)}m avg · ${bottleneck.events} events`
              : "no recent activity"
          }
          tone={bottleneck.stage ? "warn" : "neutral"}
        />
        <Tile
          icon={Wrench}
          label="Card lane balance"
          value={
            laneImbalance.cardLane.ratio === null
              ? "—"
              : laneImbalance.cardLane.ratio.toFixed(2) + "×"
          }
          hint={
            laneImbalance.cardLane.ratio === null
              ? "no card flow last 24h"
              : `${laneImbalance.cardLane.blistered} blistered → ${laneImbalance.cardLane.packaged} packaged`
          }
          tone={
            laneImbalance.cardLane.ratio === null
              ? "neutral"
              : laneImbalance.cardLane.ratio > 1.3 ||
                  laneImbalance.cardLane.ratio < 0.77
                ? "warn"
                : "ok"
          }
        />
        <Tile
          icon={PackageCheck}
          label="Finalized today"
          value={todayTotals.finalized.toLocaleString()}
          hint={`${totalActive} in flight · ${todayTotals.packaged} packaged`}
          tone="ok"
        />
        <Tile
          icon={Pill}
          label="Bags in stock"
          value={totalAvailableBags.toLocaleString()}
          hint={`${bagInventory.length} types · ${idleCardsRow[0]?.n ?? 0} idle cards`}
        />
      </div>

      {/* Forgotten bags panel — clickable list of bags paused > 30 min.
          Most actionable signal a lead can have. */}
      {forgottenBags.length > 0 && (
        <Card className="border-red-200 bg-red-50/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-900">
              <Hourglass className="h-4 w-4 text-red-700" />
              {forgottenBags.length} bag{forgottenBags.length === 1 ? "" : "s"}{" "}
              paused &gt; 30 min — investigate
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-red-200/70">
              {forgottenBags.slice(0, 10).map((b) => {
                const mins = Math.floor(
                  (Date.now() - b.pausedAt.getTime()) / 60_000,
                );
                return (
                  <li
                    key={b.bagId}
                    className="px-4 py-2.5 flex items-start gap-3 text-sm"
                  >
                    <Hourglass className="h-3.5 w-3.5 mt-0.5 text-red-700 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-text">
                        {b.productName ?? "(no product)"} ·{" "}
                        <span className="text-text-muted">
                          {b.receiptNumber ?? b.bagId.slice(0, 8)}
                        </span>{" "}
                        — {b.stage ?? "STARTED"}
                      </div>
                      <div className="text-[11px] text-text-muted">
                        Paused for{" "}
                        <span className="font-semibold text-red-700">
                          {fmtElapsed(mins * 60_000)}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Aged unfinalized drill-down — list 5 oldest bags. */}
      {agedUnfinalized.count > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Hourglass className="h-4 w-4 text-amber-700" />
              {agedUnfinalized.count} bag{agedUnfinalized.count === 1 ? "" : "s"}{" "}
              unfinalized over 30 days · {agedUnfinalized.unitsTied.toLocaleString()} units
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-text-muted px-4 pb-3 pt-0">
            <ul className="space-y-1">
              {agedUnfinalized.oldest.map((b) => (
                <li key={b.bagId} className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-text-subtle tabular-nums w-12">
                    {b.daysOld}d
                  </span>
                  <span className="font-medium text-text">
                    {b.productName ?? "(no product)"}
                  </span>
                  <span className="text-text-subtle">
                    · {b.receiptNumber ?? b.bagId.slice(0, 8)}
                  </span>
                </li>
              ))}
              {agedUnfinalized.count > agedUnfinalized.oldest.length && (
                <li className="text-text-subtle italic">
                  …and {agedUnfinalized.count - agedUnfinalized.oldest.length} older
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
      )}

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
  tone?: "default" | "ok" | "warn" | "danger" | "neutral";
}) {
  const palette = (() => {
    switch (tone) {
      case "ok":      return { bg: "bg-emerald-50", ring: "ring-emerald-100", icon: "text-emerald-700", value: "text-emerald-700", border: "border-border/70" };
      case "warn":    return { bg: "bg-amber-50",   ring: "ring-amber-200",   icon: "text-amber-700",   value: "text-amber-800",   border: "border-amber-200" };
      case "danger":  return { bg: "bg-red-50",     ring: "ring-red-200",     icon: "text-red-700",     value: "text-red-800",     border: "border-red-200" };
      case "neutral": return { bg: "bg-surface-2",  ring: "ring-border/60",   icon: "text-text-muted",  value: "text-text-muted",  border: "border-border/70" };
      default:        return { bg: "bg-brand-50",   ring: "ring-brand-100",   icon: "text-brand-700",   value: "",                 border: "border-border/70" };
    }
  })();
  return (
    <div className={`rounded-xl border bg-surface p-3 ${palette.border}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-wider text-text-subtle font-semibold">
          {label}
        </div>
        <div
          className={`h-7 w-7 rounded-md flex items-center justify-center ring-1 ring-inset ${palette.bg} ${palette.ring}`}
        >
          <Icon className={`h-3.5 w-3.5 ${palette.icon}`} aria-hidden />
        </div>
      </div>
      <div
        className={`text-2xl font-semibold tabular-nums tracking-tight ${palette.value}`}
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
