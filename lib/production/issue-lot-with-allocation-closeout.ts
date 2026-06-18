// LEAD coordinated issue: finished lot + allocation closeout in one transaction.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import {
  finishedLots,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  readBagMetrics,
  workflowBags,
} from "@/lib/db/schema";
import {
  createFinishedLotInTx,
  type CreateFinishedLotInput,
} from "@/lib/db/queries/finished-lots";
import {
  closeAllocationSessionInTx,
  openAllocationSessionInTx,
} from "@/lib/production/raw-bag-allocation-lifecycle";
import { resolveReopenStartingBalance } from "@/lib/production/bag-allocation";
import {
  computeEndingBalanceFromConsumption,
  computeExpectedTabletConsumptionFromProduct,
} from "@/lib/production/expected-tablet-consumption";
import { runProductionOutputEnqueueAfterLotCreate } from "@/lib/zoho/enqueue-production-output-after-lot-create";
import { isProductionOutputPersistEnabled } from "@/lib/zoho/production-output-config";
import { writeAudit } from "@/lib/db/audit";

export type IssueLotWithAllocationInput = {
  productId: string;
  workflowBagId: string;
  finishedLotNumber: string;
  producedOn: string;
  expiryDate: string;
  unitsProduced: number;
  displaysProduced?: number | null;
  casesProduced?: number | null;
  notes?: string | null;
  consumedQty: number;
  endingBalanceQty: number;
  /** Required when repairing a missing allocation session. */
  repairNotes?: string | null;
  /** When true, opens a missing allocation session before close. */
  repairMissingAllocation?: boolean;
  /** Manual starting balance when repairing a session with unknown starting qty. */
  repairStartingBalanceQty?: number | null;
};

export type IssueLotWithAllocationResult =
  | {
      ok: true;
      finishedLotId: string;
      allocationSessionId: string;
      expectedTabletConsumption: number | null;
      consumptionVariance: number | null;
      productionOutputOpId: string | null;
      repairedAllocation: boolean;
    }
  | { ok: false; error: string; code?: string };

