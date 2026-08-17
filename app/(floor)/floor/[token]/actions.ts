"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, sql, desc, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  workflowBags,
  inventoryBags,
  readBagState,
  readStationLive,
  products,
  rawBagAllocationSessions,
  workflowEvents,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { refreshMaterialReadModelsAfterBlister } from "@/lib/projector/material-read-model-refresh";
// The engine barrel is the ONLY permitted entry point from app/(floor)/
// into lib/production — deep paths are restricted too (eslint.config.mjs).
import {
  assignBagProduct,
  OpenAllocationBlockError,
  raiseAllocationOpenFailure,
  resolveStationByToken,
  canResumeFinalizedWorkflowOnInventoryBag,
  loadPartialReuseContext,
  type PartialBagSession,
  type PartialReuseContext,
  loadRawBagStartClassificationForScan,
  RAW_BAG_START_OPERATOR_MESSAGES,
  floorReadinessOperatorMessage,
  evaluateQrCardReadinessById,
  STATION_PICKUP_FROM_STAGE,
  STATION_STARTED_RESUME_FROM_STAGE,
  formatFloorStationBagOpenError,
  STATIONS_THAT_FINALIZE,
  bothBottleFinishingDone,
  missingBottleFinishingSteps,
  BOTTLE_FINISHING_EVENTS,
  computeSystemDerivedResolutionForBag,
  buildFloorOpenAllocationBlock,
  resolveAllocationFromProductionOutput,
  type FloorOpenAllocationBlock,
  resolveStationAccountability,
  ensureOpenRawBagAllocationSessionForWorkflowBag,
  assertStationActiveForFloorActions,
  isWorkflowBagResumableAtSealingAfterPartialPackaging,
  lookupInventoryBagByQrScanToken,
  parseNonnegativeIntegerInput,
  pauseCounterSnapshotMissingError,
  stationRequiresBlisterCounterSnapshot,
  recordBlisterCounterRollSegment,
  assertCounterSnapshotAllowed,
  checkFirstOpProductSelection,
} from "@/lib/production/engine";

// Canonical source: lib/production/first-op-product.ts FIRST_OP_STATION_KINDS.
// Intentionally duplicated here for floor-action isolation — do NOT
// deduplicate or import the shared constant into this file. If
// FIRST_OP_STATION_KINDS changes, update both sets in tandem.
const FRESH_BAG_STATION_KINDS: ReadonlySet<string> = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "BOTTLE_HANDPACK",
  "COMBINED",
]);

// P2-FINISHING-RECLAIM-1: the completion event each bottle finishing
// station fires, plus the operator-facing past tense for it.
const FINISHING_COMPLETE_EVENT_BY_STATION_KIND: Readonly<
  Record<string, string | undefined>
> = {
  BOTTLE_STICKER: "BOTTLE_STICKER_COMPLETE",
  BOTTLE_CAP_SEAL: "BOTTLE_CAP_SEAL_COMPLETE",
};
const FINISHING_DONE_LABEL_BY_STATION_KIND: Readonly<
  Record<string, string | undefined>
> = {
  BOTTLE_STICKER: "stickered",
  BOTTLE_CAP_SEAL: "cap-sealed",
};

// Floor PWA actions are anonymous (no admin login). Authorization is
// the station's scan_token, which lives in the URL. Every action MUST
// take the token, look up the station, and then refuse if the
// stationId in the form doesn't match the URL's station — otherwise
// any anonymous client could POST events to any station by hand.

type StationRow = typeof stations.$inferSelect;

/** Resolve and lock a station by its URL scan token. Returns null
 *  if no match — caller should reject the request. */
async function resolveStation(token: string): Promise<StationRow | null> {
  return resolveStationByToken(token);
}

/** Compose the per-action wrapper: validate token + stationId
 *  matches, return the resolved station so the action can use it. */
async function authStation(
  token: string,
  stationIdFromForm: string,
): Promise<StationRow> {
  const station = await resolveStation(token);
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) {
    // Token doesn't own the station the form is targeting — block.
    throw new Error("Station mismatch.");
  }
  assertStationActiveForFloorActions(station);
  return station;
}

// UUID v4-ish pattern for the floor-side idempotency token. Optional
// on the action (legacy clients won't send it), but when present we
// pass it through to projectEvent so a network retry hits the partial
// unique index instead of double-firing the stage.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clientEventIdField = z
  .string()
  .regex(UUID_RE, "Invalid client event id.")
  .optional();

function pickClientEventId(formData: FormData): string | undefined {
  const raw = formData.get("clientEventId");
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return UUID_RE.test(raw) ? raw : undefined;
}

// ── scan card ──────────────────────────────────────────────────────────────

const scanSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  cardId: z.string().uuid(),
  /** Required at first-op stations (BLISTER / COMBINED) when scanning
   *  an IDLE card. Ignored at downstream pickups — the bag already
   *  carries a product. */
  productId: z.string().uuid().optional().nullable().or(z.literal("")),
  /** OP-1C per-form override: a supervisor entering a count on behalf
   *  of another operator. Resolved server-side via the accountability
   *  resolver. When omitted the active station-operator-session
   *  defaults the accountable employee. */
  overrideEmployeeCode: z.string().max(40).optional().nullable(),
  /** P1-PARTIAL — starting from a partial bag is an explicit flow:
   *  the first scan returns the partial context and the operator must
   *  confirm before the run opens. */
  confirmPartialReuse: z.string().optional().nullable(),
  /** Required when the partial's remaining confidence is LOW —
   *  supervisor badge confirming the reuse. */
  partialReuseSupervisorCode: z.string().max(40).optional().nullable(),
});

/** Thrown inside the scan transaction when a partial bag start needs
 *  operator confirmation. Caught by scanCardAction and returned as a
 *  structured response (NOT an error) so the floor shows the
 *  confirmation panel. */
class PartialReuseConfirmationRequiredError extends Error {
  readonly context: PartialReuseContext;
  constructor(context: PartialReuseContext) {
    super("Partial bag — confirmation required before starting.");
    this.name = "PartialReuseConfirmationRequiredError";
    this.context = context;
  }
}

// ASSIGN-PRODUCT-EXTRACT-1: OpenAllocationBlockError and
// raiseAllocationOpenFailure moved verbatim to
// lib/production/engine/assign-bag-product.ts alongside the sealing
// product-save body that throws them. They are imported back through the
// engine barrel (see the import block above) because the scan and pickup
// paths below throw and catch the SAME class — two copies would make
// `instanceof` silently stop matching.

