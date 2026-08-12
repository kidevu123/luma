// Moved verbatim from app/(floor)/floor/[token]/actions.ts
// (fireStageEventAction, guard sequence + transaction body).
//
// This is a pure relocation. Do not change behaviour, ordering, error
// strings, or payload shapes — the parity gate in Task 8 depends on
// this being bit-identical.
//
// actions.ts is a "use server" module, so every export there must be an
// async server action. The shared implementation therefore cannot live
// in it; the action now calls into this module and keeps only the
// FormData parse, authStation, and the trailing revalidatePath() calls
// (Next.js concerns, not domain logic).

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  machines,
  readBagState,
  readStationLive,
  stations,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { projectEvent } from "@/lib/projector";
import { refreshMaterialReadModelsAfterConsumption } from "@/lib/projector/material-read-model-refresh";
import {
  STATION_RELEASE_FROM_STAGE,
  isBottleFinishingEvent,
  bottleFinishingAlreadyFired,
} from "@/lib/production/stage-progression";
import { checkStageProgression } from "@/lib/production/stage-progression";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  computeSealedCountFromCounter,
  resolveSealingCardsPerPress,
  SEALING_COUNTER_CONFIG_ERROR,
  SEALING_COUNTER_PRESS_ERROR,
  stationUsesSealingCounter,
} from "@/lib/production/sealing-counter";
import { SEALING_SEGMENT_EVENT } from "@/lib/production/sealing-segments";
import {
  SEALING_PARTIAL_CLOSE_REASONS,
  buildPartialSealingClosePayload,
  hasPartialSealingCloseout,
  validateSealingPartialCloseInput,
} from "@/lib/production/sealing-partial-closeout";
import {
  SEALING_STATION_KINDS,
  SEALING_PRODUCT_ALREADY_SAVED_ERROR,
  SEALING_SAVE_PRODUCT_FIRST_ERROR,
} from "@/lib/production/sealing-product";
import {
  lookupProductMatchedBlisterCardLot,
  issueHandpackBlisterCardMaterial,
  emitHandpackBlisterEstimatedMaterial,
  workflowBagHasHandpackBlisterComplete,
  type HandpackBlisterMaterialSkipReason,
} from "@/lib/production/handpack-seal-material";
import { resolveWorkflowBagReceivedTabletContext } from "@/lib/production/workflow-bag-tablet-context";
import { isBlisterCounterSnapshotStation } from "@/lib/production/blister-counter-snapshot";
import { assertCounterSnapshotAllowed } from "@/lib/production/counter-snapshot-guard-loader";

export type StationRow = typeof stations.$inferSelect;

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The action used to hand projectEvent a zod-enum-narrowed eventType.
// RecordStageEventInput takes a plain string (the engine builds it from
// an operation code), so the narrowing happens at the projectEvent call
// instead. ALLOWED_EVENTS_BY_KIND already rejects anything that is not
// one of those enum members, so this is a type-level cast only.
type WorkflowEventType = (typeof workflowEvents.$inferInsert)["eventType"];

type StationAccountability = Awaited<
  ReturnType<typeof resolveStationAccountability>
>;

// First-op count submissions where accountability is mandatory (the
// queue stop condition: refuse a fresh blister/handpack count when
// nobody owns it). All other events soft-fall-through.
const FIRST_OP_COUNT_EVENTS: ReadonlySet<string> = new Set([
  "BLISTER_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
]);

// Allowed event types per station kind. SEALING can't fire blister,
// PACKAGING can't fire bottle stages, etc. COMBINED is permissive
// (still card flow only).
const ALLOWED_EVENTS_BY_KIND: Record<string, string[]> = {
  BLISTER: ["BLISTER_COMPLETE"],
  HANDPACK_BLISTER: ["HANDPACK_BLISTER_COMPLETE"],
  SEALING: ["SEALING_SEGMENT_COMPLETE", "SEALING_COMPLETE"],
  PACKAGING: ["PACKAGING_SNAPSHOT", "PACKAGING_COMPLETE"],
  BOTTLE_HANDPACK: ["BOTTLE_HANDPACK_COMPLETE"],
  BOTTLE_CAP_SEAL: ["BOTTLE_CAP_SEAL_COMPLETE"],
  BOTTLE_STICKER: ["BOTTLE_STICKER_COMPLETE"],
  COMBINED: [
    "BLISTER_COMPLETE",
    "SEALING_SEGMENT_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "PACKAGING_COMPLETE",
  ],
};

