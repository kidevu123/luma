"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, or, sql, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  machines,
  workflowBags,
  inventoryBags,
  batches,
  readBagState,
  readStationLive,
  products,
  productAllowedTablets,
  rawBagAllocationSessions,
  workflowEvents,
} from "@/lib/db/schema";
import { isPartialBagResume } from "@/lib/production/bag-allocation";
import { classifyFloorScanCard } from "@/lib/production/floor-scan-eligibility";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import {
  STATION_RELEASE_FROM_STAGE,
  STATION_PICKUP_FROM_STAGE,
  STATIONS_THAT_FINALIZE,
} from "@/lib/production/stage-progression";
import { emitCountBasedPackagingConsumption } from "@/lib/projector/packaging-consumption-hook";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  computeSealedCountFromCounter,
  resolveSealingCardsPerPress,
  SEALING_COUNTER_CONFIG_ERROR,
  SEALING_COUNTER_PRESS_ERROR,
  stationUsesSealingCounter,
} from "@/lib/production/sealing-counter";
import {
  lookupProductMatchedBlisterCardLot,
  issueHandpackBlisterCardMaterial,
  workflowBagHasHandpackBlisterComplete,
  type HandpackBlisterMaterialSkipReason,
} from "@/lib/production/handpack-seal-material";

// First-op count submissions where accountability is mandatory (the
// queue stop condition: refuse a fresh blister/handpack count when
// nobody owns it). All other events soft-fall-through.
const FIRST_OP_COUNT_EVENTS: ReadonlySet<string> = new Set([
  "BLISTER_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
]);

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

// Floor PWA actions are anonymous (no admin login). Authorization is
// the station's scan_token, which lives in the URL. Every action MUST
// take the token, look up the station, and then refuse if the
// stationId in the form doesn't match the URL's station — otherwise
// any anonymous client could POST events to any station by hand.

type StationRow = typeof stations.$inferSelect;

/** Resolve and lock a station by its URL scan token. Returns null
 *  if no match — caller should reject the request. */
async function resolveStation(token: string): Promise<StationRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return null;
  }
  const [row] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  return row ?? null;
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

// Allowed event types per station kind. SEALING can't fire blister,
// PACKAGING can't fire bottle stages, etc. COMBINED is permissive
// (still card flow only).
const ALLOWED_EVENTS_BY_KIND: Record<string, string[]> = {
  BLISTER: ["BLISTER_COMPLETE"],
  HANDPACK_BLISTER: ["HANDPACK_BLISTER_COMPLETE"],
  SEALING: ["SEALING_COMPLETE"],
  PACKAGING: ["PACKAGING_SNAPSHOT", "PACKAGING_COMPLETE"],
  BOTTLE_HANDPACK: ["BOTTLE_HANDPACK_COMPLETE"],
  BOTTLE_CAP_SEAL: ["BOTTLE_CAP_SEAL_COMPLETE"],
  BOTTLE_STICKER: ["BOTTLE_STICKER_COMPLETE"],
  COMBINED: [
    "BLISTER_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "PACKAGING_COMPLETE",
  ],
};

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
});

