// getStationView() — the single tablet read.
//
// Assembles the whole station payload an operator's tablet needs in
// one call: current work from today's tables, and (since Task 7) the
// up-next list from read_bag_queue with an ETA that is either honest or
// absent.
//
// getStationView is deliberately kept to fetching and delegating: this
// repo runs no database in its test suite (vitest.config.ts excludes
// DB access by design; DB behaviour is verified on staging by deploy
// smoke). Every decision lives in the pure functions below —
// mapQueueRowsToUpNext and assembleStationView — which is what the tests
// exercise. `new Date()` appears exactly once, in getStationView; the
// pure side always takes `now` as a parameter.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  machines,
  products,
  purchaseOrders,
  qrCards,
  readBagQueue,
  readBagState,
  readStationLive,
  receives,
  smallBoxes,
  stations,
  tabletTypes,
  workflowBags,
} from "@/lib/db/schema";
import type { RouteOperationView } from "@/lib/production/routes";
import { getActiveStationSession } from "@/lib/production/station-operator-session";
import { buildCurrentBagDisplayLabel } from "@/lib/production/current-bag-display-label";
import { resolveOperation } from "./resolve-operation";
import { resolveCompletionInputs } from "./resolve-completion";
import { etaMinutes, medianCycleMinutes } from "./eta";
import { evaluateChecks, blockersFromChecks, type CheckResult } from "./resolve-exceptions";
import type { CurrentWork, NextAction, StationView, UpNextBag } from "./types";

export type NextActionInput = {
  hasOperatorSession: boolean;
  current: CurrentWork | null;
  operation: RouteOperationView | null;
  checks: CheckResult[];
  bagStage: string | null;
  expected: UpNextBag | null;
};

/** Operator-facing verb for an operation. Never an event name. */
const OPERATION_VERB: Readonly<Record<string, string>> = {
  BLISTER: "Blistering",
  HEAT_SEAL: "Sealing",
  PACKAGING: "Packaging",
  BOTTLE_FILL: "Filling",
  STICKERING: "Stickering",
  INDUCTION_SEAL: "Sealing",
};

export function operationVerb(operationCode: string): string {
  return OPERATION_VERB[operationCode] ?? "Work";
}

/** One read_bag_queue row, reduced to what the up-next list needs. */
export type QueueRowForUpNext = {
  workflowBagId: string;
  bagLabel: string;
  productId: string | null;
  productName: string | null;
  /** READY | UPSTREAM_RUNNING as stored. Anything else is treated as
   *  UPSTREAM_RUNNING — see mapQueueRowsToUpNext. */
  readyState: string;
  upstreamStartedAt: Date | null;
};

/** Pure: queue rows + per-product median cycle time -> the up-next list.
 *
 *  Every up-next decision lives here — ordering, which bags get an ETA,
 *  and what an unknown ready_state means. `now` is a parameter; this
 *  function never reads the clock.
 *
 *  @param medianByProduct product_id -> median minutes for THIS station
 *    kind. Absent key means not enough recent bags to say anything.
 */
export function mapQueueRowsToUpNext(
  rows: readonly QueueRowForUpNext[],
  medianByProduct: ReadonlyMap<string, number>,
  now: Date,
): UpNextBag[] {
  const mapped = rows.map((row) => {
    // Unknown states fail toward UPSTREAM_RUNNING: telling an operator a
    // bag is ready when Luma does not know that is an invitation to walk
    // over and be refused.
    const readyState: UpNextBag["readyState"] =
      row.readyState === "READY" ? "READY" : "UPSTREAM_RUNNING";
    const median = row.productId ? medianByProduct.get(row.productId) ?? null : null;
    return {
      workflowBagId: row.workflowBagId,
      bagLabel: row.bagLabel,
      productName: row.productName,
      readyState,
      // A READY bag is waiting on an operator, not on upstream — an ETA
      // there would read as "not available yet", which is false.
      etaMinutes:
        readyState === "UPSTREAM_RUNNING"
          ? etaMinutes({
              medianMinutes: median,
              upstreamStartedAt: row.upstreamStartedAt,
              now,
            })
          : null,
    };
  });
  // Ready bags first, otherwise the loader's order (ready_at) preserved.
  // Array.prototype.sort is stable per spec, and the input is not touched.
  return mapped.sort(
    (a, b) => Number(b.readyState === "READY") - Number(a.readyState === "READY"),
  );
}

export function buildNextAction(input: NextActionInput): NextAction {
  if (!input.hasOperatorSession) return { kind: "OPEN_SHIFT" };

  if (!input.current) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  const blockers = blockersFromChecks(input.checks);
  if (blockers.length > 0) return { kind: "BLOCKED", blockers };

  if (!input.operation) {
    return { kind: "SCAN_TO_CLAIM", expected: input.expected };
  }

  return {
    kind: "COMPLETE",
    label: `${operationVerb(input.operation.operationCode)} complete`,
    inputs: resolveCompletionInputs(input.operation),
  };
}

