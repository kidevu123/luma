"use server";

// Phase H.x3.6 — Floor server actions for raw-bag allocation lifecycle.
//
// Five actions cover the bag balance ledger:
//   • openAllocationSessionAction(formData)  — start a session
//   • closeAllocationSessionAction(formData) — finish, write CLOSED
//   • returnRawBagAction(formData)           — partial unconsumed return
//   • markBagDepletedAction(formData)        — bag is empty
//   • adjustRawBagAction(formData)           — supervisor correction
//
// These do NOT yet have a floor UI in this phase. The actions are
// the contract a future scan-multiple-bags-for-variety-pack flow
// will call. Each action is self-contained, validates inputs, runs
// in a transaction, writes a session row + an event row, and is
// idempotent against the floor's clientEventId.

import { z } from "zod";
import { eq, sql, and, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  stations,
  inventoryBags,
  rawBagAllocationSessions,
  rawBagAllocationEvents,
} from "@/lib/db/schema";
import {
  resolveStationAccountability,
  withAccountabilityPayload,
} from "@/lib/production/station-operator-session";
import { resolveReopenStartingBalance, checkOverAllocation, deriveBagStatusAfterClose } from "@/lib/production/bag-allocation";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StationRow = typeof stations.$inferSelect;

async function authStation(token: string, stationIdFromForm: string): Promise<StationRow> {
  if (!UUID_RE.test(token)) throw new Error("Invalid station token.");
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.scanToken, token));
  if (!station) throw new Error("Invalid station token.");
  if (station.id !== stationIdFromForm) throw new Error("Station mismatch.");
  return station;
}

async function loadInventoryBag(id: string) {
  const rows = await db.execute<{
    id: string;
    pill_count: number | null;
    weight_grams: number | null;
    status: string;
    tablet_type_id: string | null;
    po_id: string | null;
  }>(sql`
    SELECT
      ib.id::text                  AS id,
      ib.pill_count                AS pill_count,
      ib.weight_grams              AS weight_grams,
      ib.status::text              AS status,
      ib.tablet_type_id::text      AS tablet_type_id,
      po.id::text                  AS po_id
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb     ON sb.id = ib.small_box_id
    LEFT JOIN receives r         ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${id}
    LIMIT 1
  `);
  return (rows as unknown as Array<{
    id: string;
    pill_count: number | null;
    weight_grams: number | null;
    status: string;
    tablet_type_id: string | null;
    po_id: string | null;
  }>)[0] ?? null;
}

// ── openAllocationSessionAction ─────────────────────────────────

const openSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  inventoryBagId: z.string().uuid(),
  productId: z.string().uuid().optional().nullable().or(z.literal("")),
  routeId: z.string().uuid().optional().nullable().or(z.literal("")),
  workflowBagId: z.string().uuid().optional().nullable().or(z.literal("")),
  componentRole: z.string().max(40).optional().nullable(),
  varietyRunId: z.string().uuid().optional().nullable().or(z.literal("")),
  startingBalanceQty: z.coerce.number().int().min(0).optional().nullable(),
  startingBalanceSource: z.string().max(40).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function openAllocationSessionAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string; sessionId?: string }> {
  const parsed = openSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    inventoryBagId: formData.get("inventoryBagId"),
    productId: formData.get("productId") || undefined,
    routeId: formData.get("routeId") || undefined,
    workflowBagId: formData.get("workflowBagId") || undefined,
    componentRole: formData.get("componentRole") || undefined,
    varietyRunId: formData.get("varietyRunId") || undefined,
    startingBalanceQty: formData.get("startingBalanceQty") || undefined,
    startingBalanceSource: formData.get("startingBalanceSource") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    await authStation(d.token, d.stationId);
    const bag = await loadInventoryBag(d.inventoryBagId);
    if (!bag) return { error: "Inventory bag not found." };
    if (bag.status === "VOID" || bag.status === "QUARANTINED") {
      return { error: `Bag is ${bag.status.toLowerCase()} — cannot open.` };
    }

    // Refuse a second OPEN session on the same bag.
    const existing = await db
      .select({ id: rawBagAllocationSessions.id })
      .from(rawBagAllocationSessions)
      .where(
        and(
          eq(rawBagAllocationSessions.inventoryBagId, d.inventoryBagId),
          eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { error: "Bag already has an open allocation. Close it first." };
    }

    // For reopened bags (prior sessions exist), derive remaining balance from
    // the last closed session rather than resetting to the full pill_count.
    const lastClosedSession = d.startingBalanceQty == null
      ? await db
          .select({
            endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
            startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
            consumedQty: rawBagAllocationSessions.consumedQty,
          })
          .from(rawBagAllocationSessions)
          .where(
            and(
              eq(rawBagAllocationSessions.inventoryBagId, d.inventoryBagId),
              eq(rawBagAllocationSessions.allocationStatus, "CLOSED"),
            ),
          )
          .orderBy(desc(rawBagAllocationSessions.closedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;

    const startingBalance =
      d.startingBalanceQty != null
        ? d.startingBalanceQty
        : resolveReopenStartingBalance(lastClosedSession, bag.pill_count);
    const startingSource =
      d.startingBalanceSource ??
      (d.startingBalanceQty != null
        ? "MANUAL_ENTRY"
        : lastClosedSession != null
          ? "LEDGER_DERIVED"
          : "VENDOR_DECLARED");

    let sessionId = "";
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      const inserted = await tx
        .insert(rawBagAllocationSessions)
        .values({
          inventoryBagId: d.inventoryBagId,
          ...(bag.po_id ? { poId: bag.po_id } : {}),
          ...(d.workflowBagId && d.workflowBagId !== "" ? { workflowBagId: d.workflowBagId } : {}),
          ...(d.productId && d.productId !== "" ? { productId: d.productId } : {}),
          ...(d.routeId && d.routeId !== "" ? { routeId: d.routeId } : {}),
          ...(d.componentRole ? { componentRole: d.componentRole } : {}),
          ...(d.varietyRunId && d.varietyRunId !== "" ? { varietyRunId: d.varietyRunId } : {}),
          allocationStatus: "OPEN",
          ...(startingBalance != null ? { startingBalanceQty: startingBalance } : {}),
          ...(startingSource ? { startingBalanceSource: startingSource } : {}),
          unitOfMeasure: "tablets",
          confidence: "LOW",
          ...(d.notes ? { notes: d.notes } : {}),
        })
        .returning({ id: rawBagAllocationSessions.id });
      const session = inserted[0];
      if (!session) throw new Error("Insert returned no session id.");
      sessionId = session.id;

      await tx.insert(rawBagAllocationEvents).values({
        allocationSessionId: session.id,
        inventoryBagId: d.inventoryBagId,
        ...(bag.po_id ? { poId: bag.po_id } : {}),
        ...(d.workflowBagId && d.workflowBagId !== "" ? { workflowBagId: d.workflowBagId } : {}),
        ...(d.productId && d.productId !== "" ? { productId: d.productId } : {}),
        ...(d.routeId && d.routeId !== "" ? { routeId: d.routeId } : {}),
        eventType: "RAW_BAG_OPENED",
        ...(startingBalance != null ? { quantity: String(startingBalance) } : {}),
        unitOfMeasure: "tablets",
        ...(startingSource ? { quantitySource: startingSource } : {}),
        payload: withAccountabilityPayload(
          {
            component_role: d.componentRole ?? null,
            notes: d.notes ?? null,
          },
          accountability,
        ),
        confidence: "MEDIUM",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });

      // Reflect IN_USE on the inventory_bag.
      await tx
        .update(inventoryBags)
        .set({ status: "IN_USE" })
        .where(eq(inventoryBags.id, d.inventoryBagId));
    });

    return { ok: true, sessionId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Open failed." };
  }
}

// ── closeAllocationSessionAction ────────────────────────────────

const closeSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  consumedQty: z.coerce.number().int().min(0).optional().nullable(),
  consumedQtySource: z.string().max(40).optional().nullable(),
  endingBalanceQty: z.coerce.number().int().min(0).optional().nullable(),
  endingBalanceSource: z.string().max(40).optional().nullable(),
  finishedLotId: z.string().uuid().optional().nullable().or(z.literal("")),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function closeAllocationSessionAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const parsed = closeSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    sessionId: formData.get("sessionId"),
    consumedQty: formData.get("consumedQty") || undefined,
    consumedQtySource: formData.get("consumedQtySource") || undefined,
    endingBalanceQty: formData.get("endingBalanceQty") || undefined,
    endingBalanceSource: formData.get("endingBalanceSource") || undefined,
    finishedLotId: formData.get("finishedLotId") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    await authStation(d.token, d.stationId);
    const sessRows = await db
      .select()
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, d.sessionId))
      .limit(1);
    const session = sessRows[0];
    if (!session) return { error: "Session not found." };
    if (session.allocationStatus !== "OPEN") {
      return { error: `Session is ${session.allocationStatus} — cannot close.` };
    }

    if (d.consumedQty != null) {
      const overAllocError = checkOverAllocation(d.consumedQty, session.startingBalanceQty);
      if (overAllocError) return { error: overAllocError };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      // Emit a CONSUMED event for the consumed qty (if provided).
      if (d.consumedQty != null && d.consumedQty > 0) {
        await tx.insert(rawBagAllocationEvents).values({
          allocationSessionId: session.id,
          inventoryBagId: session.inventoryBagId,
          ...(session.poId ? { poId: session.poId } : {}),
          ...(session.productId ? { productId: session.productId } : {}),
          ...(session.routeId ? { routeId: session.routeId } : {}),
          ...(session.workflowBagId ? { workflowBagId: session.workflowBagId } : {}),
          ...(d.finishedLotId && d.finishedLotId !== "" ? { finishedLotId: d.finishedLotId } : {}),
          eventType: "RAW_BAG_PARTIAL_CONSUMED",
          quantity: String(d.consumedQty),
          unitOfMeasure: "tablets",
          ...(d.consumedQtySource ? { quantitySource: d.consumedQtySource } : { quantitySource: "MANUAL_ENTRY" }),
          payload: withAccountabilityPayload(
            {
              component_role: session.componentRole ?? null,
              notes: d.notes ?? null,
              session_close: true,
            },
            accountability,
          ),
          confidence: "HIGH",
          ...(d.clientEventId ? { clientEventId: `${d.clientEventId}-c` } : {}),
        });
      }

      // Update + close the session.
      const updates: Partial<typeof rawBagAllocationSessions.$inferInsert> = {
        allocationStatus: "CLOSED",
        closedAt: new Date(),
        confidence: d.consumedQty != null && d.endingBalanceQty != null ? "HIGH" : "MEDIUM",
      };
      if (d.consumedQty != null) {
        updates.consumedQty = d.consumedQty;
        updates.consumedQtySource = d.consumedQtySource ?? "MANUAL_ENTRY";
      }
      if (d.endingBalanceQty != null) {
        updates.endingBalanceQty = d.endingBalanceQty;
        updates.endingBalanceSource = d.endingBalanceSource ?? "WEIGH_BACK";
      }
      if (d.finishedLotId && d.finishedLotId !== "") updates.finishedLotId = d.finishedLotId;
      if (d.notes) updates.notes = d.notes;
      await tx
        .update(rawBagAllocationSessions)
        .set(updates)
        .where(eq(rawBagAllocationSessions.id, session.id));

      // Update inventory bag status based on operator-confirmed ending balance.
      const newBagStatus = deriveBagStatusAfterClose(d.endingBalanceQty);
      if (newBagStatus != null) {
        await tx
          .update(inventoryBags)
          .set({ status: newBagStatus })
          .where(eq(inventoryBags.id, session.inventoryBagId));
      }
    });

    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Close failed." };
  }
}