export async function scanCardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = scanSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    cardId: formData.get("cardId"),
    productId: formData.get("productId") || undefined,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { token, stationId, cardId, overrideEmployeeCode } = parsed.data;
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

      if (card.status === "IDLE") {
        throw new Error(
          "This bag QR has not been linked to a received bag. Use the Receive Pills page to receive the bag before starting production.",
        );
      }

      if (card.status === "ASSIGNED" && !card.assignedWorkflowBagId) {
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

        const productIdToSet = firstOp.productId; // null when not first-op
        const [bag] = await tx
          .insert(workflowBags)
          .values(productIdToSet ? { productId: productIdToSet } : {})
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
          payload: { qr_card_id: cardId, station_kind: station.kind },
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
        if (state?.isFinalized) {
          // Check for a partial-bag resume: QR was held because the prior
          // allocation session closed with remaining tablets.
          const [heldSession] = await tx
            .select({
              allocationStatus: rawBagAllocationSessions.allocationStatus,
              endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
            })
            .from(rawBagAllocationSessions)
            .where(eq(rawBagAllocationSessions.workflowBagId, bagId))
            .orderBy(desc(rawBagAllocationSessions.openedAt))
            .limit(1);

          if (!isPartialBagResume(heldSession ?? null)) {
            throw new Error(
              "Bag is already finalized — scan a fresh card to start a new bag.",
            );
          }

          // Partial-bag resume: same as a fresh IDLE scan — create a new
          // workflow_bag and reassign the QR to it. The prior allocation
          // session's endingBalanceQty becomes the starting balance for the
          // next openAllocationSessionAction call.
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

          const productIdToSet = firstOp.productId;
          const [resumeBag] = await tx
            .insert(workflowBags)
            .values(productIdToSet ? { productId: productIdToSet } : {})
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
            payload: { qr_card_id: cardId, station_kind: station.kind },
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
          return;
        }
        const allowedStages =
          STATION_PICKUP_FROM_STAGE[station.kind] ?? [];
        if (!state?.stage || !allowedStages.includes(state.stage)) {
          const list = allowedStages.length === 0
            ? "no pickup stages defined"
            : allowedStages.join(" or ");
          throw new Error(
            `${station.kind} station expects bag at ${list} (bag is ${state?.stage ?? "unknown"}).`,
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

// ── stage events ───────────────────────────────────────────────────────────

const eventSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  eventType: z.enum([
    "BLISTER_COMPLETE",
    "HANDPACK_BLISTER_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "BOTTLE_HANDPACK_COMPLETE",
    "BOTTLE_CAP_SEAL_COMPLETE",
    "BOTTLE_STICKER_COMPLETE",
  ]),
  countTotal: z.coerce.number().int().min(0).max(100000).optional(),
  /** SEALING-COUNTER-1: machine counter presses for SEALING_COMPLETE. */
  counterPresses: z.coerce.number().int().min(0).max(100000).optional(),
  /** Cards/packs that started the station run but weren't completed
   *  into a full unit — loose cards at sealing, partial blister sheets,
   *  etc. Stored in the event payload for reconciliation. */
  packsRemaining: z.coerce.number().int().min(0).max(100000).optional(),
  /** Cards that were opened/damaged and returned to the prior stage
   *  or scrapped. Stored in the event payload for loss tracking. */
  cardsReopened: z.coerce.number().int().min(0).max(100000).optional(),
  /** PRODUCT-SELECTION-AT-SEALING-1: required on SEALING_COMPLETE when
   *  workflow_bags.product_id is still null. Ignored when product exists. */
  productId: z.string().uuid().optional().nullable().or(z.literal("")),
  clientEventId: clientEventIdField,
  /** OP-1C per-form supervisor override. Resolved by the
   *  station-operator-session helper; falls back to the active
   *  session when omitted. */
  overrideEmployeeCode: z.string().max(40).optional().nullable(),
});

import { checkStageProgression } from "@/lib/production/stage-progression";
import { checkPackagingPrereqs } from "@/lib/production/packaging-prereqs";
import {
  FIRST_OP_STATION_KINDS,
  checkFirstOpProductSelection,
} from "@/lib/production/first-op-product";
import {
  SEALING_STATION_KINDS,
  validateSealingProductPick,
} from "@/lib/production/sealing-product";

export async function fireStageEventAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = eventSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    eventType: formData.get("eventType"),
    countTotal: formData.get("countTotal") || 0,
    counterPresses: formData.get("counterPresses") ?? undefined,
    packsRemaining: formData.get("packsRemaining") || 0,
    cardsReopened: formData.get("cardsReopened") || 0,
    clientEventId: pickClientEventId(formData),
    productId: formData.get("productId") || undefined,
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const {
    token,
    workflowBagId,
    stationId,
    eventType,
    countTotal,
    counterPresses,
    packsRemaining,
    cardsReopened,
    clientEventId,
    overrideEmployeeCode,
  } = parsed.data;
  const pickedSealingProductId =
    parsed.data.productId && parsed.data.productId !== ""
      ? parsed.data.productId
      : null;

  try {
    const station = await authStation(token, stationId);
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

    let resolvedCountTotal = countTotal;
    let sealingCounterPresses: number | undefined;
    let sealingCardsPerPress: number | undefined;

    if (
      eventType === "SEALING_COMPLETE" &&
      stationUsesSealingCounter(station.kind)
    ) {
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
      eventType === "SEALING_COMPLETE" &&
      SEALING_STATION_KINDS.has(station.kind)
    ) {
      if (bagProductRow?.productId) {
        if (
          pickedSealingProductId &&
          pickedSealingProductId !== bagProductRow.productId
        ) {
          return {
            error:
              "Product is already set on this bag and cannot be changed here.",
          };
        }
      } else if (!pickedSealingProductId) {
        return {
          error:
            "Select the finished product before completing sealing.",
        };
      }
    }

    const needsHandpackBlisterMaterial =
      eventType === "SEALING_COMPLETE" &&
      station.kind === "SEALING" &&
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

      if (
        eventType === "SEALING_COMPLETE" &&
        SEALING_STATION_KINDS.has(station.kind) &&
        !bagProductRow?.productId &&
        pickedSealingProductId
      ) {
        const [productLookup] = await tx
          .select({
            id: products.id,
            sku: products.sku,
            name: products.name,
            kind: products.kind,
            isActive: products.isActive,
          })
          .from(products)
          .where(eq(products.id, pickedSealingProductId));

        const [rawContext] = await tx
          .select({ tabletTypeId: inventoryBags.tabletTypeId })
          .from(qrCards)
          .leftJoin(
            inventoryBags,
            eq(inventoryBags.bagQrCode, qrCards.scanToken),
          )
          .where(eq(qrCards.assignedWorkflowBagId, workflowBagId))
          .limit(1);

        const tabletRows = await tx
          .select({ tabletTypeId: productAllowedTablets.tabletTypeId })
          .from(productAllowedTablets)
          .where(eq(productAllowedTablets.productId, pickedSealingProductId));

        const sealingPick = validateSealingProductPick({
          stationKind: station.kind,
          pickedProductId: pickedSealingProductId,
          product: productLookup ?? null,
          tabletTypeId: rawContext?.tabletTypeId ?? null,
          allowedTabletTypeIds: tabletRows.map((r) => r.tabletTypeId),
        });
        if (!sealingPick.ok) {
          throw new Error(sealingPick.reason);
        }

        await tx
          .update(workflowBags)
          .set({ productId: sealingPick.productId })
          .where(eq(workflowBags.id, workflowBagId));

        await projectEvent(tx, {
          workflowBagId,
          stationId,
          eventType: "PRODUCT_MAPPED",
          payload: {
            product_id: sealingPick.productId,
            product_sku: productLookup?.sku ?? null,
            product_name: productLookup?.name ?? null,
            product_kind: productLookup?.kind ?? null,
            station_kind: station.kind,
            source: "SEALING_SELECTION",
          },
          enteredByUserId: accountability.enteredByUserId,
          accountableEmployeeId: accountability.accountableEmployeeId,
          accountabilitySource: accountability.accountabilitySource,
          accountableEmployeeNameSnapshot:
            accountability.accountableEmployeeNameSnapshot,
        });
      }

      let handpackBlisterLot: { id: string; qtyOnHand: number } | null = null;
      let handpackMaterialSkip: HandpackBlisterMaterialSkipReason | null =
        null;
      if (
        needsHandpackBlisterMaterial &&
        (resolvedCountTotal ?? 0) > 0
      ) {
        const lotLookup = await lookupProductMatchedBlisterCardLot(
          workflowBagId,
          tx,
        );
        if (lotLookup.status === "found") {
          handpackBlisterLot = lotLookup.lot;
        } else {
          handpackMaterialSkip = lotLookup.reason;
        }
      }

      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType,
        payload: {
          ...(eventType === "SEALING_COMPLETE" &&
          stationUsesSealingCounter(station.kind)
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
            : resolvedCountTotal
              ? { count_total: resolvedCountTotal }
              : {}),
          ...(packsRemaining ? { packs_remaining: packsRemaining } : {}),
          ...(cardsReopened ? { cards_reopened: cardsReopened } : {}),
        },
        ...(clientEventId ? { clientEventId } : {}),
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
      if (
        eventType === "SEALING_COMPLETE" &&
        needsHandpackBlisterMaterial &&
        handpackBlisterLot &&
        (resolvedCountTotal ?? 0) > 0
      ) {
        await issueHandpackBlisterCardMaterial(tx, {
          workflowBagId,
          stationId,
          sealedCardCount: resolvedCountTotal ?? 0,
          blisterLot: handpackBlisterLot,
          accountability,
        });
      }
      if (
        eventType === "HANDPACK_BLISTER_COMPLETE" ||
        (eventType === "BLISTER_COMPLETE" && station.kind === "BLISTER") ||
        (eventType === "SEALING_COMPLETE" && station.kind === "SEALING")
      ) {
        await maybeAutoReleaseAfterComplete(tx, {
          workflowBagId,
          stationId,
          stationKind: station.kind,
          clientEventId: clientEventId ?? null,
          accountability,
        });
      }
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Event failed." };
  }
  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── pause / resume ─────────────────────────────────────────────────────────

const pauseSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  reason: z.enum(["pvc_swap", "foil_swap", "shift_end", "machine_jam", "qa_check", "other"]),
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
    operatorCode: formData.get("operatorCode") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
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
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_PAUSED",
        payload: {
          reason: parsed.data.reason,
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

// ── operator handoff ───────────────────────────────────────────────────────

const operatorSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  operatorCode: z.string().min(1).max(40),
});

