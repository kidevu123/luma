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

import { eq, sql, and, asc, inArray, desc } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  workflowEvents,
  workflowBags,
  readStationLive,
  readBagState,
  readBagMetrics,
  readDailyThroughput,
  readOperatorDaily,
  stations,
  qrCards,
  inventoryBags,
  products,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { shouldReleaseQrAtFinalization } from "@/lib/production/bag-allocation";
import {
  refreshQueueState,
  QUEUE_REFRESH_EVENTS,
} from "./queue-state";
import { refreshSkuDailyForBag } from "./sku-daily";
import { refreshMaterialReconciliationForBag } from "./material-reconciliation";
import { refreshStationDailyForBag } from "./station-daily";
import { emitMaterialConsumedFromBlister } from "./material-consumption-hook";
import { attributeFinalizedBag } from "./operator-daily-attribution";
import { projectQcEvent, isQcEventType } from "./qc-events";
import { projectFinishedLotForFinalizedBag } from "./finished-lot-passport";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

type WorkflowEventType = typeof workflowEvents.$inferInsert["eventType"];

/** OP-1B: how an accountable employee was identified for a count
 *  submission. Used to band confidence on operator productivity
 *  metrics and audit lineage. */
export type AccountabilitySource =
  | "LOGGED_IN_USER"
  | "EMPLOYEE_PICKER"
  | "EMPLOYEE_CODE"
  | "BADGE_SCAN"
  | "SUPERVISOR_OVERRIDE"
  | "STATION_OPERATOR_SESSION"
  | "LEGACY_TEXT"
  | "MANUAL_TEXT";

type EventInput = {
  workflowBagId: string;
  stationId?: string | null;
  eventType: WorkflowEventType;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
  /** Floor-side idempotency key. If a duplicate insert hits the
   *  partial unique (workflow_bag_id, event_type, client_event_id)
   *  index we swallow the conflict — the action becomes a no-op
   *  on retry instead of double-firing the stage. */
  clientEventId?: string | null;
  /** OP-1B accountability — additive, optional, fully backwards
   *  compatible. enteredByUserId / accountableEmployeeId land in
   *  the corresponding workflow_events FK columns. accountability
   *  source + name snapshot are merged into payload so audit
   *  consumers can read them without a second join. */
  enteredByUserId?: string | null;
  accountableEmployeeId?: string | null;
  accountabilitySource?: AccountabilitySource | null;
  accountableEmployeeNameSnapshot?: string | null;
};

const STAGE_FOR_EVENT: Record<string, string> = {
  CARD_ASSIGNED: "STARTED",
  BLISTER_COMPLETE: "BLISTERED",
  HANDPACK_BLISTER_COMPLETE: "BLISTERED",
  SEALING_COMPLETE: "SEALED",
  PACKAGING_SNAPSHOT: "PACKAGED",
  PACKAGING_COMPLETE: "PACKAGED", // rich-payload variant of SNAPSHOT
  BOTTLE_HANDPACK_COMPLETE: "BLISTERED",
  BOTTLE_CAP_SEAL_COMPLETE: "SEALED",
  BOTTLE_STICKER_COMPLETE: "PACKAGED",
  BAG_FINALIZED: "FINALIZED",
};

/** Which read_daily_throughput counter to increment for each event.
 *  CARD_ASSIGNED is intentionally skipped. PACKAGING_COMPLETE counts
 *  toward bags_packaged exactly like SNAPSHOT does. */
const THROUGHPUT_COLUMN: Record<string, string> = {
  BLISTER_COMPLETE: "bags_blistered",
  HANDPACK_BLISTER_COMPLETE: "bags_blistered",
  BOTTLE_HANDPACK_COMPLETE: "bags_blistered",
  SEALING_COMPLETE: "bags_sealed",
  BOTTLE_CAP_SEAL_COMPLETE: "bags_sealed",
  PACKAGING_SNAPSHOT: "bags_packaged",
  PACKAGING_COMPLETE: "bags_packaged",
  BOTTLE_STICKER_COMPLETE: "bags_packaged",
  BAG_FINALIZED: "bags_finalized",
};

