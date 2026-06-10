// P1-PARTIAL-CORRECTIONS — Admin corrections for partial bags.
//
// Five operations: correct remaining qty, mark depleted, put on hold,
// return to stock, void bad record. (Resolve-missing-allocation lives
// in partial-bag-review-closeout.) Invariants:
//   • The original ledger is NEVER edited. Corrections append a new
//     correction session and/or RAW_BAG_* events with before/after in
//     the audit log.
//   • Every operation requires a reason and an admin actor.
//   • inventory_bags.status transitions follow the same rules the
//     floor closeout uses (AVAILABLE / EMPTIED / QUARANTINED / VOID).

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  confidenceForResolutionMethod,
  type PartialBagResolutionMethod,
} from "@/lib/production/partial-bag-resolution-constants";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PartialBagCorrectionActor = {
  id: string | null;
  role: string | null;
};

export type PartialBagCorrectionResult =
  | { ok: true }
  | { ok: false; error: string };

const MIN_REASON = 5;

async function loadBag(inventoryBagId: string) {
  const [bag] = await db
    .select({
      id: inventoryBags.id,
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
      bagQrCode: inventoryBags.bagQrCode,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);
  return bag ?? null;
}

async function loadLastClosedSession(inventoryBagId: string) {
  const [row] = await db
    .select({
      id: rawBagAllocationSessions.id,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
      poId: rawBagAllocationSessions.poId,
      productId: rawBagAllocationSessions.productId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
        sql`${rawBagAllocationSessions.allocationStatus} IN ('CLOSED','RETURNED_TO_STOCK','DEPLETED')`,
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.closedAt))
    .limit(1);
  return row ?? null;
}

async function loadOpenSession(inventoryBagId: string) {
  const [row] = await db
    .select({
      id: rawBagAllocationSessions.id,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function releaseQrIfEmptied(
  tx: DbTx,
  bagQrCode: string | null,
  actorId: string | null,
): Promise<void> {
  if (!bagQrCode) return;
  const [rawCard] = await tx
    .select({ id: qrCards.id, cardType: qrCards.cardType, status: qrCards.status })
    .from(qrCards)
    .where(eq(qrCards.scanToken, bagQrCode))
    .limit(1);
  if (rawCard && rawCard.cardType === "RAW_BAG" && rawCard.status === "ASSIGNED") {
    await tx.update(qrCards).set({ status: "IDLE" }).where(eq(qrCards.id, rawCard.id));
    await writeAudit(
      {
        actorId,
        actorRole: null,
        action: "RAW_BAG_QR_RELEASED",
        targetType: "qr_card",
        targetId: rawCard.id,
      },
      tx,
    );
  }
}

function validReason(reason: string): boolean {
  return reason.trim().length >= MIN_REASON;
}

// ── 1. Correct remaining quantity ────────────────────────────────────

export async function correctPartialBagRemaining(args: {
  inventoryBagId: string;
  newRemaining: number;
  method: PartialBagResolutionMethod;
  reason: string;
  actor: PartialBagCorrectionActor;
}): Promise<PartialBagCorrectionResult> {
  if (!Number.isInteger(args.newRemaining) || args.newRemaining < 0) {
    return { ok: false, error: "Remaining count must be a non-negative integer." };
  }
  if (!validReason(args.reason)) {
    return { ok: false, error: "A correction reason is required." };
  }
  const bag = await loadBag(args.inventoryBagId);
  if (!bag) return { ok: false, error: "Inventory bag not found." };
  if (bag.status === "VOID") {
    return { ok: false, error: "Bag is void — un-void is not supported; create a new record." };
  }
  const open = await loadOpenSession(args.inventoryBagId);
  if (open) {
    return {
      ok: false,
      error:
        "Bag has an open allocation session — close it at the floor (or mark depleted) before correcting the remaining count.",
    };
  }
  const last = await loadLastClosedSession(args.inventoryBagId);
  const priorRemaining = last?.endingBalanceQty ?? null;
  const confidence = confidenceForResolutionMethod(args.method);
  const now = new Date();
  const newStatus = args.newRemaining > 0 ? "AVAILABLE" : "EMPTIED";

  await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(rawBagAllocationSessions)
      .values({
        inventoryBagId: args.inventoryBagId,
        ...(last?.poId ? { poId: last.poId } : {}),
        ...(last?.productId ? { productId: last.productId } : {}),
        allocationStatus: args.newRemaining > 0 ? "CLOSED" : "DEPLETED",
        openedAt: now,
        closedAt: now,
        ...(args.actor.id
          ? { openedByUserId: args.actor.id, closedByUserId: args.actor.id }
          : {}),
        ...(priorRemaining != null
          ? {
              startingBalanceQty: priorRemaining,
              startingBalanceSource: "LEDGER_DERIVED",
            }
          : {}),
        endingBalanceQty: args.newRemaining,
        endingBalanceSource: args.method,
        unitOfMeasure: "tablets",
        confidence,
        notes: `admin_correction | ${args.reason.trim()}`,
      })
      .returning({ id: rawBagAllocationSessions.id });
    if (!session) throw new Error("Correction session insert failed.");

    await tx.insert(rawBagAllocationEvents).values({
      allocationSessionId: session.id,
      inventoryBagId: args.inventoryBagId,
      ...(last?.poId ? { poId: last.poId } : {}),
      eventType: args.method === "WEIGH_BACK" ? "RAW_BAG_REWEIGHED" : "RAW_BAG_ADJUSTED",
      quantity: String(args.newRemaining),
      unitOfMeasure: "tablets",
      quantitySource: args.method,
      ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
      payload: {
        admin_correction: "correct_remaining",
        prior_remaining: priorRemaining,
        new_remaining: args.newRemaining,
        reason: args.reason.trim(),
      },
      confidence,
    });

    await tx
      .update(inventoryBags)
      .set({ status: newStatus })
      .where(eq(inventoryBags.id, args.inventoryBagId));
    if (newStatus === "EMPTIED") {
      await releaseQrIfEmptied(tx, bag.bagQrCode, args.actor.id);
    }

    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: null,
        action: "partial_bag.correct_remaining",
        targetType: "InventoryBag",
        targetId: args.inventoryBagId,
        before: { status: bag.status, remaining: priorRemaining },
        after: {
          status: newStatus,
          remaining: args.newRemaining,
          method: args.method,
          reason: args.reason.trim(),
          correction_session_id: session.id,
        },
      },
      tx,
    );
  });
  return { ok: true };
}