/** P1-PARTIAL — gate for every partial-bag start path. Throws the
 *  confirmation error on the first (unconfirmed) attempt, and enforces
 *  the confidence model: LOW remaining requires a supervisor badge.
 *  (MISSING/unknown remaining never reaches here — the restart guards
 *  refuse it upstream.) */
async function enforcePartialReuseConfirmation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    inventoryBagId: string;
    stationId: string;
    confirmed: boolean;
    supervisorCode: string | null;
  },
): Promise<void> {
  const context = await loadPartialReuseContext(tx, args.inventoryBagId);
  if (!args.confirmed) {
    throw new PartialReuseConfirmationRequiredError(context);
  }
  if (context.remainingConfidence === "LOW") {
    if (!args.supervisorCode?.trim()) {
      throw new Error(
        "This partial bag's remaining count is low confidence — a supervisor badge code is required to reuse it.",
      );
    }
    const supervisor = await resolveStationAccountability(tx, {
      stationId: args.stationId,
      overrideEmployeeCode: args.supervisorCode,
      sourceHint: "SUPERVISOR_OVERRIDE",
    });
    if (!supervisor.accountableEmployeeId) {
      throw new Error(
        "Supervisor badge code not recognized — check the code and try again.",
      );
    }
  }
}

export async function scanCardAction(
  formData: FormData,
): Promise<
  | {
      error?: string;
      ok?: true;
      partialReuseConfirmationRequired?: true;
      partialContext?: PartialReuseContext;
      openAllocationBlock?: FloorOpenAllocationBlock;
    }
  | void
