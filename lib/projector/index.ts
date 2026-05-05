// Synchronous projector. Runs inside the same transaction as the
// workflow_event insert so the read models never lag the source of
// truth. The async projector worker is reserved for heavier rollups
// (read_daily_throughput, read_material_burn) that can tolerate
// seconds of staleness.
//
// Why synchronous? The floor board and station overlays are the most
// time-sensitive read in the system — operators stare at them. Even
// 200ms of lag invites "did my scan land?" double-taps. Coupling the
// projection to the event commit means the read is correct as soon
// as the action returns.
//
// Why a single helper? Every code path that fires a workflow_event
// needs the same projection or the read models drift. The helper is
// the only place that's allowed to insert into workflow_events going
// forward.

import { eq, sql } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  workflowEvents,
  workflowBags,
  readStationLive,
  readBagState,
  readDailyThroughput,
  stations,
  qrCards,
} from "@/lib/db/schema";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type WorkflowEventType = typeof workflowEvents.$inferInsert["eventType"];

type EventInput = {
  workflowBagId: string;
  stationId?: string | null;
  eventType: WorkflowEventType;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
};

const STAGE_FOR_EVENT: Record<string, string> = {
  CARD_ASSIGNED: "STARTED",
  BLISTER_COMPLETE: "BLISTERED",
  SEALING_COMPLETE: "SEALED",
  PACKAGING_SNAPSHOT: "PACKAGED",
  BOTTLE_HANDPACK_COMPLETE: "BLISTERED", // bottle-line analog of "first transform done"
  BOTTLE_CAP_SEAL_COMPLETE: "SEALED",
  BOTTLE_STICKER_COMPLETE: "PACKAGED",
  BAG_FINALIZED: "FINALIZED",
};

/** Which read_daily_throughput counter to increment for each event.
 *  CARD_ASSIGNED is intentionally skipped — it's not a finishing
 *  signal, and counting it here would double-count every bag. */
const THROUGHPUT_COLUMN: Record<string, string> = {
  BLISTER_COMPLETE: "bags_blistered",
  BOTTLE_HANDPACK_COMPLETE: "bags_blistered",
  SEALING_COMPLETE: "bags_sealed",
  BOTTLE_CAP_SEAL_COMPLETE: "bags_sealed",
  PACKAGING_SNAPSHOT: "bags_packaged",
  BOTTLE_STICKER_COMPLETE: "bags_packaged",
  BAG_FINALIZED: "bags_finalized",
};

/** Insert a workflow_event AND update the live read models in one
 *  transaction. Always use this — never insert into workflow_events
 *  directly from a route. */
