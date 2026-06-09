// LEAD coordinated issue: finished lot + allocation closeout in one transaction.

import { and, eq, isNull, sql } from "drizzle-orm";
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
import {
  CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  CHOCO_DRIFT_SKU,
  isChocoDriftSku,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";
import { runProductionOutputEnqueueAfterLotCreate } from "@/lib/zoho/enqueue-production-output-after-lot-create";
import { isProductionOutputPersistEnabled } from "@/lib/zoho/production-output-config";

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
  /** When true, consumed qty must match Choco Drift BOM (4 × units). */
  requireExactChocoConsumption?: boolean;
};

export type IssueLotWithAllocationResult =
  | {
      ok: true;
      finishedLotId: string;
      allocationSessionId: string;
      expectedTabletConsumption: number | null;
      consumptionVariance: number | null;
      productionOutputOpId: string | null;
    }
  | { ok: false; error: string; code?: string };

export function computeExpectedTabletConsumption(
  sku: string,
  unitsProduced: number,
): number | null {
  if (!isChocoDriftSku(sku)) return null;
  return CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT * unitsProduced;
}

export async function issueFinishedLotWithAllocationCloseout(
  input: IssueLotWithAllocationInput,
  actor: CurrentUser,
): Promise<IssueLotWithAllocationResult> {
  const [bagRow] = await db
    .select({
      bag: workflowBags,
      productSku: products.sku,
      productName: products.name,
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

  const expected = computeExpectedTabletConsumption(
    bagRow.productSku ?? "",
    input.unitsProduced,
  );
  const variance =
    expected != null ? input.consumedQty - expected : null;
  if (
    input.requireExactChocoConsumption !== false &&
    expected != null &&
    input.consumedQty !== expected
  ) {
    return {
      ok: false,
      error: `Consumed tablets (${input.consumedQty}) must equal expected ${expected} (4 × ${input.unitsProduced} units) for Choco Drift.`,
      code: "CONSUMPTION_MISMATCH",
    };
  }

  let sessionId: string;
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

  try {
    await db.transaction(async (tx) => {
      if (openSession) {
        sessionId = openSession.id;
      } else {
        const opened = await openAllocationSessionInTx(tx, {
          inventoryBagId: bagRow.inventoryBagId!,
          workflowBagId: input.workflowBagId,
          productId: input.productId,
          actor,
        });
        if (!opened.ok) throw new Error(opened.error);
        sessionId = opened.sessionId;
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
        consumedQtySource: "FINISHED_LOT_CLOSEOUT",
        notes: input.notes ?? null,
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
