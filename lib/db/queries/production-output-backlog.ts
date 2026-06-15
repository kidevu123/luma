import { and, desc, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  readBagMetrics,
  readBagState,
  workflowBags,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import {
  evaluateAutoLotBacklogRow,
  type AutoLotBacklogEvaluation,
} from "@/lib/production/auto-lot-backlog-eligibility";
import {
  evaluateProductSetupReadiness,
  type ProductSetupReadiness,
} from "@/lib/production/product-setup-readiness";

// Single source of truth for the "needs lot review" filter. Used by
// both the dashboard Action Center tile and the packaging-output queue
// so the count and the list never drift.
//
//   finalized_at IS NOT NULL
//   AND finished_lots.id IS NULL
//   AND COALESCE(read_bag_state.excluded_from_output, false) = false
//
// If you change this filter, also update
// app/(admin)/dashboard/loaders.ts which references the same predicate
// inside its single CTE query.
export async function countProductionOutputBacklog(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(workflowBags)
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        isNull(finishedLots.id),
        sql`COALESCE(${readBagState.excludedFromOutput}, false) = false`,
      ),
    );
  return Number(row?.n ?? 0);
}

export type ProductionOutputBacklogRow = {
  workflowBagId: string;
  receiptNumber: string | null;
  finalizedAt: Date | null;
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  masterCases: number | null;
  displaysMade: number | null;
  looseCards: number | null;
  unitsYielded: number | null;
  evaluation: AutoLotBacklogEvaluation;
  setupReadiness: ProductSetupReadiness;
};

