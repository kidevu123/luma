"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  qrCards,
  stations,
  workflowBags,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";

// Floor JSON paths are anonymous (no Authentik). Authorization is via
// the station's scan_token in the URL. Card scan creates a workflow
// bag + CARD_ASSIGNED event in one transaction. Every workflow_event
// goes through projectEvent() so read_station_live + read_bag_state
// are correct the moment the action returns.

const scanSchema = z.object({
  stationId: z.string().uuid(),
  cardId: z.string().uuid(),
});

export async function scanCardAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = scanSchema.safeParse({
    stationId: formData.get("stationId"),
    cardId: formData.get("cardId"),
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { stationId, cardId } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [station] = await tx
        .select()
        .from(stations)
        .where(eq(stations.id, stationId));
      if (!station) throw new Error("Station not found.");
      const [card] = await tx.select().from(qrCards).where(eq(qrCards.id, cardId));
      if (!card) throw new Error("Card not found.");
      if (card.status !== "IDLE") {
        throw new Error(`Card already ${card.status.toLowerCase()}.`);
      }
      const [bag] = await tx
        .insert(workflowBags)
        .values({})
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
      });
      await writeAudit(
        {
          actorId: null,
          actorRole: null,
          action: "floor.card_assigned",
          targetType: "WorkflowBag",
          targetId: bag.id,
          after: { card_id: cardId, station_id: stationId },
        },
        tx,
      );
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Scan failed." };
  }

  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

const eventSchema = z.object({
  workflowBagId: z.string().uuid(),
  stationId: z.string().uuid(),
  eventType: z.enum([
    "BLISTER_COMPLETE",
    "SEALING_COMPLETE",
    "PACKAGING_SNAPSHOT",
    "BOTTLE_HANDPACK_COMPLETE",
    "BOTTLE_CAP_SEAL_COMPLETE",
    "BOTTLE_STICKER_COMPLETE",
  ]),
  countTotal: z.coerce.number().int().min(0).max(100000).optional(),
});

export async function fireStageEventAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const parsed = eventSchema.safeParse({
    workflowBagId: formData.get("workflowBagId"),
    stationId: formData.get("stationId"),
    eventType: formData.get("eventType"),
    countTotal: formData.get("countTotal") || 0,
  });
  if (!parsed.success) return { error: "Invalid input." };
  const { workflowBagId, stationId, eventType, countTotal } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      await projectEvent(tx, {
        workflowBagId,
        stationId,
        eventType,
        payload: countTotal ? { count_total: countTotal } : {},
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Event failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}

export async function finalizeBagAction(
  formData: FormData,
): Promise<{ error?: string; ok?: true } | void> {
  const workflowBagId = String(formData.get("workflowBagId") ?? "");
  if (!z.string().uuid().safeParse(workflowBagId).success) return { error: "Invalid bag." };
  try {
    await db.transaction(async (tx) => {
      // projectEvent will:
      //   - insert workflow_events row (partial unique index enforces
      //     at-most-once-finalize)
      //   - update read_bag_state to FINALIZED
      //   - clear read_station_live for this bag
      //   - set workflow_bags.finalized_at
      //   - release qr_cards back to IDLE
      await projectEvent(tx, {
        workflowBagId,
        eventType: "BAG_FINALIZED",
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Finalize failed." };
  }
  revalidatePath(`/floor`);
  revalidatePath(`/floor-board`);
  return { ok: true };
}
