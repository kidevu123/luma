// Moved verbatim from app/(floor)/floor/[token]/actions.ts
// (packagingCompleteAction, guard sequence + transaction body, plus the
// module-scope helpers whose only remaining caller is that body:
// projectBagFinalizedEvent, AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS,
// maybeAutoFinalizeAfterPackagingComplete and
// resolveDeferredQrReleaseAfterPackaging).
//
// This is a pure relocation. Do not change behaviour, ordering, error
// strings, or payload shapes — the packaging close-out is the step that
// creates finished lots and drives PO reconciliation, so a drift here is
// a data-integrity bug, not a cosmetic one.
//
// actions.ts is a "use server" module, so every export there must be an
// async server action. The shared implementation therefore cannot live
// in it; the action now calls into this module and keeps only the
// FormData parse, authStation, and the trailing revalidatePath() calls
// (Next.js concerns, not domain logic). projectBagFinalizedEvent and
// resolveDeferredQrReleaseAfterPackaging are exported and imported back
// into actions.ts for finalizeBagAction, which shares them — the same
// arrangement projectBagReleasedEvent already has in record-stage-event.ts.

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products,
  qrCards,
  rawBagAllocationSessions,
  readBagState,
  readStationLive,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  autoCreateAndReleaseFinishedLotForWorkflowBag,
  runFinishedLotPostCommitEffects,
  type FinishedLotPostCommitEffect,
} from "@/lib/db/queries/finished-lots";
import { projectEvent } from "@/lib/projector";
import { emitCountBasedPackagingConsumption } from "@/lib/projector/packaging-consumption-hook";
import { refreshMaterialReadModelsAfterConsumption } from "@/lib/projector/material-read-model-refresh";
import { shouldReleaseQrAfterPackagingClose } from "@/lib/production/bag-allocation";
import {
  buildPackagingConsumptionPayloadSummary,
  patchPackagingCompleteConsumptionSummary,
} from "@/lib/production/packaging-consumption-summary";
import { checkPackagingPrereqs } from "@/lib/production/packaging-prereqs";
import { maybeReturnInventoryAfterPartialPackaging } from "@/lib/production/partial-bag-inventory-lifecycle";
import {
  allowsPackagingCompleteAtBlistered,
  buildPartialPackagingCompletePayload,
  readLatestPartialSealedCount,
  shouldEmitPartialPackagingComplete,
} from "@/lib/production/sealing-partial-closeout";
import {
  bothBottleFinishingDone,
  checkStageProgression,
  missingBottleFinishingSteps,
} from "@/lib/production/stage-progression";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import type { StationRow } from "./record-stage-event";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type StationAccountability = Awaited<
  ReturnType<typeof resolveStationAccountability>
>;

export type RecordPackagingCompleteInput = {
  station: StationRow;
  workflowBagId: string;
  masterCases: number;
  displaysMade: number;
  looseCards: number;
  damagedPackaging: number;
  rippedCards: number;
  operatorCode?: string | undefined;
  clientEventId?: string | undefined;
  // Derived by the caller from the submitted form, exactly as the action
  // derived them before the extraction: keepBagPartial is the presence of
  // the checkbox, and partialRemainingEstimate is honored ONLY when the
  // operator is actually keeping the bag partial (null otherwise).
  keepBagPartial: boolean;
  partialRemainingEstimate: number | null;
};

/** Record a packaging close-out: the guard sequence and transaction moved
 *  out of packagingCompleteAction.
 *
 *  PRECONDITION — callers MUST have authenticated the station first. This
 *  function performs NO station auth of its own: it trusts `input.station`
 *  and derives `stationId` from `station.id`. On the floor path that
 *  guarantee comes from `authStation(token, stationId)`, which validates the
 *  URL scan token, refuses a station/form mismatch, and rejects inactive
 *  stations. Any new caller (Phase 4 onward) must establish the same
 *  guarantee before calling — do not expose this over an unauthenticated
 *  route. */