export async function setOperatorAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = operatorSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    operatorCode: formData.get("operatorCode"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    await authStation(parsed.data.token, parsed.data.stationId);
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.operatorCode,
      });
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "OPERATOR_CHANGE",
        payload: { operator_code: parsed.data.operatorCode },
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot:
          accountability.accountableEmployeeNameSnapshot,
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  return { ok: true };
}

// ── vendor barcode verify (read-only lookup) ──────────────────────────────

const verifySchema = z.object({
  token: z.string(),
  vendorBarcode: z.string().min(1).max(120),
});

export async function verifyVendorBarcodeAction(
  formData: FormData,
): Promise<
  | {
      ok: true;
      inventoryBagId: string;
      tabletName?: string;
      batchNumber?: string;
      batchStatus:
        | "RELEASED"
        | "QUARANTINE"
        | "ON_HOLD"
        | "RECALLED"
        | "EXPIRED"
        | "DEPLETED";
      blocked: boolean;
      reason?: string;
    }
  | { error: string }
> {
  const parsed = verifySchema.safeParse({
    token: formData.get("token"),
    vendorBarcode: formData.get("vendorBarcode"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const station = await resolveStation(parsed.data.token);
  if (!station) return { error: "Invalid station." };
  const code = parsed.data.vendorBarcode.trim();
  let hit = (
    await db
      .select({
        inventoryBagId: inventoryBags.id,
        bagStatus: inventoryBags.status,
        batchId: inventoryBags.batchId,
      })
      .from(inventoryBags)
      .where(eq(inventoryBags.vendorBarcode, code))
      .limit(1)
  )[0];
  if (!hit) {
    const lotMatch = await db
      .select({
        inventoryBagId: inventoryBags.id,
        bagStatus: inventoryBags.status,
        batchId: inventoryBags.batchId,
      })
      .from(inventoryBags)
      .innerJoin(batches, eq(inventoryBags.batchId, batches.id))
      .where(
        and(
          eq(batches.vendorLotNumber, code),
          eq(inventoryBags.status, "AVAILABLE"),
        ),
      )
      .limit(1);
    hit = lotMatch[0];
  }
  if (!hit) return { error: "No inventory bag matches that barcode/lot." };
  if (hit.bagStatus !== "AVAILABLE") {
    return {
      ok: true,
      inventoryBagId: hit.inventoryBagId,
      batchStatus: "QUARANTINE",
      blocked: true,
      reason: `Bag status is ${hit.bagStatus}, not AVAILABLE.`,
    };
  }
  let batchStatus:
    | "RELEASED"
    | "QUARANTINE"
    | "ON_HOLD"
    | "RECALLED"
    | "EXPIRED"
    | "DEPLETED" = "QUARANTINE";
  let batchNumber: string | undefined;
  if (hit.batchId) {
    const [b] = await db
      .select({ status: batches.status, batchNumber: batches.batchNumber })
      .from(batches)
      .where(eq(batches.id, hit.batchId))
      .limit(1);
    if (b) {
      batchStatus = b.status;
      batchNumber = b.batchNumber;
    }
  }
  const blocked = batchStatus !== "RELEASED";
  return {
    ok: true,
    inventoryBagId: hit.inventoryBagId,
    ...(batchNumber ? { batchNumber } : {}),
    batchStatus,
    blocked,
    ...(blocked
      ? { reason: `Batch ${batchNumber ?? ""} is ${batchStatus}, not RELEASED.` }
      : {}),
  };
}

// ── packaging close-out ────────────────────────────────────────────────────

const packagingCompleteSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  masterCases: z.coerce.number().int().min(0).max(100000),
  displaysMade: z.coerce.number().int().min(0).max(100000),
  looseCards: z.coerce.number().int().min(0).max(100000),
  damagedPackaging: z.coerce.number().int().min(0).max(100000),
  rippedCards: z.coerce.number().int().min(0).max(100000),
  operatorCode: z.string().max(40).optional(),
  clientEventId: clientEventIdField,
});

export async function packagingCompleteAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = packagingCompleteSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    masterCases: formData.get("masterCases") || 0,
    displaysMade: formData.get("displaysMade") || 0,
    looseCards: formData.get("looseCards") || 0,
    damagedPackaging: formData.get("damagedPackaging") || 0,
    rippedCards: formData.get("rippedCards") || 0,
    operatorCode: formData.get("operatorCode") || undefined,
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    if (station.kind !== "PACKAGING" && station.kind !== "COMBINED") {
      return {
        error: `Station kind ${station.kind} can't fire PACKAGING_COMPLETE.`,
      };
    }
    // Reject all-zeros — operator probably tapped Save by accident.
    if (
      parsed.data.masterCases +
        parsed.data.displaysMade +
        parsed.data.looseCards +
        parsed.data.damagedPackaging +
        parsed.data.rippedCards ===
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
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    const pkgProg = checkStageProgression({
      eventType: "PACKAGING_COMPLETE",
      currentStage: pkgState?.stage ?? null,
      isPaused: pkgState?.isPaused ?? false,
      isFinalized: pkgState?.isFinalized ?? false,
    });
    if (!pkgProg.allowed) return { error: pkgProg.reason };

    // PRD-2 — Packaging prereq guard. Cannot complete packaging
    // without product + packaging structure: the projector would
    // otherwise silently record unitsYielded=0 (because its product
    // lookup returns nothing), which corrupts PO reconciliation,
    // supplier settlement, and finished-goods inventory.
    const [bagRow] = await db
      .select({ id: workflowBags.id, productId: workflowBags.productId })
      .from(workflowBags)
      .where(eq(workflowBags.id, parsed.data.workflowBagId));
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
              unitsPerDisplay: products.unitsPerDisplay,
              displaysPerCase: products.displaysPerCase,
            })
            .from(products)
            .where(eq(products.id, bagRow.productId))
        )[0] ?? null
      : null;
    const prereq = checkPackagingPrereqs({
      bag: { id: bagRow.id, productId: bagRow.productId ?? null },
      product: productRow ?? null,
    });
    if (!prereq.ok) {
      return { error: prereq.reason };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
        overrideEmployeeCode: parsed.data.operatorCode ?? null,
      });
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "PACKAGING_COMPLETE",
        payload: {
          master_cases: parsed.data.masterCases,
          displays_made: parsed.data.displaysMade,
          loose_cards: parsed.data.looseCards,
          damaged_packaging: parsed.data.damagedPackaging,
          ripped_cards: parsed.data.rippedCards,
          ...(parsed.data.operatorCode
            ? { operator_code: parsed.data.operatorCode }
            : {}),
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
      const consumption = await emitCountBasedPackagingConsumption(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        payload: {
          master_cases: parsed.data.masterCases,
          displays_made: parsed.data.displaysMade,
          loose_cards: parsed.data.looseCards,
          damaged_packaging: parsed.data.damagedPackaging,
          ripped_cards: parsed.data.rippedCards,
        },
        occurredAt: new Date(),
      });
      void consumption;
      if (station.kind === "PACKAGING") {
        await maybeAutoFinalizeAfterPackagingComplete(tx, {
          workflowBagId: parsed.data.workflowBagId,
          stationId: parsed.data.stationId,
          stationKind: station.kind,
          accountability,
          ...(parsed.data.clientEventId
            ? { clientEventId: parsed.data.clientEventId }
            : {}),
        });
      }
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── lookup card by scan token (floor scanner text input) ───────────────────

