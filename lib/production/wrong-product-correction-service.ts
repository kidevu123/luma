// ADMIN-CORRECTION-WIZARD-1 — transactional apply for wrong-product
// corrections. Loads facts, re-runs the pure evaluator inside the same
// transaction (fail closed at apply time, not just preview time), then
// remaps the workflow bag's product using the existing audited patterns:
//
//   1. workflow_bags.product_id update (audited)
//   2. PRODUCT_MAPPED event (source ADMIN_WRONG_PRODUCT_CORRECTION) — the
//      projector overwrites read_bag_state.product_id/product_name
//   3. reprojectBagMetricsForWorkflowBag — recomputes counts/units under
//      the corrected product + refreshes sku/station/material read models
//   4. terminal allocation session recalc + RAW_BAG_ADJUSTED ledger event
//   5. finished lot rebuild (product, units, ON_HOLD) + passport reproject
//   6. void uncommitted Zoho production output ops
//   7. audit_log entry with the full before/after snapshot
//
// Never touches: workflow event history, committed Zoho ops, QR state.

import { and, eq, isNull, ne } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { db as Db } from "@/lib/db";
import {
  finishedLotInputs,
  finishedLots,
  inventoryBags,
  productAllowedTablets,
  products,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
  readBagMetrics,
  readBagState,
  workflowBags,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import type { CurrentUser } from "@/lib/auth";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { reprojectBagMetricsForWorkflowBag } from "@/lib/projector/reproject-bag-metrics";
import { projectFinishedLotPassportForLot } from "@/lib/projector/finished-lot-passport";
import { loadZohoOutputCommittedForWorkflowBag } from "@/lib/production/correction-downstream-effects";
import {
  WRONG_PRODUCT_CORRECTION_SOURCE,
  buildWrongProductCorrectionPreview,
  computeExpectedConsumption,
  computeUnitsUnderProduct,
  evaluateWrongProductCorrection,
  type CorrectionProductFacts,
  type WrongProductCorrectionCounts,
  type WrongProductCorrectionPreview,
  type WrongProductCorrectionVerdict,
} from "@/lib/production/wrong-product-correction";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export type WrongProductCorrectionContext = {
  workflowBagId: string;
  inventoryBagId: string | null;
  receiptNumber: string | null;
  tabletTypeId: string | null;
  isFinalized: boolean;
  stage: string | null;
  alreadyQuarantined: boolean;
  oldProduct: CorrectionProductFacts | null;
  newProduct: CorrectionProductFacts | null;
  counts: WrongProductCorrectionCounts | null;
  lot: { id: string; status: string } | null;
  zohoOutputCommitted: boolean;
  uncommittedOpIds: string[];
  allocationSessions: Array<{
    id: string;
    status: string;
    startingBalanceQty: number | null;
    consumedQty: number | null;
    endingBalanceQty: number | null;
    poId: string | null;
  }>;
  verdict: WrongProductCorrectionVerdict;
  preview: WrongProductCorrectionPreview;
};

async function loadProductFacts(
  tx: Tx,
  productId: string | null,
  tabletTypeId: string | null,
): Promise<CorrectionProductFacts | null> {
  if (!productId) return null;
  const [p] = await tx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      kind: products.kind,
      tabletsPerUnit: products.tabletsPerUnit,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
      defaultShelfLifeDays: products.defaultShelfLifeDays,
      isActive: products.isActive,
    })
    .from(products)
    .where(eq(products.id, productId));
  if (!p) return null;

  let allowsBagTabletType = false;
  if (tabletTypeId) {
    const [allowed] = await tx
      .select({ productId: productAllowedTablets.productId })
      .from(productAllowedTablets)
      .where(
        and(
          eq(productAllowedTablets.productId, productId),
          eq(productAllowedTablets.tabletTypeId, tabletTypeId),
        ),
      )
      .limit(1);
    allowsBagTabletType = Boolean(allowed);
  }
  return { ...p, allowsBagTabletType };
}