export type RecordStageEventInput = {
  station: StationRow;
  workflowBagId: string;
  eventType: string;
  countTotal: number;
  counterPresses?: number | undefined;
  packsRemaining: number;
  cardsReopened: number;
  clientEventId?: string | undefined;
  overrideEmployeeCode?: string | undefined;
  pickedSealingProductId: string | null;
  sealingCloseMode?: string | undefined;
  partialCloseReason?: string | undefined;
  partialCloseReasonNote?: string | undefined;
};

/** Record one stage event: the guard sequence and transaction moved out of
 *  fireStageEventAction.
 *
 *  PRECONDITION — callers MUST have authenticated the station first. This
 *  function performs NO station auth of its own: it trusts `input.station`
 *  and derives `stationId` from `station.id`. On the floor path that
 *  guarantee comes from `authStation(token, stationId)`, which validates the
 *  URL scan token, refuses a station/form mismatch, and rejects inactive
 *  stations. Any new caller (Phase 2 onward) must establish the same
 *  guarantee before calling — do not expose this over an unauthenticated
 *  route. */
export async function recordStageEvent(
  input: RecordStageEventInput,
): Promise<{ ok: true } | { error: string }> {
  const {
    station,
    workflowBagId,
    eventType,
    countTotal,
    counterPresses,
    packsRemaining,
    cardsReopened,
    clientEventId,
    overrideEmployeeCode,
    pickedSealingProductId,
  } = input;
  // authStation guarantees station.id === the stationId the form
  // targeted, so this is the same value the action used.
  const stationId = station.id;

  try {
    // Wrong-stage guard: each station kind maps to a fixed set of
    // allowed events. Stops a SEALING station from firing
    // BLISTER_COMPLETE if someone hand-crafts FormData.
    const allowed = ALLOWED_EVENTS_BY_KIND[station.kind] ?? [];
    if (!allowed.includes(eventType)) {
      return {
        error: `Station kind ${station.kind} can't fire ${eventType}.`,
      };
    }
    // Refuse if the bag is currently paused — operator must Resume
    // first. Stops phantom completes on a paused bag.
    const [state] = await db
      .select({
        isPaused: readBagState.isPaused,
        isFinalized: readBagState.isFinalized,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    // Stage-progression guard: this is what stops a duplicate
    // BLISTER_COMPLETE landing on the same bag from a stale-looking
    // screen. The bag must be at the predecessor stage. Same helper
    // is consumed by the floor UI so server + client stay in sync.
    const progression = checkStageProgression({
      eventType,
      currentStage: state?.stage ?? null,
      isPaused: state?.isPaused ?? false,
      isFinalized: state?.isFinalized ?? false,
    });
    if (!progression.allowed) {
      return { error: progression.reason };
    }

    // BOTTLE-ORDER-FLEX-1: cap-seal and sticker run in either order and
    // both accept a bag at SEALED, so the stage prereq alone would let an
    // operator fire the SAME finishing step twice. Reject a duplicate of a
    // finishing step that already ran on this bag — each runs exactly once.
    if (isBottleFinishingEvent(eventType)) {
      const priorTypes = (
        await db
          .select({ eventType: workflowEvents.eventType })
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowBagId, workflowBagId))
      ).map((r) => r.eventType);
      if (bottleFinishingAlreadyFired(eventType, priorTypes)) {
        return {
          error:
            eventType === "BOTTLE_CAP_SEAL_COMPLETE"
              ? "This bag has already been cap-sealed."
              : "This bag has already been stickered.",
        };
      }
    }

    const isSealingSegment = eventType === SEALING_SEGMENT_EVENT;
    const isSealingFinal = eventType === "SEALING_COMPLETE";
    const isPureSealingStation = station.kind === "SEALING";

    const sealingCloseMode = input.sealingCloseMode ?? "whole";
    const isPartialSealingClose =
      isSealingFinal && isPureSealingStation && sealingCloseMode === "partial";
    /** Pure SEALING station final close (whole or partial) uses segment totals, not counter. */
    const sealingFinalOnPureStation =
      isSealingFinal && isPureSealingStation;
    const sealingFinalCloseOnly =
      sealingFinalOnPureStation && !isPartialSealingClose;
    let partialCloseReady: {
      sealedPartialCount: number;
      reason: (typeof SEALING_PARTIAL_CLOSE_REASONS)[number];
    } | null = null;

    if (isSealingFinal && isPureSealingStation) {
      const priorEvents = await db
        .select({
          eventType: workflowEvents.eventType,
          payload: workflowEvents.payload,
        })
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowBagId, workflowBagId));

      if (isPartialSealingClose) {
        const partialValidation = validateSealingPartialCloseInput({
          events: priorEvents.map((row) => ({
            eventType: row.eventType,
            payload: (row.payload as Record<string, unknown> | null) ?? null,
          })),
          reason: input.partialCloseReason ?? null,
          reasonNote: input.partialCloseReasonNote ?? null,
        });
        if (!partialValidation.ok) {
          return { error: partialValidation.error };
        }
        partialCloseReady = {
          sealedPartialCount: partialValidation.sealedPartialCount,
          reason: partialValidation.reason,
        };
      } else {
        if (hasPartialSealingCloseout(
          priorEvents.map((row) => ({
            eventType: row.eventType,
            payload: (row.payload as Record<string, unknown> | null) ?? null,
          })),
        )) {
          return {
            error:
              "This bag already has a partial sealing close-out. Finish packaging before starting another sealing close-out.",
          };
        }
        const segmentCount = priorEvents.filter(
          (row) => row.eventType === SEALING_SEGMENT_EVENT,
        ).length;
        if (segmentCount < 1) {
          return {
            error:
              "Record at least one sealing segment before marking sealing complete.",
          };
        }
      }
    }

    let resolvedCountTotal = countTotal;
    let sealingCounterPresses: number | undefined;
    let sealingCardsPerPress: number | undefined;

    const sealingUsesCounter =
      (isSealingSegment || isSealingFinal) &&
      stationUsesSealingCounter(station.kind);

    if (sealingUsesCounter && !sealingFinalOnPureStation) {
      if (counterPresses === undefined) {
        return { error: SEALING_COUNTER_PRESS_ERROR };
      }
      let machineRow: { cardsPerTurn: number } | null = null;
      if (station.machineId) {
        const [row] = await db
          .select({ cardsPerTurn: machines.cardsPerTurn })
          .from(machines)
          .where(eq(machines.id, station.machineId))
          .limit(1);
        machineRow = row ?? null;
      }
      const cardsPerPress = resolveSealingCardsPerPress(
        machineRow,
        station.machineId,
      );
      if (cardsPerPress === null) {
        return { error: SEALING_COUNTER_CONFIG_ERROR };
      }
      resolvedCountTotal = computeSealedCountFromCounter(
        counterPresses,
        cardsPerPress,
      );
      sealingCounterPresses = counterPresses;
      sealingCardsPerPress = cardsPerPress;
    }

    const [bagProductRow] = await db
      .select({ productId: workflowBags.productId })
      .from(workflowBags)
      .where(eq(workflowBags.id, workflowBagId));

    if (
      (isSealingSegment || isSealingFinal) &&
      SEALING_STATION_KINDS.has(station.kind)
    ) {
      if (bagProductRow?.productId) {
        if (
          pickedSealingProductId &&
          pickedSealingProductId !== bagProductRow.productId
        ) {
          return { error: SEALING_PRODUCT_ALREADY_SAVED_ERROR };
        }
      } else {
        return { error: SEALING_SAVE_PRODUCT_FIRST_ERROR };
      }
    }

    const needsHandpackBlisterMaterial =
      (isSealingSegment ||
        (isSealingFinal && !isPureSealingStation)) &&
      SEALING_STATION_KINDS.has(station.kind) &&
      (await workflowBagHasHandpackBlisterComplete(workflowBagId));

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId,
        overrideEmployeeCode: overrideEmployeeCode ?? null,
      });
      // First-op count submissions (BLISTER_COMPLETE / BOTTLE_HANDPACK_
      // COMPLETE) MUST identify the accountable employee. Refuse early
      // if neither an active session nor a per-form override resolved.
      if (
        FIRST_OP_COUNT_EVENTS.has(eventType) &&
        !accountability.accountableEmployeeId
      ) {
        throw new Error(
          "No operator on shift. Open a shift on this station before submitting the first count.",
        );
      }

      let handpackBlisterLot: { id: string; qtyOnHand: number } | null = null;
      let handpackMaterialSkip: HandpackBlisterMaterialSkipReason | null =
        null;
      let handpackLotLookup: Awaited<
        ReturnType<typeof lookupProductMatchedBlisterCardLot>
      > | null = null;
      const handpackTabletContext =
        eventType === "HANDPACK_BLISTER_COMPLETE"
          ? await resolveWorkflowBagReceivedTabletContext(tx, workflowBagId)
          : null;
      if (eventType === "HANDPACK_BLISTER_COMPLETE" && !handpackTabletContext) {
        throw new Error(
          "This bag is missing received tablet context. Ask a supervisor to fix receiving/admin lineage before completing hand-pack.",
        );
      }
      if (
        needsHandpackBlisterMaterial &&
        (resolvedCountTotal ?? 0) > 0
      ) {
        handpackLotLookup = await lookupProductMatchedBlisterCardLot(
          workflowBagId,
          tx,
        );
        if (handpackLotLookup.status === "found") {
          handpackBlisterLot = handpackLotLookup.lot;
        } else {
          handpackMaterialSkip = handpackLotLookup.reason;
        }
      }

      if (
        eventType === "BLISTER_COMPLETE" &&
        isBlisterCounterSnapshotStation(station.kind) &&
        (resolvedCountTotal ?? 0) > 0
      ) {
        await assertCounterSnapshotAllowed(tx, {
          workflowBagId,
          stationId,
          context: "blister_close_out",
          submittedCount: resolvedCountTotal,
          allowZero: false,
          requirePositive: false,
        });
      }

      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType: eventType as WorkflowEventType,
        payload: {
          ...(sealingUsesCounter && !sealingFinalOnPureStation
            ? {
                count_total: resolvedCountTotal ?? 0,
                counter_presses: sealingCounterPresses,
                cards_per_press: sealingCardsPerPress,
                ...(handpackMaterialSkip
                  ? {
                      handpack_blister_material_skipped: true,
                      handpack_blister_material_skip_reason:
                        handpackMaterialSkip,
                    }
                  : {}),
              }
            : isSealingFinal && isPartialSealingClose && partialCloseReady
              ? buildPartialSealingClosePayload({
                  sealedPartialCount: partialCloseReady.sealedPartialCount,
                  reason: partialCloseReady.reason,
                  reasonNote: input.partialCloseReasonNote ?? null,
                })
              : isSealingFinal && sealingFinalCloseOnly
                ? { lane_close: true }
                : resolvedCountTotal
                  ? { count_total: resolvedCountTotal }
                  : {}),
          ...(packsRemaining ? { packs_remaining: packsRemaining } : {}),
          ...(cardsReopened ? { cards_reopened: cardsReopened } : {}),
          ...(eventType === "HANDPACK_BLISTER_COMPLETE" && handpackTabletContext
            ? {
                tablet_type_id: handpackTabletContext.tabletTypeId,
                tablet_type_source: handpackTabletContext.source,
                inventory_bag_id: handpackTabletContext.inventoryBagId,
              }
            : {}),
        },
        ...(clientEventId ? { clientEventId } : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
      if (
        (isSealingSegment || (isSealingFinal && !isPureSealingStation)) &&
        needsHandpackBlisterMaterial &&
        (resolvedCountTotal ?? 0) > 0
      ) {
        const sealedCardCount = resolvedCountTotal ?? 0;
        if (handpackBlisterLot) {
          await issueHandpackBlisterCardMaterial(tx, {
            workflowBagId,
            stationId,
            sealedCardCount,
            blisterLot: handpackBlisterLot,
            accountability,
          });
        } else if (
          handpackMaterialSkip === "no_available_lot" &&
          handpackLotLookup?.status === "skipped" &&
          handpackLotLookup.packagingMaterialId &&
          handpackLotLookup.unitOfMeasure
        ) {
          const [bagProduct] = await tx
            .select({ productId: workflowBags.productId })
            .from(workflowBags)
            .where(eq(workflowBags.id, workflowBagId));
          if (bagProduct?.productId) {
            await emitHandpackBlisterEstimatedMaterial(tx, {
              workflowBagId,
              stationId,
              productId: bagProduct.productId,
              packagingMaterialId: handpackLotLookup.packagingMaterialId,
              sealedCardCount,
              unitOfMeasure: handpackLotLookup.unitOfMeasure,
              skipReason: handpackMaterialSkip,
              occurredAt: new Date(),
            });
            await refreshMaterialReadModelsAfterConsumption(tx, {
              refreshRecommendations: true,
            });
          }
        }
      }
      // Segment submit intentionally keeps the bag pinned at this station
      // so the final lane-close button stays visible. Operators hand off to
      // the next sealing machine via releaseSealingHandoffAction.
      if (isPartialSealingClose) {
        await maybeAutoReleaseAfterPartialSealingClose(tx, {
          workflowBagId,
          stationId,
          clientEventId: clientEventId ?? null,
          accountability,
        });
      } else if (
        eventType === "HANDPACK_BLISTER_COMPLETE" ||
        (eventType === "BLISTER_COMPLETE" && station.kind === "BLISTER") ||
        (isSealingFinal && station.kind === "SEALING") ||
        eventType === "BOTTLE_HANDPACK_COMPLETE" ||
        eventType === "BOTTLE_CAP_SEAL_COMPLETE" ||
        eventType === "BOTTLE_STICKER_COMPLETE"
      ) {
        await maybeAutoReleaseAfterComplete(tx, {
          workflowBagId,
          stationId,
          stationKind: station.kind,
          clientEventId: clientEventId ?? null,
          accountability,
        });
      }
      // MULTI-SEALING-SAME-BAG-1: the final sealing close is the moment the
      // bag physically leaves the sealing line, so every OTHER sealing
      // station that overlap-claimed it is now holding a stale pin — the bag
      // is not on that machine any more. Clear those pins here.
      if (isSealingFinal && !isPartialSealingClose) {
        await releaseStaleSiblingSealingPins(tx, {
          workflowBagId,
          firingStationId: stationId,
          clientEventId: clientEventId ?? null,
          accountability,
        });
      }
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Event failed." };
  }
  return { ok: true };
}