export async function issueFinishedLotWithAllocationCloseout(
  input: IssueLotWithAllocationInput,
  actor: CurrentUser,
): Promise<IssueLotWithAllocationResult> {
  const [bagRow] = await db
    .select({
      bag: workflowBags,
      productSku: products.sku,
      productName: products.name,
      tabletsPerUnit: products.tabletsPerUnit,
      inventoryBagId: workflowBags.inventoryBagId,
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(eq(workflowBags.id, input.workflowBagId))
    .limit(1);

  if (!bagRow?.bag) {
    return { ok: false, error: "Workflow bag not found.", code: "BAG_NOT_FOUND" };
  }
  if (bagRow.bag.finalizedAt == null) {
    return {
      ok: false,
      error: "Workflow bag is not finalized. Complete the floor run first.",
      code: "BAG_NOT_FINALIZED",
    };
  }
  if (!bagRow.inventoryBagId) {
    return {
      ok: false,
      error: "Workflow bag has no linked inventory bag.",
      code: "MISSING_INVENTORY_BAG",
    };
  }
  if (bagRow.bag.productId !== input.productId) {
    return { ok: false, error: "Product does not match the selected workflow bag." };
  }

  const expectedResult = computeExpectedTabletConsumptionFromProduct(
    bagRow.tabletsPerUnit,
    input.unitsProduced,
  );
  const expected = expectedResult.ok ? expectedResult.expectedConsumed : null;
  const variance = expected != null ? input.consumedQty - expected : null;

  if (expected != null && input.consumedQty <= 0) {
    return {
      ok: false,
      error: "Consumed tablets must be greater than zero for a production bag.",
      code: "INVALID_CONSUMED_QTY",
    };
  }

  if (
    input.repairMissingAllocation &&
    (!input.repairNotes || input.repairNotes.trim().length < 8)
  ) {
    return {
      ok: false,
      error: "Repair notes are required when fixing a missing allocation session.",
      code: "MISSING_REPAIR_NOTES",
    };
  }

  const [openSession] = await db
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, input.workflowBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);

  if (!openSession && !input.repairMissingAllocation) {
    return {
      ok: false,
      error:
        "No open allocation session exists. Use repair allocation to open and close the source ledger.",
      code: "MISSING_ALLOCATION_SESSION",
    };
  }

  const [invBag] = await db
    .select({ batchId: inventoryBags.batchId })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, bagRow.inventoryBagId))
    .limit(1);
  if (!invBag?.batchId) {
    return {
      ok: false,
      error: "Source inventory bag has no batch linkage.",
      code: "MISSING_BATCH",
    };
  }

  if (input.endingBalanceQty < 0) {
    return {
      ok: false,
      error: "Ending balance cannot be negative.",
      code: "NEGATIVE_ENDING_BALANCE",
    };
  }

  const lotInput: CreateFinishedLotInput = {
    productId: input.productId,
    workflowBagId: input.workflowBagId,
    finishedLotNumber: input.finishedLotNumber,
    producedOn: input.producedOn,
    expiryDate: input.expiryDate,
    unitsProduced: input.unitsProduced,
    displaysProduced: input.displaysProduced ?? null,
    casesProduced: input.casesProduced ?? null,
    notes: input.notes ?? null,
    inputs: [{ batchId: invBag.batchId, qtyConsumed: input.consumedQty }],
  };

  let finishedLotId = "";
  let sessionId = "";
  let repairedAllocation = false;

  try {
    await db.transaction(async (tx) => {
      if (openSession) {
        sessionId = openSession.id;
      } else {
        const opened = await openAllocationSessionInTx(tx, {
          inventoryBagId: bagRow.inventoryBagId!,
          workflowBagId: input.workflowBagId,
          productId: input.productId,
          ...(input.repairStartingBalanceQty != null
            ? {
                startingBalanceQty: input.repairStartingBalanceQty,
                startingBalanceSource: "MANUAL_ENTRY",
              }
            : {}),
          notes: input.repairNotes ?? input.notes ?? null,
          actor,
        });
        if (!opened.ok) throw new Error(opened.error);
        sessionId = opened.sessionId;
        repairedAllocation = true;

        await writeAudit(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: "raw_bag_allocation.repair_opened",
            targetType: "RawBagAllocationSession",
            targetId: sessionId,
            after: {
              workflowBagId: input.workflowBagId,
              inventoryBagId: bagRow.inventoryBagId,
              repairNotes: input.repairNotes ?? null,
            },
          },
          tx,
        );
      }

      const { lot } = await createFinishedLotInTx(tx, lotInput, actor, {
        skipOpenAllocationSessionCheck: true,
        skipAllocationSessionLink: true,
      });
      finishedLotId = lot.id;

      const closed = await closeAllocationSessionInTx(tx, {
        sessionId: sessionId!,
        finishedLotId: lot.id,
        consumedQty: input.consumedQty,
        endingBalanceQty: input.endingBalanceQty,
        consumedQtySource: repairedAllocation
          ? "ALLOCATION_REPAIR_CLOSEOUT"
          : "FINISHED_LOT_CLOSEOUT",
        notes: [input.notes, input.repairNotes].filter(Boolean).join(" · ") || null,
        actor,
      });
      if (!closed.ok) throw new Error(closed.error);
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Issue lot failed.",
    };
  }

  let productionOutputOpId: string | null = null;
  if (isProductionOutputPersistEnabled()) {
    const enqueue = await runProductionOutputEnqueueAfterLotCreate({
      finishedLotId,
      actor: { id: actor.id, role: actor.role },
    });
    if (enqueue.ok) productionOutputOpId = enqueue.opId;
  }

  return {
    ok: true,
    finishedLotId,
    allocationSessionId: sessionId!,
    expectedTabletConsumption: expected,
    consumptionVariance: variance,
    productionOutputOpId,
    repairedAllocation,
  };
}

