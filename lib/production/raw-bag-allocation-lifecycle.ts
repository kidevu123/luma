// Shared raw-bag allocation open/close helpers (floor + admin coordinated closeout).

import { and, desc, eq } from "drizzle-orm";
import type { CurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  products,
  qrCards,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
  readBagMetrics,
  workflowBags,
} from "@/lib/db/schema";
import {
  checkOverAllocation,
  deriveBagStatusAfterClose,
  resolveReopenStartingBalance,
} from "@/lib/production/bag-allocation";
import {
  computeEndingBalanceFromConsumption,
  computeExpectedTabletConsumptionFromProduct,
} from "@/lib/production/expected-tablet-consumption";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AllocationActor =
  | Pick<CurrentUser, "id" | "role">
  | { id: string | null; role: CurrentUser["role"] | null };

export type OpenAllocationSessionInput = {
  inventoryBagId: string;
  workflowBagId: string;
  productId?: string | null;
  poId?: string | null;
  startingBalanceQty?: number | null;
  startingBalanceSource?: string | null;
  notes?: string | null;
  actor?: AllocationActor | null;
};

export async function openAllocationSessionInTx(
  tx: DbTx,
  input: OpenAllocationSessionInput,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  if (input.inventoryBagId === input.workflowBagId) {
    return {
      ok: false,
      error: "inventory_bag_id and workflow_bag_id must be different.",
    };
  }

  const [openForWorkflow] = await tx
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, input.workflowBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  if (openForWorkflow) {
    return { ok: true, sessionId: openForWorkflow.id };
  }

  const [existingOpen] = await tx
    .select({
      id: rawBagAllocationSessions.id,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, input.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);

  if (existingOpen) {
    return {
      ok: false,
      error:
        existingOpen.workflowBagId && existingOpen.workflowBagId !== input.workflowBagId
          ? "This source bag has an open allocation session on another production run. Close it before starting again."
          : "Bag already has an open allocation session. Close it first.",
    };
  }

  const [bag] = await tx
    .select({
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, input.inventoryBagId))
    .limit(1);
  if (!bag) return { ok: false, error: "Inventory bag not found." };

  const [lastClosed] = await tx
    .select({
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      consumedQty: rawBagAllocationSessions.consumedQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, input.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "CLOSED"),
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.closedAt))
    .limit(1);

  const startingBalance =
    input.startingBalanceQty ??
    resolveReopenStartingBalance(lastClosed ?? null, bag.pillCount) ??
    (bag.declaredPillCount != null && bag.declaredPillCount >= 0
      ? bag.declaredPillCount
      : null);
  const startingSource =
    input.startingBalanceSource ??
    (input.startingBalanceQty != null
      ? "MANUAL_ENTRY"
      : lastClosed != null
        ? "LEDGER_DERIVED"
        : bag.pillCount != null
          ? "VENDOR_DECLARED"
          : bag.declaredPillCount != null
            ? "VENDOR_DECLARED"
            : "MANUAL_ENTRY");

  const inserted = await tx
    .insert(rawBagAllocationSessions)
    .values({
      inventoryBagId: input.inventoryBagId,
      ...(input.poId ? { poId: input.poId } : {}),
      workflowBagId: input.workflowBagId,
      ...(input.productId ? { productId: input.productId } : {}),
      allocationStatus: "OPEN",
      ...(startingBalance != null ? { startingBalanceQty: startingBalance } : {}),
      ...(startingSource ? { startingBalanceSource: startingSource } : {}),
      unitOfMeasure: "tablets",
      confidence: "LOW",
      ...(input.notes ? { notes: input.notes } : {}),
    })
    .returning({ id: rawBagAllocationSessions.id });
  const session = inserted[0];
  if (!session) return { ok: false, error: "Failed to open allocation session." };

  await tx.insert(rawBagAllocationEvents).values({
    allocationSessionId: session.id,
    inventoryBagId: input.inventoryBagId,
    workflowBagId: input.workflowBagId,
    ...(input.productId ? { productId: input.productId } : {}),
    eventType: "RAW_BAG_OPENED",
    ...(startingBalance != null ? { quantity: String(startingBalance) } : {}),
    unitOfMeasure: "tablets",
    ...(startingSource ? { quantitySource: startingSource } : {}),
    payload: { source: "openAllocationSessionInTx" },
    confidence: "MEDIUM",
  });

  await tx
    .update(inventoryBags)
    .set({ status: "IN_USE" })
    .where(eq(inventoryBags.id, input.inventoryBagId));

  await writeAudit(
    {
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      action: "raw_bag_allocation.opened",
      targetType: "RawBagAllocationSession",
      targetId: session.id,
      after: {
        inventoryBagId: input.inventoryBagId,
        workflowBagId: input.workflowBagId,
      },
    },
    tx,
  );

  return { ok: true, sessionId: session.id };
}