/** Insert a workflow_event AND update the live read models in one
 *  transaction. Always use this — never insert into workflow_events
 *  directly from a route. */
export async function projectEvent(tx: Tx, ev: EventInput): Promise<void> {
  const occurredAt = ev.occurredAt ?? new Date();

  // Merge OP-1B accountability metadata into payload alongside any
  // caller-supplied fields. The FK columns get the stable IDs; the
  // payload carries the source label + readable name snapshot so
  // genealogy / audit can render without a second join.
  const basePayload = ev.payload ?? {};
  const accountabilityPayload: Record<string, unknown> = {};
  if (ev.accountabilitySource) {
    accountabilityPayload.accountability_source = ev.accountabilitySource;
  }
  if (ev.accountableEmployeeNameSnapshot) {
    accountabilityPayload.accountable_employee_name_snapshot =
      ev.accountableEmployeeNameSnapshot;
  }
  const mergedPayload =
    Object.keys(accountabilityPayload).length > 0
      ? { ...basePayload, ...accountabilityPayload }
      : basePayload;

  // Idempotency: if the floor sent a clientEventId, the partial
  // unique index (workflow_bag_id, event_type, client_event_id)
  // catches retries. onConflictDoNothing → empty RETURNING means
  // a previous attempt already landed; bail before touching read
  // models so we don't double-count throughput / station_live.
  const inserted = await tx
    .insert(workflowEvents)
    .values({
      workflowBagId: ev.workflowBagId,
      stationId: ev.stationId ?? null,
      eventType: ev.eventType,
      payload: mergedPayload,
      occurredAt,
      clientEventId: ev.clientEventId ?? null,
      employeeId: ev.accountableEmployeeId ?? null,
      userId: ev.enteredByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: workflowEvents.id });
  if (inserted.length === 0) return;

  // 1. read_station_live — track which bag is "currently at" each
  //    station. Three classes of event affect this read model:
  //
  //    a. Forward stage events with a stationId (and not BAG_FINALIZED
  //       and not BAG_RELEASED) keep the station pinned to the bag.
  //
  //    b. BAG_RELEASED clears THIS station's slot only. The bag is
  //       still alive and the QR card is still ASSIGNED to it; the
  //       next station picks it up by scanning the card (which fires
  //       BAG_PICKED_UP).
  //
  //    c. BAG_FINALIZED clears EVERY station's slot for this bag and
  //       returns the QR card to IDLE. End of cycle.
  if (
    ev.stationId &&
    ev.eventType !== "BAG_FINALIZED" &&
    ev.eventType !== "BAG_RELEASED"
  ) {
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
  } else if (ev.eventType === "BAG_RELEASED" && ev.stationId) {
    // Release THIS station's slot, leave others alone (they shouldn't
    // hold this bag anyway in the single-station-at-a-time model, but
    // be defensive: only touch the firing station).
    await tx
      .update(readStationLive)
      .set({
        currentWorkflowBagId: null,
        lastEventType: "BAG_RELEASED",
        lastEventAt: occurredAt,
        updatedAt: occurredAt,
      })
      .where(
        and(
          eq(readStationLive.stationId, ev.stationId),
          eq(readStationLive.currentWorkflowBagId, ev.workflowBagId),
        ),
      );
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
  //    event lands after a later one. Also denormalize productId /
  //    productName / inventoryBagBatchId / receiptNumber off the
  //    bag's workflowBags row so every consumer of read_bag_state
  //    has display-ready columns without an extra join.
  const stage = STAGE_FOR_EVENT[ev.eventType];
  if (stage) {
    const isFinalized = ev.eventType === "BAG_FINALIZED";
    const newRank = stageRank(stage);
    // Pull denormalized columns once. workflowBags.productId might
    // be null on the very first stage event but will be set by a
    // PRODUCT_MAPPED event downstream — the upsert COALESCEs so we
    // don't clobber a previously-set value with null.
    const [bagRow] = await tx
      .select({
        productId: workflowBags.productId,
        receiptNumber: workflowBags.receiptNumber,
        inventoryBagId: workflowBags.inventoryBagId,
      })
      .from(workflowBags)
      .where(eq(workflowBags.id, ev.workflowBagId));
    let productName: string | null = null;
    let inventoryBagBatchId: string | null = null;
    if (bagRow?.productId) {
      const [p] = await tx
        .select({ name: products.name })
        .from(products)
        .where(eq(products.id, bagRow.productId));
      productName = p?.name ?? null;
    }
    if (bagRow?.inventoryBagId) {
      const [b] = await tx
        .select({ batchId: inventoryBags.batchId })
        .from(inventoryBags)
        .where(eq(inventoryBags.id, bagRow.inventoryBagId));
      inventoryBagBatchId = b?.batchId ?? null;
    }
    await tx
      .insert(readBagState)
      .values({
        workflowBagId: ev.workflowBagId,
        stage,
        productId: bagRow?.productId ?? null,
        productName,
        inventoryBagBatchId,
        receiptNumber: bagRow?.receiptNumber ?? null,
        isFinalized,
        lastEventAt: occurredAt,
        updatedAt: occurredAt,
      })
      .onConflictDoUpdate({
        target: readBagState.workflowBagId,
        set: {
          stage: sql`CASE WHEN ${newRank} >= ${storedRankSql()} THEN ${stage} ELSE read_bag_state.stage END`,
          // COALESCE keeps the first non-null value — late-arriving
          // PRODUCT_MAPPED won't wipe earlier-set columns; first
          // PRODUCT_MAPPED also fills any prior null.
          productId: sql`COALESCE(read_bag_state.product_id, ${bagRow?.productId ?? null})`,
          productName: sql`COALESCE(read_bag_state.product_name, ${productName})`,
          inventoryBagBatchId: sql`COALESCE(read_bag_state.inventory_bag_batch_id, ${inventoryBagBatchId})`,
          receiptNumber: sql`COALESCE(read_bag_state.receipt_number, ${bagRow?.receiptNumber ?? null})`,
          isFinalized: sql`read_bag_state.is_finalized OR ${isFinalized}`,
          lastEventAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
  }

  // 2b. Pause / resume — flip is_paused on read_bag_state and
  //     accumulate paused_seconds on resume. While paused, cycle-time
  //     math should treat (now - paused_at) as time NOT counted.
  if (ev.eventType === "BAG_PAUSED") {
    await tx
      .update(readBagState)
      .set({ isPaused: true, pausedAt: occurredAt, updatedAt: occurredAt })
      .where(eq(readBagState.workflowBagId, ev.workflowBagId));
  } else if (ev.eventType === "BAG_RESUMED") {
    const [bs] = await tx
      .select({ pausedAt: readBagState.pausedAt, accum: readBagState.pausedSecondsAccum })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, ev.workflowBagId));
    if (bs?.pausedAt) {
      const delta = Math.floor(
        (occurredAt.getTime() - new Date(bs.pausedAt as unknown as string).getTime()) / 1000,
      );
      await tx
        .update(readBagState)
        .set({
          isPaused: false,
          pausedAt: null,
          pausedSecondsAccum: (bs.accum ?? 0) + Math.max(0, delta),
          updatedAt: occurredAt,
        })
        .where(eq(readBagState.workflowBagId, ev.workflowBagId));
    }
  } else if (ev.eventType === "OPERATOR_CHANGE") {
    const code = String(ev.payload?.operator_code ?? "").trim();
    if (code) {
      await tx
        .update(readBagState)
        .set({ currentOperatorCode: code, updatedAt: occurredAt })
        .where(eq(readBagState.workflowBagId, ev.workflowBagId));
    }
  }

  // 3. workflow_bags.finalizedAt + qr_cards release on BAG_FINALIZED +
  //    snapshot read_bag_metrics + bump read_operator_daily.
  if (ev.eventType === "BAG_FINALIZED") {
    await tx
      .update(workflowBags)
      .set({ finalizedAt: occurredAt })
      .where(eq(workflowBags.id, ev.workflowBagId));

    // Check the most-recent allocation session for this workflow_bag.
    // Only release the QR if the bag is confirmed empty; hold it for partial bags.
    const [wfSession] = await tx
      .select({
        allocationStatus: rawBagAllocationSessions.allocationStatus,
        endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      })
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.workflowBagId, ev.workflowBagId))
      .orderBy(desc(rawBagAllocationSessions.openedAt))
      .limit(1);

    if (shouldReleaseQrAtFinalization(wfSession ?? null)) {
      await tx
        .update(qrCards)
        .set({ status: "IDLE", assignedWorkflowBagId: null })
        .where(eq(qrCards.assignedWorkflowBagId, ev.workflowBagId));
    }
    // else: QR remains ASSIGNED to the finalized bag; resumable via scanCardAction.

    await projectMetricsForFinalizedBag(tx, ev.workflowBagId, occurredAt);
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
      const occurredAtIso = occurredAt.toISOString();
      // postgres-js's Bind step rejects bare JS Date instances — pin
      // the timestamp through ::timestamptz so the driver only sees a
      // string at parameter time. Same Bind crash class that hit
      // floor-board / metrics earlier; fixing here pre-empts the next
      // BAG_FINALIZED action throw post-legacy-import.
      await tx.execute(sql`
        INSERT INTO read_daily_throughput (day, product_id, machine_id, ${sql.raw(counterCol)}, updated_at)
        VALUES (${day}, ${bagRow.productId}, ${stationRow.machineId}, 1, ${occurredAtIso}::timestamptz)
        ON CONFLICT (day, product_id, machine_id)
        DO UPDATE SET ${sql.raw(counterCol)} = read_daily_throughput.${sql.raw(counterCol)} + 1,
                      updated_at = ${occurredAtIso}::timestamptz
      `);
    }
  }

  // ── Phase C read-model extensions ─────────────────────────────
  // read_queue_state — refresh the per-stage queue snapshot any
  // time a bag's stage might change. Cheap (small WIP), worth it
  // to keep the floor board in lock-step.
  if (QUEUE_REFRESH_EVENTS.has(ev.eventType)) {
    await refreshQueueState(tx);
  }
  // At BAG_FINALIZED time, populate the per-bag SKU rollup, the
  // material reconciliation row, and the per-(day, machine, product)
  // quality rollup. All three operate off read_bag_metrics which
  // projectMetricsForFinalizedBag has already written above.
  if (ev.eventType === "BAG_FINALIZED") {
    await refreshSkuDailyForBag(tx, ev.workflowBagId);
    await refreshMaterialReconciliationForBag(tx, ev.workflowBagId);
    await refreshStationDailyForBag(tx, ev.workflowBagId);
    // LOT-1C — enrich the recall passport when a finished_lots row
    // already names this workflow_bag. No-op when the operator hasn't
    // created the finished_lots row yet — createFinishedLot() invokes
    // the same projector at insert time.
    await projectFinishedLotForFinalizedBag(tx, ev.workflowBagId, occurredAt);
  }

  // QC-5: project QC events into per-day rollups (operator, SKU,
  // station-quality) and bag-state flags. Lives in a sibling module
  // so the dispatch stays out of this already-large file.
  if (isQcEventType(ev.eventType)) {
    await projectQcEvent(tx, {
      workflowBagId: ev.workflowBagId,
      eventType: ev.eventType as Parameters<typeof projectQcEvent>[1]["eventType"],
      occurredAt,
      employeeId: ev.accountableEmployeeId ?? null,
      stationId: ev.stationId ?? null,
      payload: mergedPayload as Record<string, unknown>,
    });
  }

  // Phase H.x3 — When a BLISTER_COMPLETE event lands and an active
  // PVC/foil roll is mounted on the station's machine, emit a
  // MATERIAL_CONSUMED_ESTIMATED row per role using the configured-
  // or-learned standard. The hook is silent when any required
  // input (counter, mounted roll, standard) is missing — the UI
  // surfaces the gap via the metric API, the projector never
  // fabricates a number.
  if (ev.eventType === "BLISTER_COMPLETE" && ev.stationId) {
    await emitMaterialConsumedFromBlister(tx, {
      workflowBagId: ev.workflowBagId,
      stationId: ev.stationId,
      payload: ev.payload ?? {},
      occurredAt,
      upstreamClientEventId: ev.clientEventId ?? null,
    });
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

/** Walk every workflow_event for a bag and snapshot a per-bag
 *  metrics row. Called once at BAG_FINALIZED time so reports never
 *  have to aggregate over the raw event stream.
 *
 *  Per-stage seconds are computed as gap-between-prior-complete-event
 *  (started_at counts as the implicit "stage 0 complete"). Pause
 *  duration is the sum of (RESUMED.occurredAt - PAUSED.occurredAt)
 *  pairs. active_seconds = total - paused. Yield, when computable
 *  from inputPillCount + product spec, lands as a percentage. */
async function projectMetricsForFinalizedBag(
  tx: Tx,
  bagId: string,
  finalizedAt: Date,
): Promise<void> {
  const [bag] = await tx.select().from(workflowBags).where(eq(workflowBags.id, bagId));
  if (!bag) return;

  const events = await tx
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, bagId))
    .orderBy(asc(workflowEvents.occurredAt));

  const startedAt = bag.startedAt as unknown as Date;
  const totalSeconds = Math.max(
    0,
    Math.floor((finalizedAt.getTime() - startedAt.getTime()) / 1000),
  );

  // Pause durations: walk PAUSED→RESUMED pairs in order.
  let pausedSeconds = 0;
  let pendingPausedAt: number | null = null;
  for (const e of events) {
    const t = (e.occurredAt as unknown as Date).getTime();
    if (e.eventType === "BAG_PAUSED") pendingPausedAt = t;
    else if (e.eventType === "BAG_RESUMED" && pendingPausedAt !== null) {
      pausedSeconds += Math.max(0, Math.floor((t - pendingPausedAt) / 1000));
      pendingPausedAt = null;
    }
  }
  // If still paused at finalize (edge case), close the open pause.
  if (pendingPausedAt !== null) {
    pausedSeconds += Math.max(
      0,
      Math.floor((finalizedAt.getTime() - pendingPausedAt) / 1000),
    );
  }
  const activeSeconds = Math.max(0, totalSeconds - pausedSeconds);

  // Per-stage seconds = gap between this stage's _COMPLETE and the
  // previous stage's _COMPLETE (or bag.startedAt for the first).
  const stageBoundaries: Array<{ key: string; at: number }> = [
    { key: "_start", at: startedAt.getTime() },
  ];
  for (const e of events) {
    if (
      e.eventType === "BLISTER_COMPLETE" ||
      e.eventType === "SEALING_COMPLETE" ||
      e.eventType === "PACKAGING_SNAPSHOT" ||
      e.eventType === "PACKAGING_COMPLETE" ||
      e.eventType === "BOTTLE_HANDPACK_COMPLETE" ||
      e.eventType === "BOTTLE_CAP_SEAL_COMPLETE" ||
      e.eventType === "BOTTLE_STICKER_COMPLETE"
    ) {
      stageBoundaries.push({
        key: e.eventType,
        at: (e.occurredAt as unknown as Date).getTime(),
      });
    }
  }
  function gap(toKey: string): number | null {
    // findLastIndex — if the same _COMPLETE event fires twice
    // (operator correction), use the most recent occurrence so the
    // gap reflects the actual time spent at this stage including
    // any rework loop.
    let idx = -1;
    for (let i = stageBoundaries.length - 1; i >= 0; i--) {
      if (stageBoundaries[i]?.key === toKey) {
        idx = i;
        break;
      }
    }
    if (idx <= 0) return null;
    const prev = stageBoundaries[idx - 1];
    const cur = stageBoundaries[idx];
    if (!prev || !cur) return null;
    return Math.max(0, Math.floor((cur.at - prev.at) / 1000));
  }
  const blisterSeconds = gap("BLISTER_COMPLETE");
  const sealingSeconds = gap("SEALING_COMPLETE");
  const packagingSeconds =
    gap("PACKAGING_COMPLETE") ?? gap("PACKAGING_SNAPSHOT");
  const bottleHandpackSeconds = gap("BOTTLE_HANDPACK_COMPLETE");
  const bottleCapSealSeconds = gap("BOTTLE_CAP_SEAL_COMPLETE");
  const bottleStickerSeconds = gap("BOTTLE_STICKER_COMPLETE");

  // Pull packaging counts off the most recent PACKAGING_COMPLETE
  // event's payload (if present); fall back to the legacy
  // PACKAGING_SNAPSHOT.count_total when only that event fired.
  let masterCases = 0,
    displaysMade = 0,
    looseCards = 0,
    damagedPackaging = 0,
    rippedCards = 0;
  const packagingCompleteEv = [...events]
    .reverse()
    .find((e) => e.eventType === "PACKAGING_COMPLETE");
  if (packagingCompleteEv) {
    const p = (packagingCompleteEv.payload ?? {}) as Record<string, unknown>;
    masterCases = Number(p.master_cases ?? 0) || 0;
    displaysMade = Number(p.displays_made ?? 0) || 0;
    looseCards = Number(p.loose_cards ?? 0) || 0;
    damagedPackaging = Number(p.damaged_packaging ?? 0) || 0;
    rippedCards = Number(p.ripped_cards ?? 0) || 0;
  } else {
    const snapshot = [...events]
      .reverse()
      .find((e) => e.eventType === "PACKAGING_SNAPSHOT");
    if (snapshot) {
      const p = (snapshot.payload ?? {}) as Record<string, unknown>;
      looseCards = Number(p.count_total ?? 0) || 0;
    }
  }

  // Resolve the product so we can derive units/yield. workflow_bags
  // sets productId once per bag; any stage event can populate it
  // (PRODUCT_MAPPED). The bag row above is the source of truth.
  let unitsYielded = 0;
  let yieldPctText: string | null = null;
  let inputPillCount: number | null = null;
  if (bag.productId) {
    const [product] = await tx
      .select({
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
      })
      .from(products)
      .where(eq(products.id, bag.productId));
    if (product?.unitsPerDisplay && product.displaysPerCase) {
      const cardsPerCase = product.unitsPerDisplay * product.displaysPerCase;
      unitsYielded =
        masterCases * cardsPerCase +
        displaysMade * product.unitsPerDisplay +
        looseCards;
    } else {
      unitsYielded = looseCards;
    }
  }
  if (bag.inventoryBagId) {
    const [invBag] = await tx
      .select({ pillCount: inventoryBags.pillCount })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, bag.inventoryBagId));
    if (invBag?.pillCount) {
      inputPillCount = invBag.pillCount;
      if (inputPillCount > 0) {
        yieldPctText = ((unitsYielded / inputPillCount) * 100).toFixed(3);
      }
    }
  }

  // Operator codes seen + machines that touched this bag.
  const operatorCodes = Array.from(
    new Set(
      events
        .map((e) => {
          const p = (e.payload ?? {}) as Record<string, unknown>;
          const c = String(p.operator_code ?? "").trim();
          return c;
        })
        .filter((c) => c !== ""),
    ),
  );
  const stationIds = Array.from(
    new Set(events.map((e) => e.stationId).filter((s): s is string => !!s)),
  );
  let machineIds: string[] = [];
  if (stationIds.length > 0) {
    // Drizzle's inArray handles both single- and multi-element JS
    // arrays cleanly. The previous `${arr}::uuid[]` cast pattern
    // failed under postgres-js when the array had only one element
    // because the driver bound it as a scalar text param.
    const stationRows = await tx
      .select({ machineId: stations.machineId })
      .from(stations)
      .where(inArray(stations.id, stationIds));
    machineIds = Array.from(
      new Set(
        stationRows.map((r) => r.machineId).filter((m): m is string => !!m),
      ),
    );
  }

  // Idempotent upsert — finalize is at-most-once via the partial
  // unique index on workflow_events, so this is the only chance we
  // get to write metrics for a given bag.
  await tx
    .insert(readBagMetrics)
    .values({
      workflowBagId: bagId,
      productId: bag.productId,
      startedAt,
      finalizedAt,
      totalSeconds,
      pausedSeconds,
      activeSeconds,
      blisterSeconds: blisterSeconds ?? null,
      sealingSeconds: sealingSeconds ?? null,
      packagingSeconds: packagingSeconds ?? null,
      bottleHandpackSeconds: bottleHandpackSeconds ?? null,
      bottleCapSealSeconds: bottleCapSealSeconds ?? null,
      bottleStickerSeconds: bottleStickerSeconds ?? null,
      staging1Seconds: null,
      staging2Seconds: null,
      masterCases,
      displaysMade,
      looseCards,
      damagedPackaging,
      rippedCards,
      inputPillCount,
      unitsYielded,
      yieldPct: yieldPctText,
      operatorCodes,
      machineIds,
    })
    .onConflictDoNothing({ target: readBagMetrics.workflowBagId });

  // Per-(day, operator) rollup for the leaderboard. OP-1E: prefers
  // stable employee_id when accountability landed on the events;
  // falls back to free-text operator_code only for legacy bags whose
  // events never carried an employee_id. The pure helper enforces
  // "no double-counting": a code that travelled with an employee
  // tags the employee row, never produces a separate code-only row.
  const attribution = attributeFinalizedBag(
    events.map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return {
        employeeId: e.employeeId ?? null,
        operatorCode: typeof p.operator_code === "string" ? p.operator_code : null,
      };
    }),
  );
  const damageCount = damagedPackaging + rippedCards;
  if (attribution.employees.size > 0 || attribution.codeOnly.size > 0) {
    const day = finalizedAt.toISOString().slice(0, 10);
    const finalizedAtIso = finalizedAt.toISOString();
    // Employee-keyed rows. ON CONFLICT targets the partial unique on
    // (day, employee_id) WHERE employee_id IS NOT NULL.
    for (const [employeeId, info] of attribution.employees) {
      await tx.execute(sql`
        INSERT INTO read_operator_daily (
          day, employee_id, operator_code, bags_finalized,
          active_seconds_total, damage_count_total, updated_at
        )
        VALUES (
          ${day}, ${employeeId}::uuid, ${info.operatorCode}, 1,
          ${activeSeconds}, ${damageCount}, ${finalizedAtIso}::timestamptz
        )
        ON CONFLICT (day, employee_id)
        WHERE employee_id IS NOT NULL
        DO UPDATE SET
          bags_finalized = read_operator_daily.bags_finalized + 1,
          active_seconds_total = read_operator_daily.active_seconds_total + ${activeSeconds},
          damage_count_total = read_operator_daily.damage_count_total + ${damageCount},
          operator_code = COALESCE(read_operator_daily.operator_code, EXCLUDED.operator_code),
          updated_at = ${finalizedAtIso}::timestamptz
      `);
    }
    // Legacy code-only rows. ON CONFLICT targets the partial unique on
    // (day, operator_code) WHERE employee_id IS NULL AND
    // operator_code IS NOT NULL. These rows render as LOW confidence
    // downstream so the operator-productivity surface can flag them.
    for (const code of attribution.codeOnly) {
      await tx.execute(sql`
        INSERT INTO read_operator_daily (
          day, employee_id, operator_code, bags_finalized,
          active_seconds_total, damage_count_total, updated_at
        )
        VALUES (
          ${day}, NULL, ${code}, 1,
          ${activeSeconds}, ${damageCount}, ${finalizedAtIso}::timestamptz
        )
        ON CONFLICT (day, operator_code)
        WHERE employee_id IS NULL AND operator_code IS NOT NULL
        DO UPDATE SET
          bags_finalized = read_operator_daily.bags_finalized + 1,
          active_seconds_total = read_operator_daily.active_seconds_total + ${activeSeconds},
          damage_count_total = read_operator_daily.damage_count_total + ${damageCount},
          updated_at = ${finalizedAtIso}::timestamptz
      `);
    }
  }
}
