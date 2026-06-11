// P0-ALLOC-REPAIR — shared open helper for the lead "open/repair source
// allocation" action.
//
// NOTE: production start paths use the canonical
// lib/production/raw-bag-allocation-lifecycle.ts helpers
// (ensureOpenAllocationForProductionStartInTx). This module exists for
// the REPAIR path only: a run already in flight whose allocation is
// missing (legacy start) or prematurely closed (reopen). It adds the
// repair-specific semantics the lifecycle helper does not cover:
// adopting an unlinked OPEN session, reopening from the last closed
// balance, and operator-facing blocked errors.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { resolveReopenStartingBalance } from "@/lib/production/bag-allocation";
import {
  withAccountabilityPayload,
  type AccountabilityForEvent,
} from "@/lib/production/station-operator-session";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export type AllocationAutoOpenSource = "LEAD_REPAIR";

export type AllocationOpenBlockedCode =
  | "BAG_NOT_FOUND"
  | "BAG_BLOCKED_STATUS"
  | "OPEN_SESSION_OTHER_RUN"
  | "OPEN_SESSION_RACE";

/** Thrown when an allocation session cannot be opened for the repair.
 *  The message is operator-facing and always names the next action. */
export class AllocationOpenBlockedError extends Error {
  readonly code: AllocationOpenBlockedCode;
  constructor(code: AllocationOpenBlockedCode, message: string) {
    super(message);
    this.name = "AllocationOpenBlockedError";
    this.code = code;
  }
}

export type ExistingOpenSessionDecision =
  | { kind: "reuse"; sessionId: string }
  | { kind: "adopt"; sessionId: string }
  | { kind: "blocked"; code: "OPEN_SESSION_OTHER_RUN"; message: string };

/**
 * Pure decision: what to do when the bag already has an OPEN session.
 *  - Same workflow bag → reuse (idempotent repair tap).
 *  - No workflow bag linked → adopt it onto this run.
 *  - Linked to a DIFFERENT run → blocked; the previous run never closed
 *    out and must be resolved first.
 */
export function decideExistingOpenSession(
  open: { id: string; workflowBagId: string | null },
  newWorkflowBagId: string,
): ExistingOpenSessionDecision {
  if (open.workflowBagId === newWorkflowBagId) {
    return { kind: "reuse", sessionId: open.id };
  }
  if (open.workflowBagId == null) {
    return { kind: "adopt", sessionId: open.id };
  }
  return {
    kind: "blocked",
    code: "OPEN_SESSION_OTHER_RUN",
    message:
      "This bag still has an open source allocation from a previous run. " +
      "Close it out on the Partial Bag Workbench before repairing this one.",
  };
}

/** Operator-facing message for a bag whose inventory status blocks the
 *  repair. */
export function blockedBagStatusMessage(status: string): string {
  const pretty = status.toLowerCase().replace(/_/g, " ");
  return (
    `This bag is ${pretty} and cannot be allocated. ` +
    "Review it on the Partial Bag Workbench before reuse."
  );
}

export type AutoOpenAllocationArgs = {
  inventoryBagId: string;
  workflowBagId: string;
  productId?: string | null;
  accountability: AccountabilityForEvent;
  source: AllocationAutoOpenSource;
  clientEventId?: string | null;
  notes?: string | null;
};

export type AutoOpenAllocationResult = {
  sessionId: string;
  /** True when an existing OPEN session was reused/adopted instead of
   *  inserting a new one. */
  reused: boolean;
  startingBalanceQty: number | null;
};

/**
 * Open (or reuse) the source-bag allocation session for the lead
 * repair, inside the caller's transaction. Throws
 * AllocationOpenBlockedError with operator guidance when blocked.
 */