> {
  const parsed = scanSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    cardId: formData.get("cardId"),
    productId: formData.get("productId") || undefined,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || undefined,
    confirmPartialReuse: formData.get("confirmPartialReuse") || undefined,
    partialReuseSupervisorCode:
      formData.get("partialReuseSupervisorCode") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { token, stationId, cardId, overrideEmployeeCode } = parsed.data;
  const partialReuseConfirmed = parsed.data.confirmPartialReuse === "true";
  const partialReuseSupervisorCode =
    parsed.data.partialReuseSupervisorCode ?? null;
  const pickedProductId =
    parsed.data.productId && parsed.data.productId !== ""
      ? parsed.data.productId
      : null;

  try {
    const station = await authStation(token, stationId);
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId,
        overrideEmployeeCode: overrideEmployeeCode ?? null,
      });
      // FOR UPDATE prevents the IDLE→ASSIGNED race where two
      // concurrent scanners both pass the IDLE check.
      await tx.execute(
        sql`SELECT 1 FROM qr_cards WHERE id = ${cardId} FOR UPDATE`,
      );
      const [card] = await tx
        .select()
        .from(qrCards)
        .where(eq(qrCards.id, cardId));
      if (!card) throw new Error("Card not found.");
      if (card.cardType !== "RAW_BAG") {
        throw new Error("Only bag QR cards (RAW_BAG type) can be used to start production.");
      }

      const idleLinkedStart =
        card.status === "IDLE"
          ? await loadRawBagStartClassificationForScan(tx, {
              scannedToken: card.scanToken,
              cardScanToken: card.scanToken,
            })
          : null;
      if (card.status === "IDLE") {
        if (!idleLinkedStart?.canStart) {
          throw new Error(
            idleLinkedStart?.operatorMessage ??
              "This bag QR has not been linked to a received bag. Receive the bag first on the Receive Pills page.",
          );
        }
      }

      if (
        (card.status === "ASSIGNED" && !card.assignedWorkflowBagId) ||
        (card.status === "IDLE" && idleLinkedStart?.canStart)
      ) {
        // Intake-reserved fresh scan — first-op stations REQUIRE a product pick so
        // workflow_bags.product_id lands non-null at the very first
        // event. Downstream stations inherit via the projector's
        // COALESCE pattern.
        const productLookup = pickedProductId
          ? (
              await tx
                .select({
                  id: products.id,
                  sku: products.sku,
                  name: products.name,
                  kind: products.kind,
                  isActive: products.isActive,
                })
                .from(products)
                .where(eq(products.id, pickedProductId))
            )[0] ?? null
          : null;
        // Intake-reserved cards (ASSIGNED+null workflowBagId) are
        // semantically equivalent to IDLE for first-op gating.
        if (!FRESH_BAG_STATION_KINDS.has(station.kind)) {
          throw new Error(
            "This station does not start fresh bags. Scan a bag that has already been released to this station.",
          );
        }
        const firstOp = checkFirstOpProductSelection({
          stationKind: station.kind,
          cardStatus: "IDLE",
          pickedProductId,
          product: productLookup,
        });
        if (!firstOp.ok) throw new Error(firstOp.reason);

        const partialRestart =
          idleLinkedStart?.status === "PARTIAL_READY";
        if (partialRestart && idleLinkedStart?.inventoryBagId) {
          // P1-PARTIAL — explicit reuse confirmation + LOW-confidence
          // supervisor gate before the run opens.
          await enforcePartialReuseConfirmation(tx, {
            inventoryBagId: idleLinkedStart.inventoryBagId,
            stationId: station.id,
            confirmed: partialReuseConfirmed,
            supervisorCode: partialReuseSupervisorCode,
          });
        }
        const readiness = await evaluateQrCardReadinessById(tx, cardId, {
          allowPartialBagRestart: partialRestart,
        });
        if (!readiness) throw new Error("Card not found.");
        if (readiness.level === "BLOCKED") {
          throw new Error(floorReadinessOperatorMessage(readiness));
        }

        const productIdToSet = firstOp.productId; // null when not first-op
        const inventoryLink = await lookupInventoryBagByQrScanToken(
          tx,
          card.scanToken,
        );
        if (!inventoryLink?.inventoryBagId) {
          throw new Error(floorReadinessOperatorMessage(readiness));
        }
        const [bag] = await tx
          .insert(workflowBags)
          .values({
            ...(productIdToSet ? { productId: productIdToSet } : {}),
            inventoryBagId: inventoryLink.inventoryBagId,
          })
          .returning();
        if (!bag) throw new Error("Could not create workflow bag.");
        await tx
          .update(qrCards)
          .set({ status: "ASSIGNED", assignedWorkflowBagId: bag.id })
          .where(eq(qrCards.id, cardId));
        await projectEvent(tx, {
          workflowBagId: bag.id,
          stationId: station.id,
          eventType: "CARD_ASSIGNED",
          payload: {
            qr_card_id: cardId,
            station_kind: station.kind,
            inventory_bag_id: inventoryLink.inventoryBagId,
            tablet_type_id: inventoryLink.tabletTypeId,
            ...(partialRestart ? { partial_bag_restart: true } : {}),
          },
          enteredByUserId: accountability.enteredByUserId,
          accountableEmployeeId: accountability.accountableEmployeeId,
          accountabilitySource: accountability.accountabilitySource,
          accountableEmployeeNameSnapshot:
            accountability.accountableEmployeeNameSnapshot,
        });
        if (productIdToSet && productLookup) {
          await projectEvent(tx, {
            workflowBagId: bag.id,
            stationId: station.id,
            eventType: "PRODUCT_MAPPED",
            payload: {
              product_id: productIdToSet,
              product_sku: productLookup.sku,
              product_name: productLookup.name,
              product_kind: productLookup.kind,
              station_kind: station.kind,
              source: "FIRST_OPERATION_SELECTION",
            },
            enteredByUserId: accountability.enteredByUserId,
            accountableEmployeeId: accountability.accountableEmployeeId,
            accountabilitySource: accountability.accountabilitySource,
            accountableEmployeeNameSnapshot:
              accountability.accountableEmployeeNameSnapshot,
          });
        }
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "floor.card_assigned",
            targetType: "WorkflowBag",
            targetId: bag.id,
            after: {
              card_id: cardId,
              station_id: stationId,
              product_id: productIdToSet,
              product_sku: productLookup?.sku ?? null,
            },
          },
          tx,
        );
        {
          const alloc = await ensureOpenRawBagAllocationSessionForWorkflowBag(tx, {
            inventoryBagId: inventoryLink.inventoryBagId,
            workflowBagId: bag.id,
            ...(productIdToSet ? { productId: productIdToSet } : {}),
          });
          if (!alloc.ok)
            raiseAllocationOpenFailure(alloc, {
              inventoryBagId: inventoryLink.inventoryBagId,
              cardId,
            });
        }
        return;
      }

      if (card.status === "ASSIGNED") {
        // Multi-station travel: the same QR is scanned at a downstream
        // station to pick up a bag that a prior station released. The
        // card stays ASSIGNED; we only update station_live via a
        // BAG_PICKED_UP event.
        const bagId = card.assignedWorkflowBagId;
        if (!bagId) {
          throw new Error(
            "Card is assigned but has no workflow bag — data inconsistent.",
          );
        }
        const [state] = await tx
          .select({
            stage: readBagState.stage,
            isPaused: readBagState.isPaused,
            isFinalized: readBagState.isFinalized,
          })
          .from(readBagState)
          .where(eq(readBagState.workflowBagId, bagId));
        const partialStart = await loadRawBagStartClassificationForScan(tx, {
          scannedToken: card.scanToken,
          cardScanToken: card.scanToken,
        });
        if (
          partialStart.status === "PARTIAL_NEEDS_REVIEW" ||
          partialStart.status === "PARTIAL_NEEDS_ALLOCATION_CLOSEOUT"
        ) {
          throw new Error(partialStart.operatorMessage);
        }
        if (partialStart.status === "PARTIAL_READY") {
          if (!FRESH_BAG_STATION_KINDS.has(station.kind)) {
            throw new Error(
              RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_READY_WRONG_STATION,
            );
          }
          if (partialStart.inventoryBagId) {
            // P1-PARTIAL — explicit reuse confirmation + LOW-confidence
            // supervisor gate before the restart run opens.
            await enforcePartialReuseConfirmation(tx, {
              inventoryBagId: partialStart.inventoryBagId,
              stationId: station.id,
              confirmed: partialReuseConfirmed,
              supervisorCode: partialReuseSupervisorCode,
            });
          }
          const productLookup = pickedProductId
            ? (
                await tx
                  .select({
                    id: products.id,
                    sku: products.sku,
                    name: products.name,
                    kind: products.kind,
                    isActive: products.isActive,
                  })
                  .from(products)
                  .where(eq(products.id, pickedProductId))
              )[0] ?? null
            : null;
          const firstOp = checkFirstOpProductSelection({
            stationKind: station.kind,
            cardStatus: "IDLE",
            pickedProductId,
            product: productLookup,
          });
          if (!firstOp.ok) throw new Error(firstOp.reason);

          const restartReadiness = await evaluateQrCardReadinessById(tx, cardId, {
            allowPartialBagRestart: true,
          });
          if (!restartReadiness) throw new Error("Card not found.");
          if (restartReadiness.level === "BLOCKED") {
            throw new Error(floorReadinessOperatorMessage(restartReadiness));
          }

          const productIdToSet = firstOp.productId;
          const inventoryLink = await lookupInventoryBagByQrScanToken(
            tx,
            card.scanToken,
          );
          if (!inventoryLink?.inventoryBagId) {
            throw new Error(floorReadinessOperatorMessage(restartReadiness));
          }
          const [restartBag] = await tx
            .insert(workflowBags)
            .values({
              ...(productIdToSet ? { productId: productIdToSet } : {}),
              inventoryBagId: inventoryLink.inventoryBagId,
            })
            .returning();
          if (!restartBag) {
            throw new Error("Could not create workflow bag for partial-bag restart.");
          }

          await tx
            .update(qrCards)
            .set({ assignedWorkflowBagId: restartBag.id })
            .where(eq(qrCards.id, cardId));

          await projectEvent(tx, {
            workflowBagId: restartBag.id,
            stationId: station.id,
            eventType: "CARD_ASSIGNED",
            payload: {
              qr_card_id: cardId,
              station_kind: station.kind,
              inventory_bag_id: inventoryLink.inventoryBagId,
              tablet_type_id: inventoryLink.tabletTypeId,
              partial_bag_restart: true,
              prior_workflow_bag_id: bagId,
            },
            enteredByUserId: accountability.enteredByUserId,
            accountableEmployeeId: accountability.accountableEmployeeId,
            accountabilitySource: accountability.accountabilitySource,
            accountableEmployeeNameSnapshot:
              accountability.accountableEmployeeNameSnapshot,
          });
          if (productIdToSet && productLookup) {
            await projectEvent(tx, {
              workflowBagId: restartBag.id,
              stationId: station.id,
              eventType: "PRODUCT_MAPPED",
              payload: {
                product_id: productIdToSet,
                product_sku: productLookup.sku,
                product_name: productLookup.name,
                product_kind: productLookup.kind,
                station_kind: station.kind,
                source: "FIRST_OPERATION_SELECTION",
              },
              enteredByUserId: accountability.enteredByUserId,
              accountableEmployeeId: accountability.accountableEmployeeId,
              accountabilitySource: accountability.accountabilitySource,
              accountableEmployeeNameSnapshot:
                accountability.accountableEmployeeNameSnapshot,
            });
          }
          await writeAudit(
            {
              actorId: null,
              actorRole: null,
              action: "floor.partial_bag_restart",
              targetType: "WorkflowBag",
              targetId: restartBag.id,
              after: {
                card_id: cardId,
                station_id: stationId,
                product_id: productIdToSet,
                prior_workflow_bag_id: bagId,
                inventory_bag_id: inventoryLink.inventoryBagId,
              },
            },
            tx,
          );
          {
            const alloc = await ensureOpenRawBagAllocationSessionForWorkflowBag(tx, {
              inventoryBagId: inventoryLink.inventoryBagId,
              workflowBagId: restartBag.id,
              ...(productIdToSet ? { productId: productIdToSet } : {}),
            });
            if (!alloc.ok)
              raiseAllocationOpenFailure(alloc, {
                inventoryBagId: inventoryLink.inventoryBagId,
                cardId,
              });
          }
          return;
        }
        if (state?.isFinalized) {
          const inventoryLinkForResume = await lookupInventoryBagByQrScanToken(
            tx,
            card.scanToken,
          );
          if (!inventoryLinkForResume?.inventoryBagId) {
            throw new Error(
              "Bag is already finalized — this QR is not linked to received inventory.",
            );
          }
          const [invRow] = await tx
            .select({ status: inventoryBags.status })
            .from(inventoryBags)
            .where(eq(inventoryBags.id, inventoryLinkForResume.inventoryBagId))
            .limit(1);
          const sessionRows = await tx
            .select({
              allocationStatus: rawBagAllocationSessions.allocationStatus,
              endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
              closedAt: rawBagAllocationSessions.closedAt,
            })
            .from(rawBagAllocationSessions)
            .where(
              eq(
                rawBagAllocationSessions.inventoryBagId,
                inventoryLinkForResume.inventoryBagId,
              ),
            )
            .orderBy(desc(rawBagAllocationSessions.openedAt));

          if (
            !canResumeFinalizedWorkflowOnInventoryBag({
              inventoryStatus: invRow?.status ?? "",
              sessions: sessionRows as PartialBagSession[],
            })
          ) {
            throw new Error(
              "Bag is already finalized — scan a fresh card to start a new bag.",
            );
          }

          // P1-PARTIAL — finalized-bag resume is a partial reuse too:
          // confirmation + LOW-confidence supervisor gate.
          await enforcePartialReuseConfirmation(tx, {
            inventoryBagId: inventoryLinkForResume.inventoryBagId,
            stationId: station.id,
            confirmed: partialReuseConfirmed,
            supervisorCode: partialReuseSupervisorCode,
          });

          // Partial-bag resume: new workflow_bag; never copy product_id from
          // the finalized bag. Product is chosen at first-op or sealing.
          const productLookup = pickedProductId
            ? (
                await tx
                  .select({
                    id: products.id,
                    sku: products.sku,
                    name: products.name,
                    kind: products.kind,
                    isActive: products.isActive,
                  })
                  .from(products)
                  .where(eq(products.id, pickedProductId))
              )[0] ?? null
            : null;
          // Partial-bag resume is semantically a fresh start —
          // treat as IDLE for first-op product gating.
          if (!FRESH_BAG_STATION_KINDS.has(station.kind)) {
            throw new Error(
              "This station does not start fresh bags. Scan a bag that has already been released to this station.",
            );
          }
          const firstOp = checkFirstOpProductSelection({
            stationKind: station.kind,
            cardStatus: "IDLE",
            pickedProductId,
            product: productLookup,
          });
          if (!firstOp.ok) throw new Error(firstOp.reason);

          const resumeReadiness = await evaluateQrCardReadinessById(tx, cardId);
          if (!resumeReadiness) throw new Error("Card not found.");
          if (resumeReadiness.level === "BLOCKED") {
            throw new Error(floorReadinessOperatorMessage(resumeReadiness));
          }

          const productIdToSet = firstOp.productId;
          const inventoryLink = await lookupInventoryBagByQrScanToken(
            tx,
            card.scanToken,
          );
          if (!inventoryLink?.inventoryBagId) {
            throw new Error(floorReadinessOperatorMessage(resumeReadiness));
          }
          const [resumeBag] = await tx
            .insert(workflowBags)
            .values({
              ...(productIdToSet ? { productId: productIdToSet } : {}),
              inventoryBagId: inventoryLink.inventoryBagId,
            })
            .returning();
          if (!resumeBag) throw new Error("Could not create workflow bag for partial-bag resume.");

          await tx
            .update(qrCards)
            .set({ assignedWorkflowBagId: resumeBag.id })
            .where(eq(qrCards.id, cardId));

          await projectEvent(tx, {
            workflowBagId: resumeBag.id,
            stationId: station.id,
            eventType: "CARD_ASSIGNED",
            payload: {
              qr_card_id: cardId,
              station_kind: station.kind,
              inventory_bag_id: inventoryLink.inventoryBagId,
              tablet_type_id: inventoryLink.tabletTypeId,
            },
            enteredByUserId: accountability.enteredByUserId,
            accountableEmployeeId: accountability.accountableEmployeeId,
            accountabilitySource: accountability.accountabilitySource,
            accountableEmployeeNameSnapshot:
              accountability.accountableEmployeeNameSnapshot,
          });
          if (productIdToSet && productLookup) {
            await projectEvent(tx, {
              workflowBagId: resumeBag.id,
              stationId: station.id,
              eventType: "PRODUCT_MAPPED",
              payload: {
                product_id: productIdToSet,
                product_sku: productLookup.sku,
                product_name: productLookup.name,
                product_kind: productLookup.kind,
                station_kind: station.kind,
                source: "FIRST_OPERATION_SELECTION",
              },
              enteredByUserId: accountability.enteredByUserId,
              accountableEmployeeId: accountability.accountableEmployeeId,
              accountabilitySource: accountability.accountabilitySource,
              accountableEmployeeNameSnapshot:
                accountability.accountableEmployeeNameSnapshot,
            });
          }
          await writeAudit(
            {
              actorId: null,
              actorRole: null,
              action: "floor.card_assigned",
              targetType: "WorkflowBag",
              targetId: resumeBag.id,
              after: {
                card_id: cardId,
                station_id: stationId,
                product_id: productIdToSet,
                product_sku: productLookup?.sku ?? null,
              },
            },
            tx,
          );
          {
            const alloc = await ensureOpenRawBagAllocationSessionForWorkflowBag(tx, {
              inventoryBagId: inventoryLink.inventoryBagId,
              workflowBagId: resumeBag.id,
              ...(productIdToSet ? { productId: productIdToSet } : {}),
            });
            if (!alloc.ok)
              raiseAllocationOpenFailure(alloc, {
                inventoryBagId: inventoryLink.inventoryBagId,
                cardId,
              });
          }
          return;
        }
        const resumeStages = STATION_STARTED_RESUME_FROM_STAGE[station.kind] ?? [];
        if (state?.stage && resumeStages.includes(state.stage)) {
          const [otherPin] = await tx
            .select({ stationId: readStationLive.stationId })
            .from(readStationLive)
            .where(
              and(
                eq(readStationLive.currentWorkflowBagId, bagId),
                ne(readStationLive.stationId, station.id),
              ),
            )
            .limit(1);
          if (otherPin) {
            throw new Error(
              "This bag is already in progress at another station. Ask a supervisor to check the bag assignment.",
            );
          }
          const [live] = await tx
            .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
            .from(readStationLive)
            .where(eq(readStationLive.stationId, station.id));
          if (live?.currentWorkflowBagId !== bagId) {
            await projectEvent(tx, {
              workflowBagId: bagId,
              stationId: station.id,
              eventType: "BAG_PICKED_UP",
              payload: {
                qr_card_id: cardId,
                station_kind: station.kind,
                from_stage: state.stage,
                same_station_resume: true,
              },
              enteredByUserId: accountability.enteredByUserId,
              accountableEmployeeId: accountability.accountableEmployeeId,
              accountabilitySource: accountability.accountabilitySource,
              accountableEmployeeNameSnapshot:
                accountability.accountableEmployeeNameSnapshot,
            });
            await writeAudit(
              {
                actorId: null,
                actorRole: null,
                action: "floor.bag_resumed",
                targetType: "WorkflowBag",
                targetId: bagId,
                after: {
                  card_id: cardId,
                  station_id: stationId,
                  from_stage: state.stage,
                },
              },
              tx,
            );
          }
          return;
        }
        const allowedStages =
          STATION_PICKUP_FROM_STAGE[station.kind] ?? [];
        const bagEventRows = await tx
          .select({
            eventType: workflowEvents.eventType,
            payload: workflowEvents.payload,
          })
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowBagId, bagId));
        const bagEventSlices = bagEventRows.map((row) => ({
          eventType: row.eventType,
          payload: (row.payload as Record<string, unknown> | null) ?? null,
        }));
        // P2-FINISHING-RECLAIM-1: a finishing station may claim a bag at
        // SEALED that the OTHER finishing station handled, but never one
        // whose own step already fired. Such a pin is a dead end: complete
        // is refused server-side (bottleFinishingAlreadyFired), the manual
        // release/finalize buttons are gone (P2-AUTO-ADVANCE-1), and the
        // scan form does not render while the station holds a bag — the
        // machine would sit blocked until packaging finalized the bag.
        // Refuse the pickup instead, naming what the bag is actually
        // waiting on.
        const ownFinishingEvent =
          FINISHING_COMPLETE_EVENT_BY_STATION_KIND[station.kind];
        if (ownFinishingEvent) {
          const finishingPriorTypes = bagEventSlices.map((e) => e.eventType);
          if (finishingPriorTypes.some((t) => t === ownFinishingEvent)) {
            const stillMissing = missingBottleFinishingSteps(finishingPriorTypes);
            const waitingFor =
              stillMissing.length > 0 ? stillMissing.join(" and ") : "packaging";
            throw new Error(
              `This bag has already been ${
                FINISHING_DONE_LABEL_BY_STATION_KIND[station.kind] ?? "finished"
              } here — it is waiting for ${waitingFor}.`,
            );
          }
        }
        const partialPackagingResume =
          station.kind === "SEALING" &&
          isWorkflowBagResumableAtSealingAfterPartialPackaging(bagEventSlices, {
            stage: state?.stage,
            isFinalized: state?.isFinalized ?? false,
          });
        if (
          partialPackagingResume &&
          (!state?.stage || !allowedStages.includes(state.stage))
        ) {
          const [otherPin] = await tx
            .select({ stationId: readStationLive.stationId })
            .from(readStationLive)
            .where(
              and(
                eq(readStationLive.currentWorkflowBagId, bagId),
                ne(readStationLive.stationId, station.id),
              ),
            )
            .limit(1);
          if (otherPin) {
            throw new Error(
              "This bag is already in progress at another station. Ask a supervisor to check the bag assignment.",
            );
          }
          await projectEvent(tx, {
            workflowBagId: bagId,
            stationId: station.id,
            eventType: "BAG_PICKED_UP",
            payload: {
              qr_card_id: cardId,
              station_kind: station.kind,
              from_stage: state?.stage ?? "PACKAGED",
              partial_packaging_resume: true,
            },
            enteredByUserId: accountability.enteredByUserId,
            accountableEmployeeId: accountability.accountableEmployeeId,
            accountabilitySource: accountability.accountabilitySource,
            accountableEmployeeNameSnapshot:
              accountability.accountableEmployeeNameSnapshot,
          });
          await writeAudit(
            {
              actorId: null,
              actorRole: null,
              action: "floor.bag_picked_up",
              targetType: "WorkflowBag",
              targetId: bagId,
              after: {
                card_id: cardId,
                station_id: stationId,
                from_stage: state?.stage ?? "PACKAGED",
                partial_packaging_resume: true,
              },
            },
            tx,
          );
          return;
        }
        if (!state?.stage || !allowedStages.includes(state.stage)) {
          throw new Error(
            formatFloorStationBagOpenError({
              stationKind: station.kind,
              bagStage: state?.stage,
              pickupStages: allowedStages,
            }),
          );
        }
        await projectEvent(tx, {
          workflowBagId: bagId,
          stationId: station.id,
          eventType: "BAG_PICKED_UP",
          payload: {
            qr_card_id: cardId,
            station_kind: station.kind,
            from_stage: state.stage,
          },
          enteredByUserId: accountability.enteredByUserId,
          accountableEmployeeId: accountability.accountableEmployeeId,
          accountabilitySource: accountability.accountabilitySource,
          accountableEmployeeNameSnapshot:
            accountability.accountableEmployeeNameSnapshot,
        });
        await writeAudit(
          {
            actorId: null,
            actorRole: null,
            action: "floor.bag_picked_up",
            targetType: "WorkflowBag",
            targetId: bagId,
            after: {
              card_id: cardId,
              station_id: stationId,
              from_stage: state.stage,
            },
          },
          tx,
        );
        return;
      }

      throw new Error(`Card status ${card.status.toLowerCase()} is not scannable.`);
    });
  } catch (err) {
    if (err instanceof PartialReuseConfirmationRequiredError) {
      // Not a failure — the floor shows the partial confirmation panel
      // and re-submits with confirmPartialReuse=true.
      return {
        partialReuseConfirmationRequired: true,
        partialContext: err.context,
      };
    }
    if (err instanceof OpenAllocationBlockError) {
      // SPLIT-BAG-1 — the start rolled back; surface a structured "Use
      // calculated remaining" panel (or a precise manual reason) to the floor.
      const resolution = await computeSystemDerivedResolutionForBag(
        err.inventoryBagId,
      );
      return {
        openAllocationBlock: buildFloorOpenAllocationBlock({
          inventoryBagId: err.inventoryBagId,
          cardId: err.cardId,
          resolution,
        }),
      };
    }
    return { error: err instanceof Error ? err.message : "Scan failed." };
  }

  try {
    revalidatePath(`/floor/${token}`);
    revalidatePath(`/floor-board`);
  } catch {
    // Cache invalidation failure is non-fatal; client will see fresh data on next hard refresh.
  }
  return { ok: true };
}