export async function loadWrongProductCorrectionContext(
  tx: Tx,
  args: { workflowBagId: string; newProductId: string | null },
): Promise<WrongProductCorrectionContext> {
  const [bag] = await tx
    .select({
      id: workflowBags.id,
      productId: workflowBags.productId,
      inventoryBagId: workflowBags.inventoryBagId,
      receiptNumber: workflowBags.receiptNumber,
    })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId));
  if (!bag) throw new Error("Workflow bag not found.");

  const [state] = await tx
    .select({
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      recoveryStatus: readBagState.recoveryStatus,
      excludedFromOutput: readBagState.excludedFromOutput,
    })
    .from(readBagState)
    .where(eq(readBagState.workflowBagId, args.workflowBagId));
  if (!state) throw new Error("Bag state not found.");

  let tabletTypeId: string | null = null;
  if (bag.inventoryBagId) {
    const [inv] = await tx
      .select({ tabletTypeId: inventoryBags.tabletTypeId })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, bag.inventoryBagId));
    tabletTypeId = inv?.tabletTypeId ?? null;
  }

  const oldProduct = await loadProductFacts(tx, bag.productId, tabletTypeId);
  const newProduct = await loadProductFacts(tx, args.newProductId, tabletTypeId);

  const [metrics] = await tx
    .select({
      masterCases: readBagMetrics.masterCases,
      displaysMade: readBagMetrics.displaysMade,
      looseCards: readBagMetrics.looseCards,
    })
    .from(readBagMetrics)
    .where(eq(readBagMetrics.workflowBagId, args.workflowBagId));
  const counts: WrongProductCorrectionCounts | null = metrics
    ? {
        masterCases: metrics.masterCases,
        displaysMade: metrics.displaysMade,
        looseCards: metrics.looseCards,
        bottlesCompleted: 0,
      }
    : null;

  const [lot] = await tx
    .select({ id: finishedLots.id, status: finishedLots.status })
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, args.workflowBagId))
    .limit(1);

  const zohoOutputCommitted = await loadZohoOutputCommittedForWorkflowBag(
    tx,
    args.workflowBagId,
  );

  let uncommittedOpIds: string[] = [];
  if (lot) {
    const ops = await tx
      .select({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status })
      .from(zohoProductionOutputOps)
      .where(
        and(
          eq(zohoProductionOutputOps.finishedLotId, lot.id),
          isNull(zohoProductionOutputOps.voidedAt),
        ),
      );
    uncommittedOpIds = ops
      .filter((op) => op.status !== "COMMITTED")
      .map((op) => op.id);
  }

  const sessions = await tx
    .select({
      id: rawBagAllocationSessions.id,
      status: rawBagAllocationSessions.allocationStatus,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      poId: rawBagAllocationSessions.poId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.workflowBagId, args.workflowBagId),
        ne(rawBagAllocationSessions.allocationStatus, "VOIDED"),
      ),
    );

  const evaluatorArgs = {
    oldProduct,
    newProduct,
    isFinalized: state.isFinalized,
    alreadyQuarantined: Boolean(
      state.excludedFromOutput || state.recoveryStatus,
    ),
    zohoOutputCommitted,
    lotStatus: lot?.status ?? null,
    allocationSessions: sessions.map((s) => ({
      status: s.status,
      startingBalanceQty: s.startingBalanceQty,
    })),
    counts,
  };

  return {
    workflowBagId: args.workflowBagId,
    inventoryBagId: bag.inventoryBagId,
    receiptNumber: bag.receiptNumber,
    tabletTypeId,
    isFinalized: state.isFinalized,
    stage: state.stage,
    alreadyQuarantined: evaluatorArgs.alreadyQuarantined,
    oldProduct,
    newProduct,
    counts,
    lot: lot ?? null,
    zohoOutputCommitted,
    uncommittedOpIds,
    allocationSessions: sessions,
    verdict: evaluateWrongProductCorrection(evaluatorArgs),
    preview: buildWrongProductCorrectionPreview({
      ...evaluatorArgs,
      hasUncommittedZohoOp: uncommittedOpIds.length > 0,
    }),
  };
}

/** Candidate correct products: active, same route/kind as the current
 *  product, allowed for the bag's tablet type, not the current product. */
export async function listWrongProductCorrectionCandidates(
  tx: Tx,
  args: {
    currentProductId: string;
    currentProductKind: string;
    tabletTypeId: string | null;
  },
): Promise<
  Array<{ id: string; sku: string; name: string; kind: string }>
> {
  if (!args.tabletTypeId) return [];
  return tx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      kind: products.kind,
    })
    .from(productAllowedTablets)
    .innerJoin(products, eq(products.id, productAllowedTablets.productId))
    .where(
      and(
        eq(productAllowedTablets.tabletTypeId, args.tabletTypeId),
        eq(products.kind, args.currentProductKind as "CARD" | "BOTTLE" | "VARIETY"),
        eq(products.isActive, true),
        ne(products.id, args.currentProductId),
      ),
    )
    .orderBy(products.name);
}

export type ApplyWrongProductCorrectionResult = {
  workflowBagId: string;
  oldProductId: string;
  newProductId: string;
  finishedLotId: string | null;
  finishedLotHeld: boolean;
  voidedZohoOpIds: string[];
  allocationSessionAdjusted: boolean;
  newUnits: number | null;
  newConsumed: number | null;
};