// ── returnRawBagAction ─────────────────────────────────────────

const returnSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  returnedQty: z.coerce.number().int().positive(),
  remainingWeightGrams: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function returnRawBagAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const parsed = returnSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    sessionId: formData.get("sessionId"),
    returnedQty: formData.get("returnedQty"),
    remainingWeightGrams: formData.get("remainingWeightGrams") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    await authStation(d.token, d.stationId);
    const sessRows = await db
      .select()
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, d.sessionId))
      .limit(1);
    const session = sessRows[0];
    if (!session) return { error: "Session not found." };
    if (session.allocationStatus !== "OPEN") {
      return { error: `Session is ${session.allocationStatus} — cannot return.` };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      await tx.insert(rawBagAllocationEvents).values({
        allocationSessionId: session.id,
        inventoryBagId: session.inventoryBagId,
        ...(session.poId ? { poId: session.poId } : {}),
        ...(session.productId ? { productId: session.productId } : {}),
        ...(session.routeId ? { routeId: session.routeId } : {}),
        eventType: "RAW_BAG_RETURNED_TO_STOCK",
        quantity: String(d.returnedQty),
        unitOfMeasure: "tablets",
        quantitySource: "MANUAL_ENTRY",
        payload: withAccountabilityPayload(
          {
            remaining_weight_grams: d.remainingWeightGrams ?? null,
            notes: d.notes ?? null,
          },
          accountability,
        ),
        confidence: "MEDIUM",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });

      await tx
        .update(rawBagAllocationSessions)
        .set({
          allocationStatus: "RETURNED_TO_STOCK",
          closedAt: new Date(),
          endingBalanceQty: d.returnedQty,
          endingBalanceSource: "MANUAL_ENTRY",
        })
        .where(eq(rawBagAllocationSessions.id, session.id));

      // Bag is back to AVAILABLE so it can be reopened later.
      await tx
        .update(inventoryBags)
        .set({ status: "AVAILABLE" })
        .where(eq(inventoryBags.id, session.inventoryBagId));
    });

    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Return failed." };
  }
}