export async function loadOpenAllocationForWorkflowBag(workflowBagId: string) {
  const [row] = await db
    .select({
      session: rawBagAllocationSessions,
      receiptNumber: inventoryBags.internalReceiptNumber,
      bagQrCode: inventoryBags.bagQrCode,
      pillCount: inventoryBags.pillCount,
      productSku: products.sku,
      tabletsPerUnit: products.tabletsPerUnit,
    })
    .from(rawBagAllocationSessions)
    .innerJoin(
      inventoryBags,
      eq(inventoryBags.id, rawBagAllocationSessions.inventoryBagId),
    )
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, workflowBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Pure: derive repair-path starting balance from bag intake + ledger. */
export function resolveRepairStartingBalanceQty(args: {
  pillCount: number | null | undefined;
  declaredPillCount: number | null | undefined;
  lastClosedSession:
    | {
        endingBalanceQty: number | null;
        startingBalanceQty: number | null;
        consumedQty: number | null;
      }
    | null
    | undefined;
}): number | null {
  const ledger = resolveReopenStartingBalance(
    args.lastClosedSession ?? null,
    args.pillCount,
  );
  if (ledger != null) return ledger;
  if (args.declaredPillCount != null && args.declaredPillCount >= 0) {
    return args.declaredPillCount;
  }
  return null;
}

/** Starting balance hints for workflow bags on the repair (missing session) path. */
export async function loadRepairStartingBalanceHints(
  workflowBagIds: readonly string[],
): Promise<Record<string, number>> {
  if (workflowBagIds.length === 0) return {};

  const bagRows = await db
    .select({
      workflowBagId: workflowBags.id,
      inventoryBagId: workflowBags.inventoryBagId,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .where(inArray(workflowBags.id, [...workflowBagIds]));

  const inventoryBagIds = [
    ...new Set(
      bagRows
        .map((r) => r.inventoryBagId)
        .filter((id): id is string => id != null),
    ),
  ];

  const lastClosedByBag = new Map<
    string,
    {
      endingBalanceQty: number | null;
      startingBalanceQty: number | null;
      consumedQty: number | null;
    }
  >();

  if (inventoryBagIds.length > 0) {
    const closedRows = await db
      .select({
        inventoryBagId: rawBagAllocationSessions.inventoryBagId,
        endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
        startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
        consumedQty: rawBagAllocationSessions.consumedQty,
        closedAt: rawBagAllocationSessions.closedAt,
      })
      .from(rawBagAllocationSessions)
      .where(
        and(
          inArray(rawBagAllocationSessions.inventoryBagId, inventoryBagIds),
          eq(rawBagAllocationSessions.allocationStatus, "CLOSED"),
        ),
      )
      .orderBy(desc(rawBagAllocationSessions.closedAt));

    for (const row of closedRows) {
      if (!lastClosedByBag.has(row.inventoryBagId)) {
        lastClosedByBag.set(row.inventoryBagId, {
          endingBalanceQty: row.endingBalanceQty,
          startingBalanceQty: row.startingBalanceQty,
          consumedQty: row.consumedQty,
        });
      }
    }
  }

  const hints: Record<string, number> = {};
  for (const row of bagRows) {
    if (!row.inventoryBagId) continue;
    const starting = resolveRepairStartingBalanceQty({
      pillCount: row.pillCount,
      declaredPillCount: row.declaredPillCount,
      lastClosedSession: lastClosedByBag.get(row.inventoryBagId) ?? null,
    });
    if (starting != null) {
      hints[row.workflowBagId] = starting;
    }
  }
  return hints;
}

export function deriveIssueLotPrefill(args: {
  tabletsPerUnit: number | null | undefined;
  unitsProduced: number;
  startingBalanceQty: number | null | undefined;
}) {
  const expected = computeExpectedTabletConsumptionFromProduct(
    args.tabletsPerUnit,
    args.unitsProduced,
  );
  if (!expected.ok) return { expected, consumedQty: null, endingBalanceQty: null };
  const endingBalanceQty = computeEndingBalanceFromConsumption(
    args.startingBalanceQty,
    expected.expectedConsumed,
  );
  return {
    expected,
    consumedQty: expected.expectedConsumed,
    endingBalanceQty,
  };
}