// ── sealing product save ──────────────────────────────────────────────────

const saveSealingProductSchema = z.object({
  token: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  productId: z.string().uuid(),
  clientEventId: clientEventIdField,
  overrideEmployeeCode: z.string().max(40).optional().nullable(),
});

/** Persist finished product at sealing before segment/close-out work. */
export async function saveSealingProductAction(
  formData: FormData,
): Promise<
  { error?: string; ok?: true; openAllocationBlock?: FloorOpenAllocationBlock } | void
> {
  const parsed = saveSealingProductSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    productId: formData.get("productId"),
    clientEventId: pickClientEventId(formData),
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input." };

  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    // ASSIGN-PRODUCT-EXTRACT-1: the guard sequence + transaction body now
    // lives in lib/production/engine/assign-bag-product.ts so the
    // production engine and this action run one implementation. Moved
    // verbatim — see that module's header.
    const result = await assignBagProduct({
      station,
      workflowBagId: parsed.data.workflowBagId,
      productId: parsed.data.productId,
      clientEventId: parsed.data.clientEventId,
      overrideEmployeeCode: parsed.data.overrideEmployeeCode,
    });
    if ("openAllocationBlock" in result) {
      return { openAllocationBlock: result.openAllocationBlock };
    }
    if ("error" in result) return { error: result.error };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not save product.",
    };
  }

  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── SPLIT-BAG-1 — floor "Use calculated remaining" (lead-gated) ──────

const resolveScannedBagSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  inventoryBagId: z.string().uuid(),
  leadCode: z.string().min(1).max(40),
});

/** Lead-gated: close the prior run's OPEN allocation on this physical bag using
 *  system-derived remaining (from production output), so the bag is ready to
 *  reuse — invoked from the floor open-allocation panel. Explicit action, never
 *  silent. Reuses the SAME shared resolution service as the admin workbench.
 *
 *  Floor auth is a station scan-token (no user session), so the lead gate is a
 *  supervisor badge code resolved via resolveStationAccountability — a normal
 *  operator (no lead badge) cannot close the ledger. */
export async function resolveScannedBagAllocationAction(
  formData: FormData,
): Promise<
  | { ok: true; remaining: number; depleted: boolean }
  | { ok: false; error: string }
> {
  const parsed = resolveScannedBagSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    inventoryBagId: formData.get("inventoryBagId"),
    leadCode: formData.get("leadCode"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Enter the lead badge code to use the calculated remaining." };
  }
  try {
    await authStation(parsed.data.token, parsed.data.stationId);

    // Lead/supervisor gate — resolve the badge to a real employee.
    let leadEmployeeId: string | null = null;
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.leadCode,
        sourceHint: "SUPERVISOR_OVERRIDE",
      });
      if (!accountability.accountableEmployeeId) {
        throw new Error(
          "Lead badge code not recognized — a lead is required to use the calculated remaining.",
        );
      }
      leadEmployeeId = accountability.accountableEmployeeId;
    });

    const result = await resolveAllocationFromProductionOutput({
      inventoryBagId: parsed.data.inventoryBagId,
      actor: { id: leadEmployeeId, role: null },
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(`/floor/${parsed.data.token}`);
    revalidatePath(`/floor-board`);
    revalidatePath("/partial-bags");
    return {
      ok: true,
      remaining: result.derivedRemainingTablets,
      depleted: result.depleted,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not use calculated remaining.",
    };
  }
}

