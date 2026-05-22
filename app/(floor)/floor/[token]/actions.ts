"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq, and, sql, desc, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  workflowBags,
  inventoryBags,
  batches,
  readBagState,
  products,
  rawBagAllocationSessions,
  packagingLots,
  packagingMaterials,
  workflowEvents,
} from "@/lib/db/schema";
import { isPartialBagResume } from "@/lib/production/bag-allocation";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import {
  STATION_RELEASE_FROM_STAGE,
  STATION_PICKUP_FROM_STAGE,
  STATIONS_THAT_FINALIZE,
} from "@/lib/production/stage-progression";
import { emitCountBasedPackagingConsumption } from "@/lib/projector/packaging-consumption-hook";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";

// First-op count submissions where accountability is mandatory (the
// queue stop condition: refuse a fresh blister/handpack count when
// nobody owns it). All other events soft-fall-through.
const FIRST_OP_COUNT_EVENTS: ReadonlySet<string> = new Set([
  "BLISTER_COMPLETE",
  "BOTTLE_HANDPACK_COMPLETE",
]);

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

      if (card.status === "IDLE" || (card.status === "ASSIGNED" && !card.assignedWorkflowBagId)) {
        // Fresh scan — first-op stations REQUIRE a product pick so
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
        const isFreshStart =
          card.status === "IDLE" ||
          (card.status === "ASSIGNED" && !card.assignedWorkflowBagId);
        if (isFreshStart && !FRESH_BAG_STATION_KINDS.has(station.kind)) {
          throw new Error(
            "This station does not start fresh bags. Scan a bag that has already been released to this station.",
          );
        }
        const firstOp = checkFirstOpProductSelection({
          stationKind: station.kind,
          cardStatus: isFreshStart ? "IDLE" : card.status,
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

  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
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
  /** Cards/packs that started the station run but weren't completed
   *  into a full unit — loose cards at sealing, partial blister sheets,
   *  etc. Stored in the event payload for reconciliation. */
  packsRemaining: z.coerce.number().int().min(0).max(100000).optional(),
  /** Cards that were opened/damaged and returned to the prior stage
   *  or scrapped. Stored in the event payload for loss tracking. */
  cardsReopened: z.coerce.number().int().min(0).max(100000).optional(),
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

export async function fireStageEventAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = eventSchema.safeParse({
    token: formData.get("token"),
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    eventType: formData.get("eventType"),
    countTotal: formData.get("countTotal") || 0,
    packsRemaining: formData.get("packsRemaining") || 0,
    cardsReopened: formData.get("cardsReopened") || 0,
    clientEventId: pickClientEventId(formData),
    overrideEmployeeCode: formData.get("overrideEmployeeCode") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const {
    token,
    workflowBagId,
    stationId,
    eventType,
    countTotal,
    packsRemaining,
    cardsReopened,
    clientEventId,
    overrideEmployeeCode,
  } = parsed.data;

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
      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType,
        payload: {
          ...(countTotal ? { count_total: countTotal } : {}),
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
  reason: z.enum(["pvc_swap", "shift_end", "machine_jam", "qa_check", "other"]),
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
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── lookup card by scan token (floor scanner text input) ───────────────────

/** Resolve a QR scan token to a card ID for the floor scanner text input.
 *  Validates: card exists, is RAW_BAG type, not RETIRED.
 *  Returns the internal card ID on success so the caller can submit via
 *  scanCardAction. Full eligibility (stage, station kind) is checked there. */
export async function lookupCardByTokenAction(
  formData: FormData,
): Promise<{ ok: true; cardId: string } | { error: string }> {
  const scanToken = ((formData.get("scanToken") as string | null) ?? "").trim();
  if (!scanToken) return { error: "Scan token required." };

  const [card] = await db
    .select({ id: qrCards.id, cardType: qrCards.cardType, status: qrCards.status })
    .from(qrCards)
    .where(eq(qrCards.scanToken, scanToken))
    .limit(1);

  if (!card) return { error: "Bag QR not found." };
  if (card.cardType !== "RAW_BAG") {
    return { error: "This is not a bag QR. Scan a bag label (not a variety pack or traveler card)." };
  }
  if (card.status === "RETIRED") {
    return { error: "This bag QR has been retired and can no longer be used." };
  }
  return { ok: true, cardId: card.id };
}

// ── seal handpack bag ──────────────────────────────────────────────────────

const sealHandpackSchema = z.object({
  token: z.string().min(1),
  stationId: z.string().uuid(),
  workflowBagId: z.string().uuid(),
  plasticBlisterCount: z.coerce.number().int().positive(),
});

export async function sealHandpackBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = sealHandpackSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    workflowBagId: formData.get("workflowBagId"),
    plasticBlisterCount: formData.get("plasticBlisterCount"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { token, stationId, workflowBagId, plasticBlisterCount } = parsed.data;

  const station = await authStation(token, stationId);
  if (!station) return { error: "Invalid station token." };
  if (station.kind !== "SEALING") return { error: "Only SEALING stations may seal handpack bags." };

  const [bagState] = await db
    .select({ stage: readBagState.stage, isPaused: readBagState.isPaused, isFinalized: readBagState.isFinalized })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, workflowBagId))
    .limit(1);
  if (!bagState) return { error: "Bag not found." };
  if (bagState.isFinalized) return { error: "Bag is already finalized." };
  if (bagState.isPaused) return { error: "Resume the bag before sealing." };
  if (bagState.stage !== "BLISTERED") return { error: `Bag is at stage ${bagState.stage ?? "unknown"}, not BLISTERED.` };

  // FIFO: oldest AVAILABLE pre-made blister lot
  const [blisterLot] = await db
    .select({ id: packagingLots.id, qtyOnHand: packagingLots.qtyOnHand })
    .from(packagingLots)
    .innerJoin(packagingMaterials, eq(packagingMaterials.id, packagingLots.packagingMaterialId))
    .where(
      and(
        eq(packagingLots.status, "AVAILABLE"),
        eq(packagingMaterials.kind, "BLISTER_CARD"),
        eq(packagingMaterials.category, "MATERIAL"),
      )
    )
    .orderBy(asc(packagingLots.receivedAt))
    .limit(1);

  if (!blisterLot) return { error: "No available pre-made blister lot found. Receive stock first." };

  try {
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, { stationId: station.id });

      await projectEvent(tx, {
        eventType: "SEALING_COMPLETE",
        workflowBagId,
        stationId: station.id,
        payload: { plastic_blister_count: plasticBlisterCount },
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot: accountability.accountableEmployeeNameSnapshot,
      });

      const consume = Math.min(plasticBlisterCount, blisterLot.qtyOnHand);
      await projectEvent(tx, {
        eventType: "PACKAGING_MATERIAL_ISSUED",
        workflowBagId,
        stationId: station.id,
        payload: {
          packaging_lot_id: blisterLot.id,
          qty_issued: consume,
          reason: "handpack_seal",
        },
        enteredByUserId: accountability.enteredByUserId,
        accountableEmployeeId: accountability.accountableEmployeeId,
        accountabilitySource: accountability.accountabilitySource,
        accountableEmployeeNameSnapshot: accountability.accountableEmployeeNameSnapshot,
      });

      await tx
        .update(packagingLots)
        .set({ qtyOnHand: sql`qty_on_hand - ${consume}` })
        .where(eq(packagingLots.id, blisterLot.id));
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Seal failed." };
  }

  revalidatePath(`/floor/${token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
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
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_FINALIZED",
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
    return { error: err instanceof Error ? err.message : "Finalize failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

// ── release to next station ─────────────────────────────────────────────────

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
      await projectEvent(tx, {
        workflowBagId: parsed.data.workflowBagId,
        stationId: parsed.data.stationId,
        eventType: "BAG_RELEASED",
        payload: {
          station_kind: station.kind,
          released_at_stage: state.stage,
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
    return { error: err instanceof Error ? err.message : "Release failed." };
  }
  revalidatePath(`/floor/${parsed.data.token}`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}