/** Shared BAG_RELEASED projection — used by releaseBagAction and complete auto-release. */
export async function projectBagReleasedEvent(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    stationKind: string;
    releasedAtStage: string;
    accountability: StationAccountability;
    clientEventId?: string | null | undefined;
    /** Extra payload keys for system-initiated releases (e.g. the
     *  auto_release_reason marker on stale sibling pin clearing). Merged
     *  after the base keys; callers must not shadow them. */
    payloadExtra?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await projectEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    eventType: "BAG_RELEASED",
    payload: {
      station_kind: args.stationKind,
      released_at_stage: args.releasedAtStage,
      ...(args.payloadExtra ?? {}),
    },
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    enteredByUserId: args.accountability.enteredByUserId,
    accountableEmployeeId: args.accountability.accountableEmployeeId,
    accountabilitySource: args.accountability.accountabilitySource,
    accountableEmployeeNameSnapshot:
      args.accountability.accountableEmployeeNameSnapshot,
  });
}

/** Stations that auto-release on complete — no second operator tap.
 *  P2-QUEUE-1 completes the set: bottle fill and both finishing
 *  stations now release automatically too. STATION_RELEASE_FROM_STAGE
 *  supplies the stage each kind releases at, and the stage guard in
 *  maybeAutoReleaseAfterComplete keeps a first finishing step from
 *  releasing before the bag actually reached SEALED. */
const AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
  "BOTTLE_HANDPACK",
  "BOTTLE_CAP_SEAL",
  "BOTTLE_STICKER",
]);

/** Partial sealing close-out: release at BLISTERED so packaging can pick up. */
async function maybeAutoReleaseAfterPartialSealingClose(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    clientEventId?: string | null | undefined;
    accountability: StationAccountability;
  },
): Promise<void> {
  const [afterPartial] = await tx
    .select({ stage: readBagState.stage })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));
  if (afterPartial?.stage !== "BLISTERED") return;

  const [live] = await tx
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, args.stationId));
  if (live?.currentWorkflowBagId !== args.workflowBagId) return;

  const releaseClientEventId = args.clientEventId
    ? `${args.clientEventId}-auto-release`
    : undefined;

  await projectBagReleasedEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    stationKind: "SEALING",
    releasedAtStage: "BLISTERED",
    accountability: args.accountability,
    ...(releaseClientEventId ? { clientEventId: releaseClientEventId } : {}),
  });
}

/** MULTI-SEALING-SAME-BAG-1 — clear stale sibling sealing pins on final close.
 *
 *  Sealer B can overlap-claim a bag while sealer A is still working it (the
 *  sealing pickup stages allow it). If B never taps the handoff before A
 *  submits the FINAL SEALING_COMPLETE, B is left pinned to a bag that has
 *  physically left its machine: the handoff action requires stage BLISTERED,
 *  the floor scan form only renders when the station has no current bag, and
 *  the manual Release button no longer exists (P2-AUTO-ADVANCE-1). B would be
 *  stuck until packaging finalized the bag — minutes to hours of a blocked
 *  sealing machine.
 *
 *  The old manual Release button papered over this by making the operator
 *  clear their own stale pin. The system already knows the truth at final
 *  close, so it records it: one real BAG_RELEASED per stale sibling, through
 *  the same projection as every other release, so the event log says WHY the
 *  pin cleared and the projector clears the slot exactly as it always does.
 *  No direct read-model write.
 *
 *  Scoped to kind SEALING only. A packaging station that overlap-claimed the
 *  bag keeps its pin — the bag is on its way TO that station, not away from it.
 *  Deterministic station ordering keeps the derived clientEventId suffixes
 *  stable so a retried submit stays idempotent. */