export async function recordPackagingComplete(
  input: RecordPackagingCompleteInput,
): Promise<{ ok: true } | { error: string }> {
  const {
    station,
    workflowBagId,
    masterCases,
    displaysMade,
    looseCards,
    damagedPackaging,
    rippedCards,
    operatorCode,
    clientEventId,
    keepBagPartial,
    partialRemainingEstimate,
  } = input;
  // authStation guarantees station.id === the stationId the form
  // targeted, so this is the same value the action used.
  const stationId = station.id;

  try {
    if (station.kind !== "PACKAGING" && station.kind !== "COMBINED") {
      return {
        error: `Station kind ${station.kind} can't fire PACKAGING_COMPLETE.`,
      };
    }
    // Reject all-zeros — operator probably tapped Save by accident.
    if (
      masterCases +
        displaysMade +
        looseCards +
        damagedPackaging +
        rippedCards ===
      0
    ) {
      return { error: "Enter at least one count before saving." };
    }
    // Stage-progression guard — same rule as fireStageEventAction.
    const [pkgState] = await db
      .select({
        isPaused: readBagState.isPaused,
        isFinalized: readBagState.isFinalized,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, workflowBagId));
    const pkgPriorEvents = await db
      .select({
        eventType: workflowEvents.eventType,
        payload: workflowEvents.payload,
      })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowBagId, workflowBagId));
    const pkgEventSlices = pkgPriorEvents.map((row) => ({
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
    }));
    const packagingPartialSealedReady = allowsPackagingCompleteAtBlistered(
      pkgEventSlices,
    );
    const emitPartialPackaging = shouldEmitPartialPackagingComplete(
      pkgEventSlices,
    );
    const pkgProg = checkStageProgression({
      eventType: "PACKAGING_COMPLETE",
      currentStage: pkgState?.stage ?? null,
      isPaused: pkgState?.isPaused ?? false,
      isFinalized: pkgState?.isFinalized ?? false,
      packagingPartialSealedReady,
    });
    if (!pkgProg.allowed) return { error: pkgProg.reason };

    // PRD-2 — Packaging prereq guard. Cannot complete packaging
    // without product + packaging structure: the projector would
    // otherwise silently record unitsYielded=0 (because its product
    // lookup returns nothing), which corrupts PO reconciliation,
    // supplier settlement, and finished-goods inventory.
    const [bagRow] = await db
      .select({
        id: workflowBags.id,
        productId: workflowBags.productId,
        inventoryBagId: workflowBags.inventoryBagId,
      })
      .from(workflowBags)
      .where(eq(workflowBags.id, workflowBagId));
    if (!bagRow) {
      return { error: "Workflow bag not found." };
    }
    const productRow = bagRow.productId
      ? (
          await db
            .select({
              id: products.id,
              name: products.name,
              sku: products.sku,
              kind: products.kind,
              unitsPerDisplay: products.unitsPerDisplay,
              displaysPerCase: products.displaysPerCase,
            })
            .from(products)
            .where(eq(products.id, bagRow.productId))
        )[0] ?? null
      : null;
    // BOTTLE-ORDER-FLEX-1: the Packaging station is the terminal finalize
    // step for bottles. Both finishing steps (cap-seal AND sticker) must
    // have run first — they're interchangeable in order, but packaging
    // refuses to close a bottle that skipped one. (Card products are
    // unaffected; they have no bottle finishing events.)
    if (productRow?.kind === "BOTTLE") {
      const pkgPriorTypes = pkgEventSlices.map((e) => e.eventType);
      if (!bothBottleFinishingDone(pkgPriorTypes)) {
        const missing = missingBottleFinishingSteps(pkgPriorTypes);
        return {
          error: `This bottle bag still needs ${missing.join(
            " and ",
          )} before it can be packaged.`,
        };
      }
    }
    const prereq = checkPackagingPrereqs({
      bag: { id: bagRow.id, productId: bagRow.productId ?? null },
      product: productRow ?? null,
    });
    if (!prereq.ok) {
      return { error: prereq.reason };
    }

    const finishedLotEffects: FinishedLotPostCommitEffect[] = [];
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: stationId,
        overrideEmployeeCode: operatorCode ?? null,
      });
      const occurredAt = new Date();
      const packagingPayload = emitPartialPackaging
        ? buildPartialPackagingCompletePayload({
            masterCases: masterCases,
            displaysMade: displaysMade,
            looseCards: looseCards,
            damagedPackaging: damagedPackaging,
            rippedCards: rippedCards,
            sealedPartialCount: readLatestPartialSealedCount(pkgEventSlices),
            operatorCode: operatorCode ?? null,
          })
        : {
            master_cases: masterCases,
            displays_made: displaysMade,
            loose_cards: looseCards,
            damaged_packaging: damagedPackaging,
            ripped_cards: rippedCards,
            ...(operatorCode
              ? { operator_code: operatorCode }
              : {}),
          };
      await projectEvent(tx, {
        workflowBagId: workflowBagId,
        stationId: stationId,
        eventType: "PACKAGING_COMPLETE",
        payload: packagingPayload,
        ...(clientEventId
          ? { clientEventId: clientEventId }
          : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
      const consumption = await emitCountBasedPackagingConsumption(tx, {
        workflowBagId: workflowBagId,
        stationId: stationId,
        payload: {
          master_cases: masterCases,
          displays_made: displaysMade,
          loose_cards: looseCards,
          damaged_packaging: damagedPackaging,
          ripped_cards: rippedCards,
        },
        occurredAt,
      });
      await patchPackagingCompleteConsumptionSummary(tx, {
        workflowBagId: workflowBagId,
        summary: buildPackagingConsumptionPayloadSummary(consumption),
        clientEventId: clientEventId ?? null,
      });
      await refreshMaterialReadModelsAfterConsumption(tx, {
        refreshRecommendations: true,
      });
      if (emitPartialPackaging && bagRow.inventoryBagId) {
        await maybeReturnInventoryAfterPartialPackaging(tx, {
          workflowBagId: workflowBagId,
          inventoryBagId: bagRow.inventoryBagId,
          stationId: stationId,
          accountability,
          clientEventId: clientEventId ?? null,
        });
      }
      if (station.kind === "PACKAGING" && !emitPartialPackaging) {
        // P2-PARTIAL-KEEP is scoped to BOTTLE products: bottle runs routinely
        // end on a partial bag, and (unlike the card line) the QR-release
        // decision must wait for the production-output close to compute the
        // true remaining tablets. Card/variety packaging keeps its existing
        // immediate-release behavior untouched.
        const isBottleBag = productRow?.kind === "BOTTLE";
        const didFinalize = await maybeAutoFinalizeAfterPackagingComplete(tx, {
          workflowBagId: workflowBagId,
          stationId: stationId,
          stationKind: station.kind,
          accountability,
          deferQrRelease: isBottleBag,
          keepPartial: keepBagPartial && isBottleBag,
          ...(isBottleBag && partialRemainingEstimate != null
            ? { remainingEstimate: partialRemainingEstimate }
            : {}),
          ...(clientEventId
            ? { clientEventId: clientEventId }
            : {}),
        });
        if (didFinalize) {
          const autoLot = await autoCreateAndReleaseFinishedLotForWorkflowBag(tx, {
            workflowBagId: workflowBagId,
            packagedAt: occurredAt,
            counts: {
              masterCases: masterCases,
              displaysMade: displaysMade,
              looseCards: looseCards,
            },
            actor: {
              id: accountability.enteredByUserId,
              role: "STAFF",
            },
          });
          if (autoLot.ok) {
            finishedLotEffects.push(...autoLot.effects);
          } else {
            await writeAudit(
              {
                actorId: accountability.enteredByUserId,
                actorRole: "STAFF",
                action: "finished_lot.auto_create_blocked",
                targetType: "WorkflowBag",
                targetId: workflowBagId,
                after: {
                  reason: autoLot.reason,
                  message: autoLot.message,
                  packaging_complete_client_event_id:
                    clientEventId ?? null,
                },
              },
              tx,
            );
          }
          // P2-PARTIAL-KEEP (bottles only): the BAG_FINALIZED projector
          // deferred the QR release. Now that the production-output close
          // (above) has computed the true remaining tablet balance, decide for
          // real: release the QR only if the bag is confirmed empty; hold it on
          // the bag (partial / kept-partial / unknown remaining) so it is never
          // dropped to the unused pool and stays reusable for the next run.
          if (isBottleBag) {
            await resolveDeferredQrReleaseAfterPackaging(tx, {
              workflowBagId: workflowBagId,
              keepPartial: keepBagPartial,
              accountability,
            });
          }
        }
      }
    });
    await runFinishedLotPostCommitEffects(finishedLotEffects);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  return { ok: true };
}