export async function lookupCardByTokenAction(
  formData: FormData,
): Promise<
  | { ok: true; cardId: string; cardLabel: string; isIntakeReserved: boolean; tabletTypeId: string | null }
  | { error: string }
> {
  const scanToken = formData.get("scanToken");
  if (typeof scanToken !== "string" || !scanToken.trim()) {
    return { error: "No scan token provided." };
  }

  const token = scanToken.trim();
  // QR-SCAN-PAYLOAD-1: new labels encode scanToken (e.g. "bag-card-117").
  // Legacy labels printed before QR-SCAN-PAYLOAD-1 encode qrCards.id (a UUID).
  // Gate the id fallback on UUID format — passing a non-UUID to the UUID id
  // column throws PostgresError 22P02 (string_to_uuid, digest 2676337210).
  // TODO: remove the id fallback once legacy labels are reprinted.
  try {
    const [card] = await db
      .select({
        id: qrCards.id,
        label: qrCards.label,
        cardType: qrCards.cardType,
        status: qrCards.status,
        assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
        tabletTypeId: inventoryBags.tabletTypeId,
      })
      .from(qrCards)
      .leftJoin(inventoryBags, eq(inventoryBags.bagQrCode, qrCards.scanToken))
      .where(
        UUID_RE.test(token)
          ? or(eq(qrCards.scanToken, token), eq(qrCards.id, token))
          : eq(qrCards.scanToken, token),
      )
      .limit(1);

    if (!card) return { error: "Bag QR not found." };

    const classification = classifyFloorScanCard(card);
    if (!classification.eligible) {
      return { error: classification.reason };
    }

    return {
      ok: true,
      cardId: card.id,
      cardLabel: card.label,
      isIntakeReserved: classification.isIntakeReserved,
      tabletTypeId: card.tabletTypeId ?? null,
    };
  } catch (err) {
    console.error("[lookupCardByTokenAction] DB error:", err);
    return { error: "Bag QR lookup failed — please try again." };
  }
}