// ── 2. Mark depleted ─────────────────────────────────────────────────

export async function markPartialBagDepletedAdmin(args: {
  inventoryBagId: string;
  reason: string;
  actor: PartialBagCorrectionActor;
}): Promise<PartialBagCorrectionResult> {
  if (!validReason(args.reason)) {
    return { ok: false, error: "A reason is required." };
  }
  const bag = await loadBag(args.inventoryBagId);
  if (!bag) return { ok: false, error: "Inventory bag not found." };
  if (bag.status === "VOID") return { ok: false, error: "Bag is void." };
  const open = await loadOpenSession(args.inventoryBagId);
  const now = new Date();

  await db.transaction(async (tx) => {
    let sessionId: string;
    if (open) {
      // Close the floor's open session as DEPLETED — appended state
      // change, the opening event remains untouched.
      await tx
        .update(rawBagAllocationSessions)
        .set({
          allocationStatus: "DEPLETED",
          closedAt: now,
          ...(args.actor.id ? { closedByUserId: args.actor.id } : {}),
          endingBalanceQty: 0,
          endingBalanceSource: "DEPLETED",
          confidence: "MEDIUM",
          notes: `admin_mark_depleted | ${args.reason.trim()}`,
        })
        .where(eq(rawBagAllocationSessions.id, open.id));
      sessionId = open.id;
    } else {
      const [session] = await tx
        .insert(rawBagAllocationSessions)
        .values({
          inventoryBagId: args.inventoryBagId,
          allocationStatus: "DEPLETED",
          openedAt: now,
          closedAt: now,
          ...(args.actor.id
            ? { openedByUserId: args.actor.id, closedByUserId: args.actor.id }
            : {}),
          endingBalanceQty: 0,
          endingBalanceSource: "DEPLETED",
          unitOfMeasure: "tablets",
          confidence: "MEDIUM",
          notes: `admin_mark_depleted | ${args.reason.trim()}`,
        })
        .returning({ id: rawBagAllocationSessions.id });
      if (!session) throw new Error("Depleted session insert failed.");
      sessionId = session.id;
    }

    await tx.insert(rawBagAllocationEvents).values({
      allocationSessionId: sessionId,
      inventoryBagId: args.inventoryBagId,
      eventType: "RAW_BAG_DEPLETED",
      quantity: "0",
      unitOfMeasure: "tablets",
      quantitySource: "MANUAL_ENTRY",
      ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
      payload: { admin_correction: "mark_depleted", reason: args.reason.trim() },
      confidence: "MEDIUM",
    });

    await tx
      .update(inventoryBags)
      .set({ status: "EMPTIED" })
      .where(eq(inventoryBags.id, args.inventoryBagId));
    await releaseQrIfEmptied(tx, bag.bagQrCode, args.actor.id);

    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: null,
        action: "partial_bag.mark_depleted",
        targetType: "InventoryBag",
        targetId: args.inventoryBagId,
        before: { status: bag.status },
        after: { status: "EMPTIED", reason: args.reason.trim() },
      },
      tx,
    );
  });
  return { ok: true };
}