async function releaseStaleSiblingSealingPins(
  tx: DbTx,
  args: {
    workflowBagId: string;
    firingStationId: string;
    clientEventId?: string | null | undefined;
    accountability: StationAccountability;
  },
): Promise<void> {
  const siblings = await tx
    .select({ stationId: readStationLive.stationId })
    .from(readStationLive)
    .innerJoin(stations, eq(stations.id, readStationLive.stationId))
    .where(
      and(
        eq(readStationLive.currentWorkflowBagId, args.workflowBagId),
        eq(stations.kind, "SEALING"),
        ne(readStationLive.stationId, args.firingStationId),
      ),
    )
    .orderBy(readStationLive.stationId);

  for (const [index, sibling] of siblings.entries()) {
    const siblingClientEventId = args.clientEventId
      ? `${args.clientEventId}-auto-release-sibling-${index}`
      : undefined;
    await projectBagReleasedEvent(tx, {
      workflowBagId: args.workflowBagId,
      stationId: sibling.stationId,
      stationKind: "SEALING",
      releasedAtStage: "SEALED",
      accountability: args.accountability,
      // The accountability carried here is the FIRING station's operator —
      // the sibling's operator did nothing. Without this marker the audit
      // trail reads as station A's operator releasing station B's bag.
      // The marker says the system cleared a stale pin, not a person.
      payloadExtra: { auto_release_reason: "STALE_SIBLING_SEALING_PIN" },
      ...(siblingClientEventId ? { clientEventId: siblingClientEventId } : {}),
    });
  }
}

/** BLISTER + HANDPACK_BLISTER + SEALING + BOTTLE_HANDPACK + BOTTLE_CAP_SEAL
 *  + BOTTLE_STICKER: complete also releases when still pinned. */
async function maybeAutoReleaseAfterComplete(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    stationKind: string;
    clientEventId?: string | null | undefined;
    accountability: StationAccountability;
  },
): Promise<void> {
  if (!AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS.has(args.stationKind)) return;
  const releaseAtStage = STATION_RELEASE_FROM_STAGE[args.stationKind];
  if (!releaseAtStage) return;

  const [afterComplete] = await tx
    .select({ stage: readBagState.stage })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));
  if (afterComplete?.stage !== releaseAtStage) return;

  const [live] = await tx
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, args.stationId));
  if (live?.currentWorkflowBagId !== args.workflowBagId) return;

  const releaseClientEventId = args.clientEventId
    ? `${args.clientEventId}-auto-release`
    : undefined;

  await projectBagReleasedEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    stationKind: args.stationKind,
    releasedAtStage: releaseAtStage,
    accountability: args.accountability,
    ...(releaseClientEventId ? { clientEventId: releaseClientEventId } : {}),
  });
}