// ── finalize ───────────────────────────────────────────────────────────────

const finalizeSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  clientEventId: clientEventIdField,
});

export async function finalizeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = finalizeSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success) return { error: "Invalid input." };
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    // Finalize is the END of the production cycle — only stations that
    // close the bag may fire it. Other stations must use Release.
    if (!STATIONS_THAT_FINALIZE.has(station.kind)) {
      return {
        error: `${station.kind} station does not finalize bags. Use "Release to next stage" instead.`,
      };
    }
    const [state] = await db
      .select({
        isFinalized: readBagState.isFinalized,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (state?.isFinalized) return { error: "Bag is already finalized." };
    if (state?.stage !== "PACKAGED") {
      return {
        error: `Bag must be packaged before finalize (currently ${state?.stage ?? "unknown"}).`,
      };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
      });
      await projectBagFinalizedEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        accountability,
        ...(parsed.data.clientEventId
          ? { clientEventId: parsed.data.clientEventId }
          : {}),
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Finalize failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── release to next station ─────────────────────────────────────────────────

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type StationAccountability = Awaited<
  ReturnType<typeof resolveStationAccountability>
>;

/** Shared BAG_FINALIZED projection — used by finalizeBagAction and packaging auto-finalize. */
async function projectBagFinalizedEvent(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    accountability: StationAccountability;
    clientEventId?: string | null | undefined;
  },
): Promise<void> {
  await projectEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    eventType: "BAG_FINALIZED",
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    enteredByUserId: args.accountability.enteredByUserId,
    accountableEmployeeId: args.accountability.accountableEmployeeId,
    accountabilitySource: args.accountability.accountabilitySource,
    accountableEmployeeNameSnapshot:
      args.accountability.accountableEmployeeNameSnapshot,
  });
}