/** Recent per-bag cycle times at one station KIND, in minutes, as one
 *  statement. A cycle is a bag's own completion at a station of this kind
 *  minus the moment that station took the bag on:
 *
 *      occurred_at(<X>_COMPLETE) - occurred_at(BAG_PICKED_UP |
 *                                              CARD_ASSIGNED | BAG_CLAIMED)
 *
 *  Scoped to the last 20 bags per product so a product that ran once last
 *  spring cannot anchor today's number, and to 30 days so a station whose
 *  machine was re-tuned is not judged by its old self.
 *
 *  Two deliberate exclusions:
 *    - SEALING_SEGMENT_COMPLETE is a per-lane segment, not the bag
 *      leaving the station; counting it would report a fraction of the
 *      real cycle for every sealing bag.
 *    - Rows with no preceding pickup at this kind are dropped by the
 *      LATERAL join rather than defaulting to zero.
 *
 *  Returns raw samples; medianCycleMinutes decides whether there are
 *  enough of them to say anything at all. */
async function loadMedianCycleMinutesByProduct(
  stationKind: string,
): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    WITH completions AS (
      SELECT
        e.workflow_bag_id,
        b.product_id,
        e.occurred_at AS completed_at,
        row_number() OVER (
          PARTITION BY b.product_id ORDER BY e.occurred_at DESC
        ) AS rn
      FROM workflow_events e
      JOIN stations s ON s.id = e.station_id
      JOIN workflow_bags b ON b.id = e.workflow_bag_id
      WHERE s.kind::text = ${stationKind}
        AND e.event_type::text LIKE '%!_COMPLETE' ESCAPE '!'
        AND e.event_type::text <> 'SEALING_SEGMENT_COMPLETE'
        AND b.product_id IS NOT NULL
        AND e.occurred_at >= now() - interval '30 days'
    )
    SELECT
      c.product_id::text AS product_id,
      EXTRACT(EPOCH FROM (c.completed_at - st.occurred_at))::int AS seconds
    FROM completions c
    JOIN LATERAL (
      SELECT p.occurred_at
      FROM workflow_events p
      JOIN stations ps ON ps.id = p.station_id
      WHERE p.workflow_bag_id = c.workflow_bag_id
        AND ps.kind::text = ${stationKind}
        AND p.event_type::text IN ('BAG_PICKED_UP', 'CARD_ASSIGNED', 'BAG_CLAIMED')
        AND p.occurred_at <= c.completed_at
      ORDER BY p.occurred_at DESC
      LIMIT 1
    ) st ON true
    WHERE c.rn <= 20
  `)) as unknown as Array<{ product_id: string; seconds: number }>;

  const samplesByProduct = new Map<string, number[]>();
  for (const row of rows) {
    if (row.seconds < 0) continue;
    const list = samplesByProduct.get(row.product_id);
    if (list) list.push(row.seconds / 60);
    else samplesByProduct.set(row.product_id, [row.seconds / 60]);
  }

  const medians = new Map<string, number>();
  for (const [productId, samples] of samplesByProduct) {
    const median = medianCycleMinutes(samples);
    if (median != null) medians.set(productId, median);
  }
  return medians;
}

export async function getStationView(stationId: string): Promise<StationView> {
  const [stationRow] = await db
    .select({ station: stations, machine: machines })
    .from(stations)
    .leftJoin(machines, eq(stations.machineId, machines.id))
    .where(eq(stations.id, stationId));
  if (!stationRow) throw new Error("Station not found.");

  const session = await getActiveStationSession(db, stationId);

  // Moved verbatim from app/(floor)/floor/[token]/page.tsx:125-145 — do
  // not redesign the joins or select shape.
  const [currentAtStation] = await db
    .select({
      bag: workflowBags,
      card: qrCards,
      state: readBagState,
      product: products,
      inventoryBagNumber: inventoryBags.bagNumber,
      tabletTypeName: tabletTypes.name,
      poNumber: purchaseOrders.poNumber,
    })
    .from(readStationLive)
    .innerJoin(workflowBags, eq(readStationLive.currentWorkflowBagId, workflowBags.id))
    .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .where(eq(readStationLive.stationId, stationId));

  const resolved = currentAtStation
    ? await resolveOperation({
        productId: currentAtStation.bag.productId,
        stationKind: stationRow.station.kind,
      })
    : null;

  // The five bags this station could take next. Unclaimed only — a bag
  // another station is already holding is not this station's to offer.
  const queueRows = await db
    .select({
      workflowBagId: readBagQueue.workflowBagId,
      bagLabel: readBagQueue.bagLabel,
      productId: readBagQueue.productId,
      productName: readBagQueue.productName,
      readyState: readBagQueue.readyState,
      upstreamStartedAt: readBagQueue.upstreamStartedAt,
    })
    .from(readBagQueue)
    .where(
      and(
        sql`${stationRow.station.kind} = ANY(${readBagQueue.eligibleStationKinds})`,
        isNull(readBagQueue.claimedByStationId),
      ),
    )
    .orderBy(sql`${readBagQueue.readyState} = 'READY' DESC`, readBagQueue.readyAt)
    .limit(5);

  const medianByProduct =
    queueRows.length > 0
      ? await loadMedianCycleMinutesByProduct(stationRow.station.kind)
      : new Map<string, number>();

  const currentBagLabel = currentAtStation
    ? buildCurrentBagDisplayLabel({
        cardLabel: currentAtStation.card?.label ?? null,
        poNumber: currentAtStation.poNumber,
        tabletTypeName: currentAtStation.tabletTypeName,
        productName: currentAtStation.product?.name ?? null,
        inventoryBagNumber: currentAtStation.inventoryBagNumber,
        workflowBagNumber: currentAtStation.bag.bagNumber,
      })
    : null;

  return assembleStationView({
    station: {
      id: stationRow.station.id,
      label: stationRow.station.label,
      kind: stationRow.station.kind,
      machineName: stationRow.machine?.name ?? null,
    },
    session: session
      ? { id: session.id, employeeNameSnapshot: session.employeeNameSnapshot }
      : null,
    current: currentAtStation && currentBagLabel
      ? {
          workflowBagId: currentAtStation.bag.id,
          // buildCurrentBagDisplayLabel returns
          // { primary, secondary, hasReceivedContext } — NOT a string.
          // page.tsx:980-984 renders primary as the heading and secondary
          // as a subline, so both must survive into StationView or the
          // rewire in Task 8 would visibly change the screen.
          bagLabel: currentBagLabel.primary,
          bagSubLabel: currentBagLabel.secondary,
          productName: currentAtStation.product?.name ?? null,
          productId: currentAtStation.bag.productId,
          stage: currentAtStation.state?.stage ?? null,
          isPaused: currentAtStation.state?.isPaused ?? false,
          isFinalized: currentAtStation.state?.isFinalized ?? false,
          isOnHold: currentAtStation.state?.isOnHold ?? false,
        }
      : null,
    operation: resolved?.operation ?? null,
    // The clock enters the engine HERE and nowhere else — every function
    // below this line takes `now` as a parameter.
    upNext: mapQueueRowsToUpNext(queueRows, medianByProduct, new Date()),
  });
}

export type StationViewRows = {
  station: { id: string; label: string; kind: string; machineName: string | null };
  session: { id: string; employeeNameSnapshot: string | null } | null;
  current: {
    workflowBagId: string;
    bagLabel: string;
    bagSubLabel: string | null;
    productName: string | null;
    productId: string | null;
    stage: string | null;
    isPaused: boolean;
    isFinalized: boolean;
    isOnHold: boolean;
  } | null;
  operation: RouteOperationView | null;
  /** Already mapped by mapQueueRowsToUpNext — assembleStationView stays
   *  pure, so the ETA arithmetic (which needs a clock) happens in the
   *  loader, not here. */
  upNext: UpNextBag[];
};

/** Pure: rows in, StationView out. No DB, no clock, no I/O. */
export function assembleStationView(rows: StationViewRows): StationView {
  const current: CurrentWork | null = rows.current
    ? {
        workflowBagId: rows.current.workflowBagId,
        bagLabel: rows.current.bagLabel,
        bagSubLabel: rows.current.bagSubLabel,
        productName: rows.current.productName,
        statusLine: rows.operation
          ? `Ready to ${operationVerb(rows.operation.operationCode).toLowerCase()}`
          : "Waiting",
        progress: null,
      }
    : null;

  const checks = evaluateChecks({
    bagRecognized: rows.current != null,
    productResolved: rows.current?.productId != null,
    operationResolved: rows.operation != null,
    // Phase 1 does not evaluate material availability; resolve-materials
    // lands in Phase 2 with the queue read model.
    materialsAvailable: true,
    upstreamStageComplete: true,
    bagPaused: rows.current?.isPaused ?? false,
    bagFinalized: rows.current?.isFinalized ?? false,
    bagOnHold: rows.current?.isOnHold ?? false,
    waitingForLabel: null,
  });

  return {
    station: rows.station,
    operator: rows.session
      ? {
          sessionId: rows.session.id,
          name: rows.session.employeeNameSnapshot ?? "Operator",
        }
      : null,
    // Supervisor sessions arrive in Phase 5.
    supervisor: null,
    current,
    upNext: rows.upNext,
    nextAction: buildNextAction({
      hasOperatorSession: rows.session != null,
      current,
      operation: rows.operation,
      checks,
      bagStage: rows.current?.stage ?? null,
      // The bag the operator should scan next is the head of the same
      // list the screen shows — never a second, differently-ordered pick.
      expected: rows.upNext[0] ?? null,
    }),
    capabilities: { canPause: current != null, canReportProblem: true },
  };
}
