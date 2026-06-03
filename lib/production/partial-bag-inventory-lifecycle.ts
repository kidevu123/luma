// PARTIAL-BAG-NOT-LISTED-AFTER-PARTIAL-PACKAGING-1 — safe inventory return
// after partial downstream packaging. Never derives tablet counts from sealed cards.

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  deriveBagStatusAfterClose,
  reduceLedger,
  type LedgerEntry,
} from "@/lib/production/bag-allocation";
import {
  inventoryBags,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import {
  withAccountabilityPayload,
  type AccountabilityForEvent,
} from "@/lib/production/station-operator-session";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type SessionLedgerRow = LedgerEntry & {
  payload?: Record<string, unknown> | null;
};

export type SafeSessionReturnEstimate =
  | { ok: true; remainingQty: number; source: "LEDGER_REWEIGH" | "LEDGER_CONSUMED" }
  | { ok: false; reason: string };

/** Remaining tablets safe to return — only from allocation ledger evidence,
 *  never from sealed card counts. */
export function deriveSafeSessionReturnEstimate(
  events: readonly SessionLedgerRow[],
): SafeSessionReturnEstimate {
  const hasReweigh = events.some((e) => e.eventType === "RAW_BAG_REWEIGHED");
  const hasManualConsumed = events.some(
    (e) =>
      e.eventType === "RAW_BAG_PARTIAL_CONSUMED" &&
      !isFabricatedLedgerEvent(e),
  );
  const hasOpened = events.some((e) => e.eventType === "RAW_BAG_OPENED");

  if (!hasOpened) {
    return {
      ok: false,
      reason: "Allocation session has no opening balance recorded.",
    };
  }
  if (!hasReweigh && !hasManualConsumed) {
    return {
      ok: false,
      reason:
        "No manual tablet consumption or weigh-back on this allocation session.",
    };
  }

  const balance = reduceLedger(events);
  if (balance.remainingEstimate == null || balance.remainingEstimate <= 0) {
    return {
      ok: false,
      reason: "Ledger shows no remaining tablets to return.",
    };
  }

  return {
    ok: true,
    remainingQty: balance.remainingEstimate,
    source: hasReweigh ? "LEDGER_REWEIGH" : "LEDGER_CONSUMED",
  };
}

function isFabricatedLedgerEvent(e: SessionLedgerRow): boolean {
  if (e.payload?.lazy_fallback === true) return true;
  if (e.payload?.partial_packaging_derived === true) return true;
  return false;
}

async function loadSessionLedgerEntries(
  tx: DbTx,
  sessionId: string,
): Promise<SessionLedgerRow[]> {
  const rows = await tx
    .select({
      eventType: rawBagAllocationEvents.eventType,
      quantity: rawBagAllocationEvents.quantity,
      payload: rawBagAllocationEvents.payload,
    })
    .from(rawBagAllocationEvents)
    .where(eq(rawBagAllocationEvents.allocationSessionId, sessionId))
    .orderBy(rawBagAllocationEvents.occurredAt);

  return rows.map((row) => ({
    eventType: row.eventType,
    quantity:
      row.quantity != null && row.quantity !== ""
        ? Number(row.quantity)
        : null,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
  }));
}

/** After partial packaging, return remaining tablets when the OPEN allocation
 *  session ledger proves a safe ending balance. Skips when unsafe. */
export async function maybeReturnInventoryAfterPartialPackaging(
  tx: DbTx,
  args: {
    workflowBagId: string;
    inventoryBagId: string;
    stationId: string;
    accountability: AccountabilityForEvent;
    clientEventId?: string | null;
  },
): Promise<{ returned: boolean; reason?: string }> {
  const [openSession] = await tx
    .select({
      id: rawBagAllocationSessions.id,
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      poId: rawBagAllocationSessions.poId,
      productId: rawBagAllocationSessions.productId,
      routeId: rawBagAllocationSessions.routeId,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.openedAt))
    .limit(1);

  if (!openSession) {
    return { returned: false, reason: "no_open_allocation_session" };
  }

  const ledgerEvents = await loadSessionLedgerEntries(tx, openSession.id);
  const estimate = deriveSafeSessionReturnEstimate(ledgerEvents);
  if (!estimate.ok) {
    return { returned: false, reason: estimate.reason };
  }

  const clientBase = args.clientEventId ?? randomUUID();
  await tx.insert(rawBagAllocationEvents).values({
    allocationSessionId: openSession.id,
    inventoryBagId: openSession.inventoryBagId,
    ...(openSession.poId ? { poId: openSession.poId } : {}),
    ...(openSession.productId ? { productId: openSession.productId } : {}),
    ...(openSession.routeId ? { routeId: openSession.routeId } : {}),
    ...(openSession.workflowBagId || args.workflowBagId
      ? { workflowBagId: openSession.workflowBagId ?? args.workflowBagId }
      : {}),
    eventType: "RAW_BAG_RETURNED_TO_STOCK",
    quantity: String(estimate.remainingQty),
    unitOfMeasure: "tablets",
    quantitySource: "LEDGER_DERIVED",
    payload: withAccountabilityPayload(
      {
        partial_packaging_return: true,
        ledger_source: estimate.source,
      },
      args.accountability,
    ),
    confidence: estimate.source === "LEDGER_REWEIGH" ? "HIGH" : "MEDIUM",
    clientEventId: `${clientBase}-partial-pkg-return`,
  });

  await tx
    .update(rawBagAllocationSessions)
    .set({
      allocationStatus: "RETURNED_TO_STOCK",
      closedAt: new Date(),
      endingBalanceQty: estimate.remainingQty,
      endingBalanceSource: "LEDGER_DERIVED",
    })
    .where(eq(rawBagAllocationSessions.id, openSession.id));

  const newBagStatus = deriveBagStatusAfterClose(estimate.remainingQty);
  if (newBagStatus != null) {
    await tx
      .update(inventoryBags)
      .set({ status: newBagStatus })
      .where(eq(inventoryBags.id, openSession.inventoryBagId));
  }

  return { returned: true };
}