/** Shared BAG_FINALIZED projection — used by finalizeBagAction and packaging auto-finalize.
 *
 *  P2-PARTIAL-KEEP: optional payload intent flags control QR-card release.
 *  - deferQrRelease: the packaging path defers the release decision until the
 *    production-output allocation close has computed the true remaining balance
 *    (the projector HOLDS the QR; the packaging action re-decides).
 *  - keepPartial: the operator explicitly kept the physical bag as a partial;
 *    the QR is never returned to the unused pool.
 *  - remainingEstimate: an OPTIONAL operator-entered estimate of tablets left
 *    in the bag. Stored as an immutable, clearly-labelled estimate on the event
 *    only — it never overwrites the OUTPUT_DERIVED allocation-session balance
 *    that PO reconciliation reads (luma-data-honesty: estimate ≠ confirmed). */
export async function projectBagFinalizedEvent(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    accountability: StationAccountability;
    clientEventId?: string | null | undefined;
    deferQrRelease?: boolean;
    keepPartial?: boolean;
    remainingEstimate?: number | null;
  },
): Promise<void> {
  const partialPayload: Record<string, unknown> = {};
  if (args.deferQrRelease) partialPayload.defer_qr_release = true;
  if (args.keepPartial) partialPayload.bag_remains_partial = true;
  if (args.remainingEstimate != null && args.remainingEstimate >= 0) {
    partialPayload.operator_remaining_estimate = args.remainingEstimate;
    partialPayload.operator_remaining_estimate_source = "OPERATOR_ESTIMATE";
  }
  await projectEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    eventType: "BAG_FINALIZED",
    ...(Object.keys(partialPayload).length > 0 ? { payload: partialPayload } : {}),
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    enteredByUserId: args.accountability.enteredByUserId,
    accountableEmployeeId: args.accountability.accountableEmployeeId,
    accountabilitySource: args.accountability.accountabilitySource,
    accountableEmployeeNameSnapshot:
      args.accountability.accountableEmployeeNameSnapshot,
  });
}