/** Shared BAG_RELEASED projection — used by releaseBagAction and complete auto-release. */
async function projectBagReleasedEvent(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    stationKind: string;
    releasedAtStage: string;
    accountability: StationAccountability;
    clientEventId?: string | null | undefined;
  },
): Promise<void> {
  await projectEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    eventType: "BAG_RELEASED",
    payload: {
      station_kind: args.stationKind,
      released_at_stage: args.releasedAtStage,
    },
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
    enteredByUserId: args.accountability.enteredByUserId,
    accountableEmployeeId: args.accountability.accountableEmployeeId,
    accountabilitySource: args.accountability.accountabilitySource,
    accountableEmployeeNameSnapshot:
      args.accountability.accountableEmployeeNameSnapshot,
  });
}

/** Stations that auto-release on complete — no second operator tap. */
const AUTO_RELEASE_AFTER_COMPLETE_STATION_KINDS = new Set([
  "BLISTER",
  "HANDPACK_BLISTER",
  "SEALING",
]);

/** BLISTER + HANDPACK_BLISTER + SEALING: complete also releases when still pinned. */
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

/** PACKAGING only — close-out also finalizes when still pinned at PACKAGED. */
const AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS = new Set([
  "PACKAGING",
]);

/** PACKAGING: PACKAGING_COMPLETE also finalizes when still pinned. */
async function maybeAutoFinalizeAfterPackagingComplete(
  tx: DbTx,
  args: {
    workflowBagId: string;
    stationId: string;
    stationKind: string;
    clientEventId?: string | null | undefined;
    accountability: StationAccountability;
  },
): Promise<void> {
  if (!AUTO_FINALIZE_AFTER_PACKAGING_COMPLETE_STATION_KINDS.has(args.stationKind)) {
    return;
  }

  const [afterComplete] = await tx
    .select({
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
    })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));
  if (afterComplete?.stage !== "PACKAGED") return;
  if (afterComplete?.isFinalized) return;

  const [live] = await tx
    .select({ currentWorkflowBagId: readStationLive.currentWorkflowBagId })
    .from(readStationLive)
    .where(eq(readStationLive.stationId, args.stationId));
  if (live?.currentWorkflowBagId !== args.workflowBagId) return;

  const finalizeClientEventId = args.clientEventId
    ? `${args.clientEventId}-auto-finalize`
    : undefined;

  await projectBagFinalizedEvent(tx, {
    workflowBagId: args.workflowBagId,
    stationId: args.stationId,
    accountability: args.accountability,
    ...(finalizeClientEventId ? { clientEventId: finalizeClientEventId } : {}),
  });
}