/** Idempotent open when production starts (floor scan or admin start). */
export async function ensureOpenRawBagAllocationSessionForWorkflowBag(
  tx: DbTx,
  input: OpenAllocationSessionInput,
): Promise<
  | { ok: true; sessionId: string; opened: boolean }
  | { ok: false; error: string }
> {
  const [existingForWorkflow] = await tx
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, input.workflowBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  if (existingForWorkflow) {
    return {
      ok: true,
      sessionId: existingForWorkflow.id,
      opened: false,
    };
  }

  const opened = await openAllocationSessionInTx(tx, input);
  if (!opened.ok) return opened;
  return {
    ok: true,
    sessionId: opened.sessionId,
    opened: true,
  };
}

/** @deprecated use ensureOpenRawBagAllocationSessionForWorkflowBag */
export const ensureOpenAllocationForProductionStartInTx =
  ensureOpenRawBagAllocationSessionForWorkflowBag;

export type CloseAllocationForProductionOutputInput = {
  workflowBagId: string;
  productId: string;
  unitsProduced: number;
  finishedLotId: string;
  consumedQtySource?: string | null;
  endingBalanceSource?: string | null;
  notes?: string | null;
  /** When true, opens a missing session before close (legacy repair). */
  allowRepairOpen?: boolean;
  actor?: AllocationActor | null;
};

export type CloseAllocationForProductionOutputResult =
  | {
      ok: true;
      sessionId: string;
      consumedQty: number;
      endingBalanceQty: number;
      repairedSession: boolean;
    }
  | { ok: false; code: string; error: string };