export async function listProductionOutputBacklogWithEligibility(
  limit = 20,
): Promise<ProductionOutputBacklogRow[]> {
  const bags = await db
    .select({
      workflowBagId: workflowBags.id,
      receiptNumber: sql<string | null>`COALESCE(${inventoryBags.internalReceiptNumber}, ${workflowBags.receiptNumber})`,
      finalizedAt: workflowBags.finalizedAt,
      productId: workflowBags.productId,
      productName: products.name,
      productSku: products.sku,
      inventoryBagId: workflowBags.inventoryBagId,
      inventoryReceiptNumber: inventoryBags.internalReceiptNumber,
      workflowReceiptNumber: workflowBags.receiptNumber,
      inventoryPillCount: inventoryBags.pillCount,
      tabletsPerUnit: products.tabletsPerUnit,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
      defaultShelfLifeDays: products.defaultShelfLifeDays,
      zohoItemIdUnit: products.zohoItemIdUnit,
      zohoItemIdDisplay: products.zohoItemIdDisplay,
      zohoItemIdCase: products.zohoItemIdCase,
      masterCases: readBagMetrics.masterCases,
      displaysMade: readBagMetrics.displaysMade,
      looseCards: readBagMetrics.looseCards,
      unitsYielded: readBagMetrics.unitsYielded,
      excludedFromOutput: readBagState.excludedFromOutput,
    })
    .from(workflowBags)
    .leftJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(
      and(
        isNotNull(workflowBags.finalizedAt),
        isNull(finishedLots.id),
        sql`COALESCE(${readBagState.excludedFromOutput}, false) = false`,
      ),
    )
    .orderBy(desc(workflowBags.finalizedAt))
    .limit(limit);

  if (bags.length === 0) return [];

  const workflowBagIds = bags.map((b) => b.workflowBagId);
  const inventoryBagIds = bags
    .map((b) => b.inventoryBagId)
    .filter((id): id is string => id != null);

  const openSessionScope =
    inventoryBagIds.length > 0
      ? or(
          inArray(rawBagAllocationSessions.workflowBagId, workflowBagIds),
          inArray(rawBagAllocationSessions.inventoryBagId, inventoryBagIds),
        )
      : inArray(rawBagAllocationSessions.workflowBagId, workflowBagIds);

  const [openSessions, closedSessions, zohoCommitted, lotConflicts] = await Promise.all([
    db
      .select({
        id: rawBagAllocationSessions.id,
        workflowBagId: rawBagAllocationSessions.workflowBagId,
        inventoryBagId: rawBagAllocationSessions.inventoryBagId,
        startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      })
      .from(rawBagAllocationSessions)
      .where(
        and(eq(rawBagAllocationSessions.allocationStatus, "OPEN"), openSessionScope),
      ),
    db
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
          inArray(rawBagAllocationSessions.allocationStatus, ["CLOSED", "DEPLETED"]),
        ),
      )
      .orderBy(desc(rawBagAllocationSessions.closedAt)),
    db
      .select({ workflowBagId: zohoProductionOutputOps.workflowBagId })
      .from(zohoProductionOutputOps)
      .where(
        and(
          inArray(zohoProductionOutputOps.workflowBagId, workflowBagIds),
          isNotNull(zohoProductionOutputOps.committedAt),
        ),
      ),
    db
      .select({
        finishedLotNumber: finishedLots.finishedLotNumber,
        workflowBagId: finishedLots.workflowBagId,
      })
      .from(finishedLots)
      .where(
        inArray(
          finishedLots.finishedLotNumber,
          bags
            .map((b) => b.receiptNumber)
            .filter((r): r is string => r != null && r.trim() !== ""),
        ),
      ),
  ]);

  const openByWorkflow = new Map(
    openSessions
      .filter((s) => s.workflowBagId)
      .map((s) => [s.workflowBagId!, s]),
  );
  const openByInventory = new Map<string, typeof openSessions>();
  for (const s of openSessions) {
    const list = openByInventory.get(s.inventoryBagId) ?? [];
    list.push(s);
    openByInventory.set(s.inventoryBagId, list);
  }
  const lastClosedByInventory = new Map<string, (typeof closedSessions)[0]>();
  for (const s of closedSessions) {
    if (!lastClosedByInventory.has(s.inventoryBagId)) {
      lastClosedByInventory.set(s.inventoryBagId, s);
    }
  }
  const zohoCommittedSet = new Set(
    zohoCommitted.map((z) => z.workflowBagId).filter((id): id is string => id != null),
  );
  const lotConflictNumbers = new Set(
    lotConflicts
      .filter((l) => l.workflowBagId && !workflowBagIds.includes(l.workflowBagId))
      .map((l) => l.finishedLotNumber),
  );

  return bags.map((bag) => {
    const openForWorkflow = openByWorkflow.get(bag.workflowBagId) ?? null;
    const openOnInventory =
      bag.inventoryBagId != null
        ? (openByInventory.get(bag.inventoryBagId) ?? [])
        : [];
    const openOnOtherWorkflow = openOnInventory.some(
      (s) => s.workflowBagId != null && s.workflowBagId !== bag.workflowBagId,
    );
    const lastClosed =
      bag.inventoryBagId != null
        ? lastClosedByInventory.get(bag.inventoryBagId)
        : undefined;

    const evaluation = evaluateAutoLotBacklogRow({
      workflowBagId: bag.workflowBagId,
      productId: bag.productId,
      productName: bag.productName,
      inventoryBagId: bag.inventoryBagId,
      ambiguousSourceBagCount: bag.inventoryBagId ? 1 : 0,
      inventoryPillCount: bag.inventoryPillCount,
      lastClosedSessionEndingBalance: lastClosed?.endingBalanceQty ?? null,
      lastClosedSessionStartingBalance: lastClosed?.startingBalanceQty ?? null,
      lastClosedSessionConsumedQty: lastClosed?.consumedQty ?? null,
      tabletsPerUnit: bag.tabletsPerUnit,
      unitsPerDisplay: bag.unitsPerDisplay,
      displaysPerCase: bag.displaysPerCase,
      defaultShelfLifeDays: bag.defaultShelfLifeDays,
      inventoryReceiptNumber: bag.inventoryReceiptNumber,
      workflowReceiptNumber: bag.workflowReceiptNumber,
      unitsYielded: bag.unitsYielded,
      counts: {
        masterCases: bag.masterCases ?? 0,
        displaysMade: bag.displaysMade ?? 0,
        looseCards: bag.looseCards ?? 0,
      },
      finalizedAt: bag.finalizedAt,
      excludedFromOutput: bag.excludedFromOutput ?? false,
      hasFinishedLot: false,
      openAllocationSessionId: openForWorkflow?.id ?? null,
      openAllocationStartingBalance: openForWorkflow?.startingBalanceQty ?? null,
      openAllocationOnOtherWorkflow: openOnOtherWorkflow,
      zohoOutputCommitted: zohoCommittedSet.has(bag.workflowBagId),
      lotNumberConflict:
        bag.receiptNumber != null && lotConflictNumbers.has(bag.receiptNumber),
    });

    const setupReadiness = evaluateProductSetupReadiness({
      productId: bag.productId,
      tabletsPerUnit: bag.tabletsPerUnit,
      unitsPerDisplay: bag.unitsPerDisplay,
      displaysPerCase: bag.displaysPerCase,
      defaultShelfLifeDays: bag.defaultShelfLifeDays,
      zohoItemIdUnit: bag.zohoItemIdUnit,
      zohoItemIdDisplay: bag.zohoItemIdDisplay,
      zohoItemIdCase: bag.zohoItemIdCase,
    });

    return {
      workflowBagId: bag.workflowBagId,
      receiptNumber: bag.receiptNumber,
      finalizedAt: bag.finalizedAt,
      productId: bag.productId,
      productName: bag.productName,
      productSku: bag.productSku,
      masterCases: bag.masterCases,
      displaysMade: bag.displaysMade,
      looseCards: bag.looseCards,
      unitsYielded: bag.unitsYielded,
      evaluation,
      setupReadiness,
    };
  });
}

export async function getProductionOutputBacklogRow(
  workflowBagId: string,
): Promise<ProductionOutputBacklogRow | null> {
  const rows = await listProductionOutputBacklogWithEligibility(200);
  return rows.find((r) => r.workflowBagId === workflowBagId) ?? null;
}