/** PACKAGING only — close-out also finalizes when still pinned at PACKAGED. */
const AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS = new Set([
  "PACKAGING",
]);

/** PACKAGING: PACKAGING_COMPLETE also finalizes when still pinned.
 *
 *  P2-PARTIAL-KEEP: the QR-release decision is DEFERRED at finalize time
 *  (defer_qr_release) because the production-output allocation close — which
 *  computes the true remaining tablet balance — runs *after* this in the
 *  packaging action. The caller re-decides the release once the real ending
 *  balance is known so a partial bag never has its QR dropped to the pool.
 *  keepPartial carries an explicit operator override onto the event. */
async function maybeAutoFinalizeAfterPackagingComplete(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    stationKind: string;
    clientEventId?: string | null | undefined;
    accountability: StationAccountability;
    deferQrRelease?: boolean;
    keepPartial?: boolean;
    remainingEstimate?: number | null;
  },
): Promise<boolean> {
  if (!AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS.has(args.stationKind)) {
    return false;
  }

  const [afterComplete] = await tx
    .select({
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
    })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));
  if (afterComplete?.stage !== "PACKAGED") return false;
  if (afterComplete?.isFinalized) return false;

  const [live] = await tx
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, args.stationId));
  if (live?.currentWorkflowBagId !== args.workflowBagId) return false;

  const finalizeClientEventId = args.clientEventId
    ? `${args.clientEventId}-auto-finalize`
    : undefined;

  await projectBagFinalizedEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    accountability: args.accountability,
    ...(args.deferQrRelease ? { deferQrRelease: true } : {}),
    ...(args.keepPartial ? { keepPartial: true } : {}),
    ...(args.remainingEstimate != null
      ? { remainingEstimate: args.remainingEstimate }
      : {}),
    ...(finalizeClientEventId ? { clientEventId: finalizeClientEventId } : {}),
  });
  return true;
}

/** P2-PARTIAL-KEEP — after the packaging production-output close has run, the
 *  deferred QR is released only when the bag is confirmed empty. A partial bag
 *  (remaining > 0), an unknown remaining, or an explicit keep-partial all HOLD
 *  the QR on the bag so it stays assigned and reusable in a later run. */
export async function resolveDeferredQrReleaseAfterPackaging(
  tx: DbTx,
  args: {
    workflowBagId: string;
    keepPartial: boolean;
    accountability: StationAccountability;
  },
): Promise<void> {
  const [wfSession] = await tx
    .select({ endingBalanceQty: rawBagAllocationSessions.endingBalanceQty })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.workflowBagId, args.workflowBagId))
    .orderBy(desc(rawBagAllocationSessions.openedAt))
    .limit(1);

  const release = shouldReleaseQrAfterPackagingClose({
    keepPartial: args.keepPartial,
    endingBalanceQty: wfSession?.endingBalanceQty ?? null,
  });

  if (release) {
    await tx
      .update(qrCards)
      .set({ status: "IDLE", assignedWorkflowBagId: null })
      .where(eq(qrCards.assignedWorkflowBagId, args.workflowBagId));
    // Record WHY the QR returned to the unused pool — bag confirmed empty at
    // packaging close-out — so the release reason is clear in the audit trail
    // (distinct from a supervisor force-release).
    await writeAudit(
      {
        actorId: args.accountability.enteredByUserId ?? null,
        actorRole: null,
        action: "floor.bag_qr_released_empty",
        targetType: "WorkflowBag",
        targetId: args.workflowBagId,
        after: {
          released_to_idle: true,
          reason: "bag_confirmed_empty",
          remaining_qty: wfSession?.endingBalanceQty ?? null,
        },
      },
      tx,
    );
    return;
  }

  // Held — the bag is partial (or kept partial / unknown remaining). Record the
  // decision so the partial-bag state is auditable and obvious downstream.
  await writeAudit(
    {
      actorId: args.accountability.enteredByUserId ?? null,
      actorRole: null,
      action: "floor.bag_kept_partial",
      targetType: "WorkflowBag",
      targetId: args.workflowBagId,
      after: {
        kept_partial: true,
        explicit: args.keepPartial,
        remaining_qty: wfSession?.endingBalanceQty ?? null,
      },
    },
    tx,
  );
}