// ── BOTTLE-SEALING-RECOVERY-1 — clear a stale bottle sealing hold ────
//
// A bottle bag can reach the Packaging station still at stage BLISTERED when
// the cap-seal / sticker completion events were never recorded (bag physically
// moved on without a scan). Packaging then blocks (needs SEALED + both bottle
// finishing steps). This lead-gated recovery records the MISSING bottle
// finishing completion(s) — advancing the bag to SEALED so packaging unlocks —
// and does NOT touch the raw-bag allocation session or the QR card.

const recoverBottleSealingSchema = z.object({
  token: z.string(),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  leadCode: z.string().min(1).max(40),
  note: z.string().min(3).max(500),
});

export async function recoverBottleSealingHoldAction(
  formData: FormData,
): Promise<{ ok: true; unlocked: boolean } | { ok: false; error: string }> {
  const parsed = recoverBottleSealingSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    leadCode: formData.get("leadCode"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Enter the lead badge code and a note to clear the hold." };
  }
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    // Only the terminal packaging step offers this recovery.
    if (!STATIONS_THAT_FINALIZE.has(station.kind)) {
      return { ok: false, error: "Clearing a bottle sealing hold is only available at the packaging station." };
    }

    let result: { ok: true; unlocked: boolean } | { ok: false; error: string } = {
      ok: false,
      error: "Recovery failed.",
    };
    await db.transaction(async (tx) => {
      // Lead/supervisor gate — a normal operator cannot clear the hold.
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.leadCode,
        sourceHint: "SUPERVISOR_OVERRIDE",
      });
      if (!accountability.accountableEmployeeId) {
        result = {
          ok: false,
          error: "Lead badge code not recognized — a lead is required to clear the sealing hold.",
        };
        return;
      }

      const [row] = await tx
        .select({
          productKind: products.kind,
          stage: readBagState.stage,
          isFinalized: readBagState.isFinalized,
          bagQrCode: qrCards.scanToken,
        })
        .from(workflowBags)
        .leftJoin(products, eq(products.id, workflowBags.productId))
        .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
        .leftJoin(qrCards, eq(qrCards.assignedWorkflowBagId, workflowBags.id))
        .where(eq(workflowBags.id, parsed.data.workflowBagId))
        .limit(1);
      if (!row) {
        result = { ok: false, error: "Workflow bag not found." };
        return;
      }
      // Product-kind aware: only bottle bags use the cap-seal / sticker route.
      if (row.productKind !== "BOTTLE") {
        result = { ok: false, error: "This recovery only applies to bottle products." };
        return;
      }
      if (row.isFinalized) {
        result = { ok: false, error: "Bag is already finalized." };
        return;
      }
      // Must be at a bottle-finishing-eligible stage (picked up at packaging).
      if (row.stage !== "BLISTERED" && row.stage !== "SEALED") {
        result = {
          ok: false,
          error: `Bag is at stage ${row.stage ?? "unknown"} — it hasn't reached bottle finishing yet.`,
        };
        return;
      }

      const priorTypes = (
        await tx
          .select({ eventType: workflowEvents.eventType })
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowBagId, parsed.data.workflowBagId))
      ).map((r) => r.eventType);
      if (bothBottleFinishingDone(priorTypes)) {
        result = {
          ok: false,
          error: "Bottle sealing is already marked complete — there is nothing stale to clear.",
        };
        return;
      }

      // Record ONLY the missing finishing completion(s). projectEvent advances
      // the stage to SEALED and updates read models — the same path a real scan
      // uses. Allocation session + QR card are deliberately untouched.
      const missing = BOTTLE_FINISHING_EVENTS.filter((e) => !priorTypes.includes(e));
      for (const eventType of missing) {
        await projectEvent(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: parsed.data.stationId,
          eventType,
          payload: {
            recovery: true,
            recovery_source: "PACKAGING_STATION_RECOVERY",
            recovery_reason: "STALE_BOTTLE_SEALING_HOLD_CLEARED",
            recovery_note: parsed.data.note.trim(),
            prior_stage: row.stage ?? null,
          },
          accountabilitySource: "SUPERVISOR_OVERRIDE",
          ...(accountability.accountableEmployeeId
            ? { accountableEmployeeId: accountability.accountableEmployeeId }
            : {}),
          ...(accountability.accountableEmployeeNameSnapshot
            ? { accountableEmployeeNameSnapshot: accountability.accountableEmployeeNameSnapshot }
            : {}),
          ...(accountability.enteredByUserId
            ? { enteredByUserId: accountability.enteredByUserId }
            : {}),
        });
      }

      await writeAudit(
        {
          actorId: accountability.enteredByUserId ?? null,
          actorRole: null,
          action: "packaging.recover_bottle_sealing_hold",
          targetType: "WorkflowBag",
          targetId: parsed.data.workflowBagId,
          after: {
            recovery_source: "PACKAGING_STATION_RECOVERY",
            reason: "STALE_BOTTLE_SEALING_HOLD_CLEARED",
            workflow_bag_id: parsed.data.workflowBagId,
            card_qr: row.bagQrCode ?? null,
            previous_stage: row.stage ?? null,
            previous_status: row.isFinalized ? "FINALIZED" : "IN_PROGRESS",
            cleared_events: missing,
            lead_employee_id: accountability.accountableEmployeeId,
            lead_employee_name: accountability.accountableEmployeeNameSnapshot ?? null,
            note: parsed.data.note.trim(),
          },
        },
        tx,
      );
      result = { ok: true, unlocked: true };
    });

    if (result.ok) {
      revalidatePath(`/floor/${parsed.data.token}`);
      revalidatePath(`/floor-board`);
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not clear the sealing hold.",
    };
  }
}