/** Locate (or repair-open) the workflow allocation session and close it from output math. */
export async function closeAllocationForProductionOutputInTx(
  tx: DbTx,
  input: CloseAllocationForProductionOutputInput,
): Promise<CloseAllocationForProductionOutputResult> {
  const [bagRow] = await tx
    .select({
      inventoryBagId: workflowBags.inventoryBagId,
      tabletsPerUnit: products.tabletsPerUnit,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .where(eq(workflowBags.id, input.workflowBagId))
    .limit(1);

  if (!bagRow?.inventoryBagId) {
    return {
      ok: false,
      code: "MISSING_INVENTORY_BAG",
      error: "Workflow bag has no linked source inventory bag.",
    };
  }

  const unitsProduced =
    input.unitsProduced > 0 ? input.unitsProduced : (bagRow.unitsYielded ?? 0);
  const consumption = computeExpectedTabletConsumptionFromProduct(
    bagRow.tabletsPerUnit,
    unitsProduced,
  );
  if (!consumption.ok) {
    return {
      ok: false,
      code: consumption.blocker,
      error: consumption.message,
    };
  }

  let repairedSession = false;
  let sessionId: string | null = null;

  const [openSession] = await tx
    .select({
      id: rawBagAllocationSessions.id,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, input.workflowBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);

  if (openSession) {
    sessionId = openSession.id;
  } else if (input.allowRepairOpen) {
    const opened = await openAllocationSessionInTx(tx, {
      inventoryBagId: bagRow.inventoryBagId,
      workflowBagId: input.workflowBagId,
      productId: input.productId,
      notes: input.notes ?? "Repair-opened during lot issue.",
      actor: input.actor ?? null,
    });
    if (!opened.ok) {
      return { ok: false, code: "ALLOCATION_REPAIR_FAILED", error: opened.error };
    }
    sessionId = opened.sessionId;
    repairedSession = true;
  } else {
    return {
      ok: false,
      code: "MISSING_ALLOCATION_SESSION",
      error:
        "No open raw-bag allocation session exists for this production run.",
    };
  }

  const [sessionRow] = await tx
    .select({ startingBalanceQty: rawBagAllocationSessions.startingBalanceQty })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.id, sessionId))
    .limit(1);

  const startingBalance =
    sessionRow?.startingBalanceQty ?? openSession?.startingBalanceQty ?? null;
  const endingBalance = computeEndingBalanceFromConsumption(
    startingBalance,
    consumption.expectedConsumed,
  );
  if (endingBalance == null) {
    return {
      ok: false,
      code: "MISSING_STARTING_BALANCE",
      error:
        "Starting tablet balance is unknown — confirm starting balance before auto-closing allocation.",
    };
  }
  if (endingBalance < 0) {
    return {
      ok: false,
      code: "NEGATIVE_ENDING_BALANCE",
      error: `Computed ending balance (${endingBalance}) is negative. Review consumption or starting balance.`,
    };
  }

  const closed = await closeAllocationSessionInTx(tx, {
    sessionId,
    finishedLotId: input.finishedLotId,
    consumedQty: consumption.expectedConsumed,
    endingBalanceQty: endingBalance,
    consumedQtySource: input.consumedQtySource ?? "OUTPUT_DERIVED",
    endingBalanceSource: input.endingBalanceSource ?? "OUTPUT_DERIVED",
    notes: input.notes ?? null,
    actor: input.actor ?? null,
  });
  if (!closed.ok) {
    return { ok: false, code: "ALLOCATION_CLOSE_FAILED", error: closed.error };
  }

  return {
    ok: true,
    sessionId,
    consumedQty: consumption.expectedConsumed,
    endingBalanceQty: endingBalance,
    repairedSession,
  };
}

export type CloseAllocationSessionInput = {
  sessionId: string;
  finishedLotId: string;
  consumedQty: number;
  endingBalanceQty: number;
  consumedQtySource?: string | null;
  endingBalanceSource?: string | null;
  notes?: string | null;
  actor?: AllocationActor | null;
  /** When true, allow consumed > starting balance and negative ending balance
   *  (packaging output is authoritative vs vendor label intake). */
  allowPackagingDerivedOverConsumption?: boolean;
};

export async function closeAllocationSessionInTx(
  tx: DbTx,
  input: CloseAllocationSessionInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.consumedQty <= 0) {
    return { ok: false, error: "Consumed quantity must be positive." };
  }
  if (
    input.endingBalanceQty < 0 &&
    !input.allowPackagingDerivedOverConsumption
  ) {
    return { ok: false, error: "Ending balance cannot be negative." };
  }

  const [session] = await tx
    .select()
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.id, input.sessionId))
    .limit(1);
  if (!session) return { ok: false, error: "Allocation session not found." };
  if (session.allocationStatus !== "OPEN") {
    return {
      ok: false,
      error: `Session is ${session.allocationStatus} — cannot close again.`,
    };
  }
  if (session.inventoryBagId === session.workflowBagId) {
    return {
      ok: false,
      error: "Session inventory_bag_id must not equal workflow_bag_id.",
    };
  }

  const overAllocError = input.allowPackagingDerivedOverConsumption
    ? null
    : checkOverAllocation(input.consumedQty, session.startingBalanceQty);
  if (overAllocError) return { ok: false, error: overAllocError };

  const [bagRow] = await tx
    .select({ bagQrCode: inventoryBags.bagQrCode })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, session.inventoryBagId))
    .limit(1);

  await tx.insert(rawBagAllocationEvents).values({
    allocationSessionId: session.id,
    inventoryBagId: session.inventoryBagId,
    ...(session.poId ? { poId: session.poId } : {}),
    ...(session.productId ? { productId: session.productId } : {}),
    ...(session.workflowBagId ? { workflowBagId: session.workflowBagId } : {}),
    finishedLotId: input.finishedLotId,
    eventType: "RAW_BAG_PARTIAL_CONSUMED",
    quantity: String(input.consumedQty),
    unitOfMeasure: "tablets",
    quantitySource: input.consumedQtySource ?? "MANUAL_ENTRY",
    payload: {
      session_close: true,
      notes: input.notes ?? null,
      source: "closeAllocationSessionInTx",
    },
    confidence: "HIGH",
  });

  const allocationStatus =
    input.endingBalanceQty === 0 ? ("DEPLETED" as const) : ("CLOSED" as const);

  await tx
    .update(rawBagAllocationSessions)
    .set({
      allocationStatus,
      closedAt: new Date(),
      consumedQty: input.consumedQty,
      consumedQtySource: input.consumedQtySource ?? "MANUAL_ENTRY",
      endingBalanceQty: input.endingBalanceQty,
      endingBalanceSource: input.endingBalanceSource ?? "WEIGH_BACK",
      finishedLotId: input.finishedLotId,
      confidence: "HIGH",
      ...(input.notes ? { notes: input.notes } : {}),
    })
    .where(eq(rawBagAllocationSessions.id, session.id));

  const newBagStatus = deriveBagStatusAfterClose(input.endingBalanceQty);
  if (newBagStatus != null) {
    await tx
      .update(inventoryBags)
      .set({ status: newBagStatus })
      .where(eq(inventoryBags.id, session.inventoryBagId));
  }

  const bagQrCode = bagRow?.bagQrCode ?? null;
  if (newBagStatus === "EMPTIED" && bagQrCode) {
    const [rawCard] = await tx
      .select({ id: qrCards.id, cardType: qrCards.cardType, status: qrCards.status })
      .from(qrCards)
      .where(eq(qrCards.scanToken, bagQrCode))
      .limit(1);
    if (rawCard && rawCard.cardType === "RAW_BAG" && rawCard.status === "ASSIGNED") {
      await tx.update(qrCards).set({ status: "IDLE" }).where(eq(qrCards.id, rawCard.id));
    }
  }

  await writeAudit(
    {
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      action: "raw_bag_allocation.closed",
      targetType: "RawBagAllocationSession",
      targetId: session.id,
      after: {
        finishedLotId: input.finishedLotId,
        consumedQty: input.consumedQty,
        endingBalanceQty: input.endingBalanceQty,
      },
    },
    tx,
  );

  return { ok: true };
}