export async function projectEvent(tx: Tx, ev: EventInput): Promise<void> {
  const occurredAt = ev.occurredAt ?? new Date();
  await tx.insert(workflowEvents).values({
    workflowBagId: ev.workflowBagId,
    stationId: ev.stationId ?? null,
    eventType: ev.eventType,
    payload: ev.payload ?? {},
    occurredAt,
  });

  // 1. read_station_live — only meaningful when the event has a station
  //    AND the bag isn't being finalized (finalize releases the station).
  if (ev.stationId && ev.eventType !== "BAG_FINALIZED") {
    await tx
      .insert(readStationLive)
      .values({
        stationId: ev.stationId,
        currentWorkflowBagId: ev.workflowBagId,
        lastEventType: ev.eventType,
        lastEventAt: occurredAt,
        updatedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: readStationLive.stationId,
        set: {
          currentWorkflowBagId: ev.workflowBagId,
          lastEventType: ev.eventType,
          lastEventAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
  } else if (ev.eventType === "BAG_FINALIZED") {
    // Release any station that was pinned to this bag.
    await tx
      .update(readStationLive)
      .set({
        currentWorkflowBagId: null,
        lastEventType: "BAG_FINALIZED",
        lastEventAt: occurredAt,
        updatedAt: occurredAt,
      })
      .where(eq(readStationLive.currentWorkflowBagId, ev.workflowBagId));
  }

  // 2. read_bag_state — track per-bag stage progression. Forward-only:
  //    the projector ranks stages and refuses to downgrade if a stale
  //    event lands after a later one. We use a small CASE to compare
  //    incoming-rank to stored-rank in SQL (keeps the upsert atomic).
  const stage = STAGE_FOR_EVENT[ev.eventType];
  if (stage) {
    const isFinalized = ev.eventType === "BAG_FINALIZED";
    const newRank = stageRank(stage);
    await tx
      .insert(readBagState)
      .values({
        workflowBagId: ev.workflowBagId,
        stage,
        isFinalized,
        lastEventAt: occurredAt,
        updatedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: readBagState.workflowBagId,
        set: {
          stage: sql`CASE WHEN ${newRank} >= ${storedRankSql()} THEN ${stage} ELSE read_bag_state.stage END`,
          isFinalized: sql`read_bag_state.is_finalized OR ${isFinalized}`,
          lastEventAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
  }

  // 3. workflow_bags.finalizedAt + qr_cards release on BAG_FINALIZED.
  if (ev.eventType === "BAG_FINALIZED") {
    await tx
      .update(workflowBags)
      .set({ finalizedAt: occurredAt })
      .where(eq(workflowBags.id, ev.workflowBagId));
    await tx
      .update(qrCards)
      .set({ status: "IDLE", assignedWorkflowBagId: null })
      .where(eq(qrCards.assignedWorkflowBagId, ev.workflowBagId));
  }

  // 4. read_daily_throughput — increment the matching bag-stage counter
  //    for the day this event landed, keyed by (day, product, machine).
  //    Product is pulled from workflow_bags; machine from the station's
  //    machine_id. We only project rows where both are known: nullable
  //    keys break Postgres' UNIQUE-with-NULL semantics (each NULL is
  //    distinct), and a polluted "unknown" bucket would mislead the
  //    floor manager more than skipping early-stage events helps. The
  //    bag picks up its productId on the first stage event anyway.
  const counterCol = THROUGHPUT_COLUMN[ev.eventType];
  if (counterCol && ev.stationId) {
    const [bagRow] = await tx
      .select({ productId: workflowBags.productId })
      .from(workflowBags)
      .where(eq(workflowBags.id, ev.workflowBagId));
    const [stationRow] = await tx
      .select({ machineId: stations.machineId })
      .from(stations)
      .where(eq(stations.id, ev.stationId));
    if (bagRow?.productId && stationRow?.machineId) {
      const day = occurredAt.toISOString().slice(0, 10);
      await tx.execute(sql`
        INSERT INTO read_daily_throughput (day, product_id, machine_id, ${sql.raw(counterCol)}, updated_at)
        VALUES (${day}, ${bagRow.productId}, ${stationRow.machineId}, 1, ${occurredAt})
        ON CONFLICT (day, product_id, machine_id)
        DO UPDATE SET ${sql.raw(counterCol)} = read_daily_throughput.${sql.raw(counterCol)} + 1,
                      updated_at = ${occurredAt}
      `);
    }
  }

  // 4. pg_notify on a single channel — the SSE relay LISTENs on this
  //    channel and pushes a tiny JSON envelope to every connected
  //    client. Payload is intentionally small: clients re-fetch the
  //    affected rows from the read models. Postgres NOTIFY has an 8KB
  //    payload limit, so we never embed the full event here.
  const notifyPayload = {
    eventType: ev.eventType,
    workflowBagId: ev.workflowBagId,
    stationId: ev.stationId ?? null,
    occurredAt: occurredAt.toISOString(),
  };
  await tx.execute(
    sql`SELECT pg_notify('luma_floor', ${JSON.stringify(notifyPayload)})`,
  );
}

const STAGE_RANK: Record<string, number> = {
  STARTED: 1,
  BLISTERED: 2,
  SEALED: 3,
  PACKAGED: 4,
  FINALIZED: 5,
};

function stageRank(stage: string): number {
  return STAGE_RANK[stage] ?? 0;
}

function storedRankSql() {
  return sql`CASE read_bag_state.stage
    WHEN 'STARTED' THEN 1
    WHEN 'BLISTERED' THEN 2
    WHEN 'SEALED' THEN 3
    WHEN 'PACKAGED' THEN 4
    WHEN 'FINALIZED' THEN 5
    ELSE 0
  END`;
}