export async function applyWrongProductCorrectionInTx(
  tx: Tx,
  args: {
    workflowBagId: string;
    newProductId: string;
    reason: string;
    notes: string | null;
    actor: CurrentUser;
  },
): Promise<ApplyWrongProductCorrectionResult> {
  const ctx = await loadWrongProductCorrectionContext(tx, {
    workflowBagId: args.workflowBagId,
    newProductId: args.newProductId,
  });

  // Fail closed: re-evaluate everything inside the transaction.
  if (!ctx.verdict.allowed) {
    const first = ctx.verdict.blockers[0];
    throw new Error(
      first
        ? `${first.message} ${first.recommendation}`
        : "Wrong-product correction blocked.",
    );
  }
  if (!ctx.oldProduct || !ctx.newProduct) {
    throw new Error("Product facts could not be loaded.");
  }

  const newUnits = ctx.counts
    ? computeUnitsUnderProduct(ctx.counts, ctx.newProduct)
    : null;
  const newConsumed = computeExpectedConsumption(
    newUnits,
    ctx.newProduct.tabletsPerUnit,
  );

  // 1. Remap the bag's product (source of truth for all product joins).
  await tx
    .update(workflowBags)
    .set({ productId: ctx.newProduct.id })
    .where(eq(workflowBags.id, ctx.workflowBagId));

  // 2. Append the audited product-mapping event. The projector reads
  //    workflow_bags.product_id (already updated) and overwrites
  //    read_bag_state.product_id/product_name.
  await projectEvent(tx, {
    workflowBagId: ctx.workflowBagId,
    eventType: "PRODUCT_MAPPED",
    payload: {
      product_id: ctx.newProduct.id,
      product_sku: ctx.newProduct.sku,
      product_name: ctx.newProduct.name,
      product_kind: ctx.newProduct.kind,
      source: WRONG_PRODUCT_CORRECTION_SOURCE,
      correction: {
        old_product_id: ctx.oldProduct.id,
        old_product_name: ctx.oldProduct.name,
        old_product_kind: ctx.oldProduct.kind,
        new_product_id: ctx.newProduct.id,
        new_product_name: ctx.newProduct.name,
        reason: args.reason,
        notes: args.notes,
        counts_snapshot: ctx.counts,
      },
    },
    clientEventId: randomUUID(),
    enteredByUserId: args.actor.id,
    accountabilitySource: "SUPERVISOR_OVERRIDE",
    accountableEmployeeNameSnapshot: args.actor.email,
  });

  // 3. Recompute derived metrics under the corrected product.
  await reprojectBagMetricsForWorkflowBag(tx, ctx.workflowBagId);
  await tx
    .update(readBagMetrics)
    .set({ productId: ctx.newProduct.id })
    .where(eq(readBagMetrics.workflowBagId, ctx.workflowBagId));
  await tx
    .update(readBagState)
    .set({ hasCorrection: true })
    .where(eq(readBagState.workflowBagId, ctx.workflowBagId));

  // 4. Rewrite the terminal allocation session's consumption math.
  let allocationSessionAdjusted = false;
  const session =
    ctx.allocationSessions.length === 1 ? ctx.allocationSessions[0] : null;
  if (
    session &&
    session.status !== "OPEN" &&
    newConsumed != null &&
    session.startingBalanceQty != null
  ) {
    const newEnding = session.startingBalanceQty - newConsumed;
    await tx
      .update(rawBagAllocationSessions)
      .set({
        productId: ctx.newProduct.id,
        consumedQty: newConsumed,
        consumedQtySource: WRONG_PRODUCT_CORRECTION_SOURCE,
        endingBalanceQty: newEnding,
        endingBalanceSource: WRONG_PRODUCT_CORRECTION_SOURCE,
        updatedAt: new Date(),
      })
      .where(eq(rawBagAllocationSessions.id, session.id));
    if (ctx.inventoryBagId) {
      await tx.insert(rawBagAllocationEvents).values({
        allocationSessionId: session.id,
        inventoryBagId: ctx.inventoryBagId,
        ...(session.poId ? { poId: session.poId } : {}),
        productId: ctx.newProduct.id,
        workflowBagId: ctx.workflowBagId,
        eventType: "RAW_BAG_ADJUSTED",
        quantity: String(newConsumed),
        unitOfMeasure: "tablets",
        quantitySource: WRONG_PRODUCT_CORRECTION_SOURCE,
        ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
        payload: {
          admin_correction: "wrong_product_correction",
          old_product_id: ctx.oldProduct.id,
          new_product_id: ctx.newProduct.id,
          old_consumed_qty: session.consumedQty,
          new_consumed_qty: newConsumed,
          old_ending_balance_qty: session.endingBalanceQty,
          new_ending_balance_qty: newEnding,
          reason: args.reason,
        },
      });
    }
    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: args.actor.role,
        action: "raw_bag_allocation.wrong_product_correction",
        targetType: "RawBagAllocationSession",
        targetId: session.id,
        before: {
          product_id: ctx.oldProduct.id,
          consumed_qty: session.consumedQty,
          ending_balance_qty: session.endingBalanceQty,
        },
        after: {
          product_id: ctx.newProduct.id,
          consumed_qty: newConsumed,
          ending_balance_qty: newEnding,
        },
      },
      tx,
    );
    allocationSessionAdjusted = true;
  }

  // 5. Rebuild the finished lot (if any) under the corrected product and
  //    hold it for re-review. Blockers already excluded committed /
  //    shipped / recalled lots.
  let finishedLotHeld = false;
  if (ctx.lot) {
    const [freshMetrics] = await tx
      .select({
        masterCases: readBagMetrics.masterCases,
        displaysMade: readBagMetrics.displaysMade,
        unitsYielded: readBagMetrics.unitsYielded,
      })
      .from(readBagMetrics)
      .where(eq(readBagMetrics.workflowBagId, ctx.workflowBagId));
    await tx
      .update(finishedLots)
      .set({
        productId: ctx.newProduct.id,
        ...(freshMetrics
          ? {
              unitsProduced: freshMetrics.unitsYielded,
              displaysProduced: freshMetrics.displaysMade,
              casesProduced: freshMetrics.masterCases,
            }
          : {}),
        status: "ON_HOLD",
      })
      .where(eq(finishedLots.id, ctx.lot.id));
    finishedLotHeld = true;

    if (newConsumed != null) {
      await tx
        .update(finishedLotInputs)
        .set({ qtyConsumed: newConsumed })
        .where(eq(finishedLotInputs.finishedLotId, ctx.lot.id));
    }

    await projectFinishedLotPassportForLot(tx, ctx.lot.id);

    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: args.actor.role,
        action: "finished_lot.wrong_product_correction",
        targetType: "FinishedLot",
        targetId: ctx.lot.id,
        before: { product_id: ctx.oldProduct.id, status: ctx.lot.status },
        after: {
          product_id: ctx.newProduct.id,
          status: "ON_HOLD",
          units_produced: freshMetrics?.unitsYielded ?? null,
          reason:
            "Wrong-product correction — lot rebuilt under corrected product; re-review and re-release.",
        },
      },
      tx,
    );
  }

  // 6. Void stale uncommitted Zoho ops — a fresh preview/queue is required.
  const voidedZohoOpIds: string[] = [];
  for (const opId of ctx.uncommittedOpIds) {
    await tx
      .update(zohoProductionOutputOps)
      .set({
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: args.actor.id,
        voidReason:
          "Voided after wrong-product correction — re-preview and queue with corrected product.",
        updatedAt: new Date(),
      })
      .where(eq(zohoProductionOutputOps.id, opId));
    voidedZohoOpIds.push(opId);
  }

  // 7. Main audit entry — full before/after snapshot.
  await writeAudit(
    {
      actorId: args.actor.id,
      actorRole: args.actor.role,
      action: "workflow_submissions.wrong_product_correction",
      targetType: "WorkflowBag",
      targetId: ctx.workflowBagId,
      before: {
        product_id: ctx.oldProduct.id,
        product_name: ctx.oldProduct.name,
        route: ctx.oldProduct.kind,
        counts: ctx.counts,
        finished_lot_id: ctx.lot?.id ?? null,
        finished_lot_status: ctx.lot?.status ?? null,
      },
      after: {
        source: WRONG_PRODUCT_CORRECTION_SOURCE,
        inventory_bag_id: ctx.inventoryBagId,
        receipt_number: ctx.receiptNumber,
        product_id: ctx.newProduct.id,
        product_name: ctx.newProduct.name,
        route: ctx.newProduct.kind,
        units_yielded: newUnits,
        expected_consumption: newConsumed,
        finished_lot_id: ctx.lot?.id ?? null,
        finished_lot_held: finishedLotHeld,
        voided_zoho_op_ids: voidedZohoOpIds,
        allocation_session_adjusted: allocationSessionAdjusted,
        reason: args.reason,
        notes: args.notes,
      },
    },
    tx,
  );

  return {
    workflowBagId: ctx.workflowBagId,
    oldProductId: ctx.oldProduct.id,
    newProductId: ctx.newProduct.id,
    finishedLotId: ctx.lot?.id ?? null,
    finishedLotHeld,
    voidedZohoOpIds,
    allocationSessionAdjusted,
    newUnits,
    newConsumed,
  };
}