const releaseSchema = z.object({
  token: z.string(),
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  clientEventId: clientEventIdField,
});

/** Hand the bag forward without finalizing it. Clears this station's
 *  read_station_live entry. The QR card stays ASSIGNED to travel
 *  with the bag. The next station picks the bag up by scanning the
 *  same card (scanCardAction handles the ASSIGNED-card path). */
export async function releaseBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = releaseSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    clientEventId: pickClientEventId(formData),
  });
  if (!parsed.success) return { error: "Invalid input." };
  try {
    const station = await authStation(parsed.data.token, parsed.data.stationId);
    const releaseAtStage = STATION_RELEASE_FROM_STAGE[station.kind];
    if (!releaseAtStage) {
      return {
        error: `${station.kind} station does not release bags forward.`,
      };
    }
    const [state] = await db
      .select({
        isFinalized: readBagState.isFinalized,
        isPaused: readBagState.isPaused,
        stage: readBagState.stage,
      })
      .from(readBagState)
      .where(eq(readBagState.workflowBagId, parsed.data.workflowBagId));
    if (state?.isFinalized) return { error: "Bag is already finalized." };
    if (state?.isPaused) {
      return { error: "Bag is paused — resume before releasing." };
    }
    if (state?.stage !== releaseAtStage) {
      return {
        error: `Bag must be at ${releaseAtStage} before release (currently ${state?.stage ?? "unknown"}).`,
      };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: parsed.data.stationId,
      });
      await projectBagReleasedEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        stationKind: station.kind,
        releasedAtStage: state.stage ?? releaseAtStage,
        accountability,
        clientEventId: parsed.data.clientEventId ?? null,
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Release failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}