// P6 Task 4 — fireStageEventAction retired. It was a forwarder to
// recordStageEvent (lib/production/engine/record-stage-event.ts) after the
// P4a extraction and had no live callers post P4b cutover. All stage-event
// gestures now flow through operator-actions / operator-screen to
// recordStageEvent directly; the engine module owns the guard sequence and
// transaction body plus its own tests. See docs/superpowers/plans/2026-08-17
// -production-engine-p6.md Task 4.

// ── pause / resume ─────────────────────────────────────────────────────────

const pauseSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  // P3-FLOOR-UX — pvc_swap/foil_swap removed: roll changes use the
  // dedicated roll workflow. Historical pause events keep old reasons.
  reason: z.enum([
    "shift_end",
    "shift_break",
    "machine_jam",
    "qa_check",
    "other",
  ]),
  counterSnapshotCount: z
    .preprocess((value) => {
      if (value == null || value === "") return undefined;
      return parseNonnegativeIntegerInput(value);
    }, z.number().int().nonnegative().optional()),
  // P3-FLOOR-UX — packaging pause counts. The packaging station prompts
  // for the key in-progress counts at pause; logged on the BAG_PAUSED
  // payload for metrics (optional — a break never blocks on them).
  pauseMasterCases: z.coerce.number().int().min(0).max(100000).optional(),
  pauseDisplaysMade: z.coerce.number().int().min(0).max(100000).optional(),
  pauseLooseCards: z.coerce.number().int().min(0).max(100000).optional(),
  operatorCode: z.string().max(40).optional(),
  notes: z.string().max(400).optional(),
  clientEventId: clientEventIdField,
});