// ── markBagDepletedAction ──────────────────────────────────────

const depletedSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  sessionId: z.string().uuid(),
  finalConsumedQty: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function markBagDepletedAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const parsed = depletedSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    sessionId: formData.get("sessionId"),
    finalConsumedQty: formData.get("finalConsumedQty") || undefined,
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    await authStation(d.token, d.stationId);
    const sessRows = await db
      .select()
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, d.sessionId))
      .limit(1);
    const session = sessRows[0];
    if (!session) return { error: "Session not found." };
    if (session.allocationStatus !== "OPEN") {
      return { error: `Session is ${session.allocationStatus} — cannot deplete.` };
    }

    if (d.finalConsumedQty != null) {
      const overAllocError = checkOverAllocation(d.finalConsumedQty, session.startingBalanceQty);
      if (overAllocError) return { error: overAllocError };
    }

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      await tx.insert(rawBagAllocationEvents).values({
        allocationSessionId: session.id,
        inventoryBagId: session.inventoryBagId,
        ...(session.poId ? { poId: session.poId } : {}),
        ...(session.productId ? { productId: session.productId } : {}),
        eventType: "RAW_BAG_DEPLETED",
        ...(d.finalConsumedQty != null ? { quantity: String(d.finalConsumedQty) } : {}),
        unitOfMeasure: "tablets",
        quantitySource: "MANUAL_ENTRY",
        payload: withAccountabilityPayload(
          { notes: d.notes ?? null },
          accountability,
        ),
        confidence: "HIGH",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });

      await tx
        .update(rawBagAllocationSessions)
        .set({
          allocationStatus: "DEPLETED",
          closedAt: new Date(),
          endingBalanceQty: 0,
          endingBalanceSource: "DEPLETED",
        })
        .where(eq(rawBagAllocationSessions.id, session.id));

      await tx
        .update(inventoryBags)
        .set({ status: "EMPTIED" })
        .where(eq(inventoryBags.id, session.inventoryBagId));
    });

    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Deplete failed." };
  }
}

// ── adjustRawBagAction ─────────────────────────────────────────

const adjustSchema = z.object({
  token: z.string().regex(UUID_RE),
  stationId: z.string().uuid(),
  inventoryBagId: z.string().uuid(),
  adjustmentQty: z.coerce.number().int(),
  reason: z.string().min(1).max(200),
  notes: z.string().max(500).optional().nullable(),
  clientEventId: z.string().regex(UUID_RE).optional(),
});

export async function adjustRawBagAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  const parsed = adjustSchema.safeParse({
    token: formData.get("token"),
    stationId: formData.get("stationId"),
    inventoryBagId: formData.get("inventoryBagId"),
    adjustmentQty: formData.get("adjustmentQty"),
    reason: formData.get("reason"),
    notes: formData.get("notes") || undefined,
    clientEventId: formData.get("clientEventId") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const d = parsed.data;
  try {
    await authStation(d.token, d.stationId);
    const bag = await loadInventoryBag(d.inventoryBagId);
    if (!bag) return { error: "Inventory bag not found." };

    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: d.stationId,
      });
      await tx.insert(rawBagAllocationEvents).values({
        inventoryBagId: d.inventoryBagId,
        ...(bag.po_id ? { poId: bag.po_id } : {}),
        eventType: "RAW_BAG_ADJUSTED",
        quantity: String(d.adjustmentQty),
        unitOfMeasure: "tablets",
        quantitySource: "MANUAL_ENTRY",
        payload: withAccountabilityPayload(
          { reason: d.reason, notes: d.notes ?? null },
          accountability,
        ),
        confidence: "MEDIUM",
        ...(d.clientEventId ? { clientEventId: d.clientEventId } : {}),
      });
    });

    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Adjust failed." };
  }
}