export async function openAllocationSessionForBagStart(
  tx: Tx,
  args: AutoOpenAllocationArgs,
): Promise<AutoOpenAllocationResult> {
  const [bag] = await tx
    .select({
      id: inventoryBags.id,
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, args.inventoryBagId))
    .limit(1);
  if (!bag) {
    throw new AllocationOpenBlockedError(
      "BAG_NOT_FOUND",
      "This run is not linked to a received bag, so a source allocation " +
        "cannot be opened. Receive the bag first, then repair.",
    );
  }
  if (bag.status === "VOID" || bag.status === "QUARANTINED") {
    throw new AllocationOpenBlockedError(
      "BAG_BLOCKED_STATUS",
      blockedBagStatusMessage(bag.status),
    );
  }

  const poId = await lookupPoIdForBag(tx, args.inventoryBagId);

  const [openSession] = await tx
    .select({
      id: rawBagAllocationSessions.id,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);

  if (openSession) {
    const decision = decideExistingOpenSession(openSession, args.workflowBagId);
    if (decision.kind === "blocked") {
      throw new AllocationOpenBlockedError(decision.code, decision.message);
    }
    if (decision.kind === "adopt") {
      await tx
        .update(rawBagAllocationSessions)
        .set({
          workflowBagId: args.workflowBagId,
          ...(args.productId ? { productId: args.productId } : {}),
        })
        .where(eq(rawBagAllocationSessions.id, decision.sessionId));
    }
    await tx
      .update(inventoryBags)
      .set({ status: "IN_USE" })
      .where(eq(inventoryBags.id, args.inventoryBagId));
    return {
      sessionId: decision.sessionId,
      reused: true,
      startingBalanceQty: openSession.startingBalanceQty,
    };
  }

  // Fresh session: derive the starting balance from the last closed
  // session's ending balance (partial reuse) or fall back to the
  // declared pill count (fresh bag).
  const [lastClosed] = await tx
    .select({
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      consumedQty: rawBagAllocationSessions.consumedQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        inArray(rawBagAllocationSessions.allocationStatus, [
          "CLOSED",
          "RETURNED_TO_STOCK",
        ]),
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.closedAt))
    .limit(1);

  const hadPriorSession = lastClosed != null;
  const startingBalance = resolveReopenStartingBalance(
    lastClosed ?? null,
    bag.pillCount,
  );
  const startingSource = hadPriorSession ? "LEDGER_DERIVED" : "VENDOR_DECLARED";

  let sessionId: string;
  try {
    const inserted = await tx
      .insert(rawBagAllocationSessions)
      .values({
        inventoryBagId: args.inventoryBagId,
        workflowBagId: args.workflowBagId,
        ...(poId ? { poId } : {}),
        ...(args.productId ? { productId: args.productId } : {}),
        allocationStatus: "OPEN",
        ...(startingBalance != null
          ? { startingBalanceQty: startingBalance }
          : {}),
        startingBalanceSource: startingSource,
        unitOfMeasure: "tablets",
        confidence: "LOW",
        ...(args.notes ? { notes: args.notes } : {}),
      })
      .returning({ id: rawBagAllocationSessions.id });
    const session = inserted[0];
    if (!session) throw new Error("Allocation session insert returned no id.");
    sessionId = session.id;
  } catch (err) {
    // Concurrent open on the same bag trips the one-OPEN-per-bag
    // partial unique index (rba_sessions_one_open_per_bag).
    if (isUniqueOpenSessionViolation(err)) {
      throw new AllocationOpenBlockedError(
        "OPEN_SESSION_RACE",
        "Another station just opened this bag. Refresh and try again.",
      );
    }
    throw err;
  }

  await tx.insert(rawBagAllocationEvents).values({
    allocationSessionId: sessionId,
    inventoryBagId: args.inventoryBagId,
    workflowBagId: args.workflowBagId,
    ...(poId ? { poId } : {}),
    ...(args.productId ? { productId: args.productId } : {}),
    eventType: "RAW_BAG_OPENED",
    ...(startingBalance != null ? { quantity: String(startingBalance) } : {}),
    unitOfMeasure: "tablets",
    quantitySource: startingSource,
    payload: withAccountabilityPayload(
      {
        auto_opened: true,
        source: args.source,
        notes: args.notes ?? null,
      },
      args.accountability,
    ),
    confidence: "MEDIUM",
    ...(args.clientEventId ? { clientEventId: args.clientEventId } : {}),
  });

  await tx
    .update(inventoryBags)
    .set({ status: "IN_USE" })
    .where(eq(inventoryBags.id, args.inventoryBagId));

  return { sessionId, reused: false, startingBalanceQty: startingBalance };
}

/** Walk inventory_bag → small_box → receive → PO. Returns null when the
 *  chain is incomplete (legacy bags). */
async function lookupPoIdForBag(
  tx: Tx,
  inventoryBagId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT po.id::text AS po_id
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb     ON sb.id = ib.small_box_id
    LEFT JOIN receives r         ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${inventoryBagId}
    LIMIT 1
  `)) as unknown as Array<{ po_id: string | null }>;
  return rows[0]?.po_id ?? null;
}

/** Postgres 23505 on the partial unique OPEN-session index. */
function isUniqueOpenSessionViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === "23505") return true;
  return Boolean(e.message?.includes("rba_sessions_one_open_per_bag"));
}