export async function pauseBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = pauseSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    reason: formData.get("reason") || "other",
    counterSnapshotCount: formData.get("counterSnapshotCount") || undefined,
    pauseMasterCases: formData.get("pauseMasterCases") || undefined,
    pauseDisplaysMade: formData.get("pauseDisplaysMade") || undefined,
    pauseLooseCards: formData.get("pauseLooseCards") || undefined,
    operatorCode: formData.get("operatorCode") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    const requiresCounterSnapshot = stationRequiresBlisterCounterSnapshot(
      station.kind,
      parsed.data.reason,
    );
    if (
      requiresCounterSnapshot &&
      parsed.data.counterSnapshotCount == null
    ) {
      return {
        error: pauseCounterSnapshotMissingError(parsed.data.reason),
      };
    }
    // Refuse double-pause — second BAG_PAUSED corrupts the
    // pause-time accumulation in the projector.
    const [state] = await db
      .select({ isPaused: readBagState.isPaused, isFinalized: readBagState.isFinalized })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (state?.isFinalized) return { error: "Bag is already finalized." };
    if (state?.isPaused) return { error: "Bag is already paused." };

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.operatorCode ?? null,
      });
      const segmentReason =
        parsed.data.reason === "shift_end"
          ? "SHIFT_END_SNAPSHOT"
          : "PAUSE_SNAPSHOT";
      const counterSnapshotCount = parsed.data.counterSnapshotCount ?? null;
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_PAUSED",
        payload: {
          reason: parsed.data.reason,
          ...(requiresCounterSnapshot
            ? {
                counter_snapshot_count: counterSnapshotCount,
                counter_snapshot_reason: segmentReason,
                counter_snapshot_unit: "good_blisters_since_last_reset",
                counter_snapshot_source: "operator_entry",
              }
            : {}),
          // P3-FLOOR-UX — packaging in-progress counts at pause time.
          ...(parsed.data.pauseMasterCases != null ||
          parsed.data.pauseDisplaysMade != null ||
          parsed.data.pauseLooseCards != null
            ? {
                pause_counts: {
                  master_cases: parsed.data.pauseMasterCases ?? null,
                  displays_made: parsed.data.pauseDisplaysMade ?? null,
                  loose_cards: parsed.data.pauseLooseCards ?? null,
                },
              }
            : {}),
          ...(parsed.data.operatorCode
            ? { operator_code: parsed.data.operatorCode }
            : {}),
          ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
        },
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
      if (
        requiresCounterSnapshot &&
        counterSnapshotCount != null &&
        counterSnapshotCount > 0
      ) {
        await assertCounterSnapshotAllowed(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: parsed.data.stationId,
          context:
            parsed.data.reason === "shift_end"
              ? "pause_shift_end"
              : "pause_machine_jam",
          submittedCount: counterSnapshotCount,
          allowZero: false,
          requirePositive: false,
        });
        await recordBlisterCounterRollSegment(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: parsed.data.stationId,
          counterSegmentCount: counterSnapshotCount,
          segmentReason,
          source: "floor.pause_snapshot",
          sourceAction:
            parsed.data.reason === "shift_end"
              ? "shift_end_pause_snapshot"
              : "machine_jam_pause_snapshot",
          notes: parsed.data.notes ?? null,
          formClientEventId: parsed.data.clientEventId ?? null,
          accountability,
        });
        await refreshMaterialReadModelsAfterBlister(
          tx,
          parsed.data.stationId,
        );
      }
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Pause failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

const resumeSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().max(40).optional(),
  clientEventId: clientEventIdField,
});

export async function resumeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = resumeSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
    const [state] = await db
      .select({ isPaused: readBagState.isPaused })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (!state?.isPaused) return { error: "Bag isn't paused." };

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.operatorCode ?? null,
      });
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_RESUMED",
        payload: parsed.data.operatorCode
          ? { operator_code: parsed.data.operatorCode }
          : {},
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Resume failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// P6 Task 4 — setOperatorAction retired (no callers post P4b; operator
// handoff runs through operator-session-actions.ts openOperatorSessionAction
// / closeOperatorSessionAction, which emit STATION_OPERATOR_* events with
// full accountability). No engine module owns this shell — the write-path
// safety net for OPERATOR_CHANGE remains in the projector.

// P6 Task 4 — verifyVendorBarcodeAction retired. Zero references anywhere
// (no UI form ever wired to it, no test, no script). If a vendor-barcode
// preflight is later needed it should be built against
// lookupInventoryBagByQrScanToken / batchProductionBlockReason directly
// in the caller.

// P6 Task 4 — packagingCompleteAction retired. It was a forwarder to
// recordPackagingComplete (lib/production/engine/record-packaging-complete
// .ts) after the P4a extraction and had no live callers post P4b cutover.
// Packaging close-out now flows through operator-actions to the engine
// module directly; the engine module owns the guard sequence, transaction
// body, and its own tests. See docs/superpowers/plans/2026-08-17
// -production-engine-p6.md Task 4.

// P6 Task 4 — lookupCardByTokenAction retired along with its private
// loadAssignedPickupScanCandidates / resolveFloorScanLookupRow helpers and
// the FloorScanLookupRow type. Zero non-test callers repo-wide (the operator
// screen's fresh-scan path lives in operator-actions.ts resolveFreshBagStart
// and delegates to scanCardAction). Camera-scanner submissions on the floor
// take the QR scanToken directly to scanCardAction — no server-side text
// lookup step is on the live path.

// P6 Task 4 — finalizeBagAction retired. Zero non-test callers post P4b
// cutover; the packaging close-out engine (record-packaging-complete.ts)
// owns finalize semantics (projectBagFinalizedEvent +
// resolveDeferredQrReleaseAfterPackaging) and drives them via the auto-
// finalize hook after PACKAGING_COMPLETE. Manual finalize as a floor
// gesture no longer exists in the P4b UI.

// P6 Task 4 — releaseSealingHandoffAction, releaseBagAction, and the
// private projectSealingStationHandoff / releaseSchema / sealingHandoffSchema
// / DbTx / StationAccountability helpers retired. Zero non-test callers repo-
// wide (P4b's operator screen releases through the engine's auto-release
// hooks after each stage event; sealing hand-off is emitted from
// recordStageEvent's segment path, not a separate action). BAG_RELEASED
// projections still live in record-stage-event.ts and are chained
// automatically on completion.