// ── 3. Put on hold / 4. Return to stock ─────────────────────────────

export async function setPartialBagHold(args: {
  inventoryBagId: string;
  hold: boolean;
  reason: string;
  actor: PartialBagCorrectionActor;
}): Promise<PartialBagCorrectionResult> {
  if (!validReason(args.reason)) {
    return { ok: false, error: "A reason is required." };
  }
  const bag = await loadBag(args.inventoryBagId);
  if (!bag) return { ok: false, error: "Inventory bag not found." };
  if (bag.status === "VOID") return { ok: false, error: "Bag is void." };
  if (args.hold && bag.status === "QUARANTINED") {
    return { ok: false, error: "Bag is already on hold." };
  }
  if (!args.hold && bag.status !== "QUARANTINED") {
    return { ok: false, error: "Bag is not on hold." };
  }
  const newStatus = args.hold ? "QUARANTINED" : "AVAILABLE";

  await db.transaction(async (tx) => {
    await tx.insert(rawBagAllocationEvents).values({
      inventoryBagId: args.inventoryBagId,
      eventType: "RAW_BAG_ADJUSTED",
      unitOfMeasure: "tablets",
      quantitySource: "MANUAL_ENTRY",
      ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
      payload: {
        admin_correction: args.hold ? "put_on_hold" : "return_to_stock",
        reason: args.reason.trim(),
      },
      confidence: "MEDIUM",
    });
    await tx
      .update(inventoryBags)
      .set({ status: newStatus })
      .where(eq(inventoryBags.id, args.inventoryBagId));
    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: null,
        action: args.hold ? "partial_bag.hold" : "partial_bag.return_to_stock",
        targetType: "InventoryBag",
        targetId: args.inventoryBagId,
        before: { status: bag.status },
        after: { status: newStatus, reason: args.reason.trim() },
      },
      tx,
    );
  });
  return { ok: true };
}

// ── 5. Void bad partial record ───────────────────────────────────────

export async function voidPartialBagRecord(args: {
  inventoryBagId: string;
  reason: string;
  actor: PartialBagCorrectionActor;
}): Promise<PartialBagCorrectionResult> {
  if (!validReason(args.reason)) {
    return { ok: false, error: "A reason is required." };
  }
  const bag = await loadBag(args.inventoryBagId);
  if (!bag) return { ok: false, error: "Inventory bag not found." };
  if (bag.status === "VOID") return { ok: false, error: "Bag is already void." };
  const open = await loadOpenSession(args.inventoryBagId);
  const now = new Date();

  await db.transaction(async (tx) => {
    if (open) {
      await tx
        .update(rawBagAllocationSessions)
        .set({
          allocationStatus: "VOIDED",
          closedAt: now,
          ...(args.actor.id ? { closedByUserId: args.actor.id } : {}),
          notes: `admin_void | ${args.reason.trim()}`,
        })
        .where(eq(rawBagAllocationSessions.id, open.id));
    }
    await tx.insert(rawBagAllocationEvents).values({
      ...(open ? { allocationSessionId: open.id } : {}),
      inventoryBagId: args.inventoryBagId,
      eventType: "RAW_BAG_VOIDED",
      unitOfMeasure: "tablets",
      quantitySource: "MANUAL_ENTRY",
      ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
      payload: { admin_correction: "void_record", reason: args.reason.trim() },
      confidence: "MEDIUM",
    });
    await tx
      .update(inventoryBags)
      .set({ status: "VOID" })
      .where(eq(inventoryBags.id, args.inventoryBagId));
    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: null,
        action: "partial_bag.void_record",
        targetType: "InventoryBag",
        targetId: args.inventoryBagId,
        before: { status: bag.status },
        after: { status: "VOID", reason: args.reason.trim() },
      },
      tx,
    );
  });
  return { ok: true };
}
