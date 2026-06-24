// Backfill OPEN allocation sessions for active workflow runs missing source linkage.
// v0.4.109+ repair — does not close allocations, issue lots, or touch Zoho.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  finishedLots,
  inventoryBags,
  qrCards,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
  readBagState,
  readStationLive,
  stations,
  workflowBags,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import { loadActiveRunsMissingAllocation } from "@/lib/production/partial-bags";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const BACKFILL_ALLOCATION_NOTES =
  "Backfilled missing allocation for active run after v0.4.109 allocation repair. Source inventory bag was deterministic.";

export type BackfillProposedAction =
  | "SAFE_OPEN_ALLOCATION"
  | "SKIP_FINALIZED"
  | "SKIP_CONFLICTING_OPEN_SESSION"
  | "SKIP_NO_INVENTORY_BAG"
  | "SKIP_AMBIGUOUS_SOURCE"
  | "SKIP_ALREADY_LINKED"
  | "REVIEW_REQUIRED";

export type BackfillStartingBalanceResolution = {
  startingBalanceQty: number | null;
  startingBalanceSource: string | null;
  missingStartingBalance: boolean;
};

export type BackfillClassification = BackfillStartingBalanceResolution & {
  action: BackfillProposedAction;
  reason: string;
};

export type ActiveWorkflowBagBackfillRow = {
  workflowBagId: string;
  inventoryBagId: string | null;
  bagQrCode: string | null;
  qrCardLabel: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  productName: string | null;
  stage: string | null;
  startedAt: Date | null;
  currentStationLabel: string | null;
  inventoryBagStatus: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  hasAnyAllocationForWorkflow: boolean;
  hasAnyAllocationForInventoryBag: boolean;
  hasOpenAllocationOnOtherWorkflow: boolean;
  openAllocationOtherWorkflowBagId: string | null;
  finishedLotId: string | null;
  finishedLotStatus: string | null;
  isFinalized: boolean;
  zohoOutputOpId: string | null;
  zohoOutputStatus: string | null;
  zohoOutputCommitted: boolean;
  classification: BackfillClassification;
};

export type BackfillApplyResult =
  | {
      ok: true;
      code: "CREATED" | "ALREADY_LINKED";
      sessionId: string;
      startingBalanceQty: number | null;
    }
  | { ok: false; code: string; error: string };

/** Starting balance for backfill: pill_count → last closed/returned ending → declared. */
export function resolveBackfillStartingBalance(input: {
  pillCount: number | null | undefined;
  declaredPillCount: number | null | undefined;
  lastClosedOrReturnedEndingBalanceQty: number | null | undefined;
}): BackfillStartingBalanceResolution {
  if (input.pillCount != null && input.pillCount >= 0) {
    return {
      startingBalanceQty: input.pillCount,
      startingBalanceSource: "PILL_COUNT",
      missingStartingBalance: false,
    };
  }
  if (
    input.lastClosedOrReturnedEndingBalanceQty != null &&
    input.lastClosedOrReturnedEndingBalanceQty >= 0
  ) {
    return {
      startingBalanceQty: input.lastClosedOrReturnedEndingBalanceQty,
      startingBalanceSource: "LEDGER_DERIVED",
      missingStartingBalance: false,
    };
  }
  if (input.declaredPillCount != null && input.declaredPillCount >= 0) {
    return {
      startingBalanceQty: input.declaredPillCount,
      startingBalanceSource: "VENDOR_DECLARED",
      missingStartingBalance: false,
    };
  }
  return {
    startingBalanceQty: null,
    startingBalanceSource: null,
    missingStartingBalance: true,
  };
}

export function classifyActiveWorkflowBagBackfill(input: {
  workflowBagId: string;
  inventoryBagId: string | null;
  isFinalized: boolean;
  inventoryBagStatus: string | null;
  hasAnyAllocationForWorkflow: boolean;
  hasOpenAllocationOnOtherWorkflow: boolean;
  finishedLotId: string | null;
  zohoOutputCommitted: boolean;
  startingBalance: BackfillStartingBalanceResolution;
}): BackfillClassification {
  if (input.isFinalized) {
    return {
      action: "SKIP_FINALIZED",
      reason: "Workflow bag is finalized.",
      ...input.startingBalance,
    };
  }
  if (!input.inventoryBagId) {
    return {
      action: "SKIP_NO_INVENTORY_BAG",
      reason: "Workflow bag has no linked inventory bag.",
      ...input.startingBalance,
    };
  }
  if (input.hasAnyAllocationForWorkflow) {
    return {
      action: "SKIP_ALREADY_LINKED",
      reason: "An allocation session already exists for this workflow run.",
      ...input.startingBalance,
    };
  }
  if (input.hasOpenAllocationOnOtherWorkflow) {
    return {
      action: "SKIP_CONFLICTING_OPEN_SESSION",
      reason:
        "Source inventory bag has an OPEN allocation on another active workflow run.",
      ...input.startingBalance,
    };
  }
  const status = input.inventoryBagStatus ?? "";
  if (status === "VOID" || status === "QUARANTINED" || status === "EMPTIED") {
    return {
      action: "REVIEW_REQUIRED",
      reason: `Inventory bag status is ${status}; manual review required before allocation backfill.`,
      ...input.startingBalance,
    };
  }
  if (input.finishedLotId) {
    return {
      action: "REVIEW_REQUIRED",
      reason:
        "A finished lot already exists for this workflow bag; manual review required.",
      ...input.startingBalance,
    };
  }
  if (input.zohoOutputCommitted) {
    return {
      action: "REVIEW_REQUIRED",
      reason: "Zoho production output is already committed for this run.",
      ...input.startingBalance,
    };
  }
  if (input.startingBalance.missingStartingBalance) {
    return {
      action: "REVIEW_REQUIRED",
      reason:
        "Starting tablet balance is unknown (no pill count, ledger ending, or declared count).",
      ...input.startingBalance,
    };
  }
  return {
    action: "SAFE_OPEN_ALLOCATION",
    reason: "Deterministic source bag with no conflicting allocation session.",
    ...input.startingBalance,
  };
}

async function lookupPoIdForBag(
  tx: DbTx,
  inventoryBagId: string,
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT po.id::text AS po_id
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives r ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${inventoryBagId}
    LIMIT 1
  `)) as unknown as Array<{ po_id: string | null }>;
  return rows[0]?.po_id ?? null;
}

export async function backfillMissingAllocationForActiveWorkflowBag(
  tx: DbTx,
  workflowBagId: string,
  options?: {
    actor?: Pick<CurrentUser, "id" | "role"> | null;
    dryRun?: boolean;
  },
): Promise<BackfillApplyResult> {
  const [wf] = await tx
    .select({
      id: workflowBags.id,
      inventoryBagId: workflowBags.inventoryBagId,
      productId: workflowBags.productId,
      startedAt: workflowBags.startedAt,
      isFinalized: readBagState.isFinalized,
    })
    .from(workflowBags)
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(eq(workflowBags.id, workflowBagId))
    .limit(1);

  if (!wf) {
    return { ok: false, code: "WORKFLOW_BAG_NOT_FOUND", error: "Workflow bag not found." };
  }

  const inventoryBagId = wf.inventoryBagId;
  if (!inventoryBagId) {
    return {
      ok: false,
      code: "SKIP_NO_INVENTORY_BAG",
      error: "Workflow bag has no linked inventory bag.",
    };
  }

  const [bag] = await tx
    .select({
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
    })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);
  if (!bag) {
    return { ok: false, code: "BAG_NOT_FOUND", error: "Inventory bag not found." };
  }

  const [anyForWorkflow] = await tx
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.workflowBagId, workflowBagId))
    .limit(1);
  if (anyForWorkflow) {
    return {
      ok: true,
      code: "ALREADY_LINKED",
      sessionId: anyForWorkflow.id,
      startingBalanceQty: null,
    };
  }

  const [openOther] = await tx
    .select({
      id: rawBagAllocationSessions.id,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  if (openOther && openOther.workflowBagId !== workflowBagId) {
    return {
      ok: false,
      code: "SKIP_CONFLICTING_OPEN_SESSION",
      error:
        "Source bag has an OPEN allocation session on another workflow run.",
    };
  }

  if (wf.isFinalized) {
    return {
      ok: false,
      code: "SKIP_FINALIZED",
      error: "Workflow bag is finalized.",
    };
  }

  if (bag.status === "VOID" || bag.status === "QUARANTINED" || bag.status === "EMPTIED") {
    return {
      ok: false,
      code: "REVIEW_REQUIRED",
      error: `Inventory bag status is ${bag.status}.`,
    };
  }

  const [finishedLot] = await tx
    .select({ id: finishedLots.id })
    .from(finishedLots)
    .where(eq(finishedLots.workflowBagId, workflowBagId))
    .limit(1);
  if (finishedLot) {
    return {
      ok: false,
      code: "REVIEW_REQUIRED",
      error: "Finished lot already exists for this workflow bag.",
    };
  }

  const [zohoOp] = await tx
    .select({ id: zohoProductionOutputOps.id, status: zohoProductionOutputOps.status })
    .from(zohoProductionOutputOps)
    .innerJoin(finishedLots, eq(finishedLots.id, zohoProductionOutputOps.finishedLotId))
    .where(
      and(
        eq(finishedLots.workflowBagId, workflowBagId),
        isNull(zohoProductionOutputOps.voidedAt),
        eq(zohoProductionOutputOps.status, "COMMITTED"),
      ),
    )
    .limit(1);
  if (zohoOp) {
    return {
      ok: false,
      code: "REVIEW_REQUIRED",
      error: "Zoho production output is committed for this run.",
    };
  }

  const [lastClosed] = await tx
    .select({ endingBalanceQty: rawBagAllocationSessions.endingBalanceQty })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
        inArray(rawBagAllocationSessions.allocationStatus, [
          "CLOSED",
          "RETURNED_TO_STOCK",
          "DEPLETED",
        ]),
      ),
    )
    .orderBy(desc(rawBagAllocationSessions.closedAt))
    .limit(1);

  const starting = resolveBackfillStartingBalance({
    pillCount: bag.pillCount,
    declaredPillCount: bag.declaredPillCount,
    lastClosedOrReturnedEndingBalanceQty: lastClosed?.endingBalanceQty ?? null,
  });

  if (starting.missingStartingBalance) {
    return {
      ok: false,
      code: "REVIEW_REQUIRED",
      error: "Starting tablet balance is unknown.",
    };
  }

  if (options?.dryRun) {
    return {
      ok: true,
      code: "CREATED",
      sessionId: "(dry-run)",
      startingBalanceQty: starting.startingBalanceQty,
    };
  }

  const poId = await lookupPoIdForBag(tx, inventoryBagId);
  const openedAt = wf.startedAt ?? new Date();
  const confidence = starting.missingStartingBalance ? "LOW" : "MEDIUM";

  const inserted = await tx
    .insert(rawBagAllocationSessions)
    .values({
      inventoryBagId,
      workflowBagId,
      ...(poId ? { poId } : {}),
      ...(wf.productId ? { productId: wf.productId } : {}),
      allocationStatus: "OPEN",
      openedAt,
      ...(starting.startingBalanceQty != null
        ? { startingBalanceQty: starting.startingBalanceQty }
        : {}),
      ...(starting.startingBalanceSource
        ? { startingBalanceSource: starting.startingBalanceSource }
        : {}),
      unitOfMeasure: "tablets",
      confidence,
      notes: BACKFILL_ALLOCATION_NOTES,
      ...(options?.actor?.id ? { openedByUserId: options.actor.id } : {}),
    })
    .returning({ id: rawBagAllocationSessions.id });

  const session = inserted[0];
  if (!session) {
    return { ok: false, code: "INSERT_FAILED", error: "Failed to create allocation session." };
  }

  await tx.insert(rawBagAllocationEvents).values({
    allocationSessionId: session.id,
    inventoryBagId,
    workflowBagId,
    ...(wf.productId ? { productId: wf.productId } : {}),
    eventType: "RAW_BAG_OPENED",
    ...(starting.startingBalanceQty != null
      ? { quantity: String(starting.startingBalanceQty) }
      : {}),
    unitOfMeasure: "tablets",
    ...(starting.startingBalanceSource
      ? { quantitySource: starting.startingBalanceSource }
      : {}),
    payload: {
      source: "backfill_missing_active_allocation",
      backfill: true,
      notes: BACKFILL_ALLOCATION_NOTES,
    },
    confidence,
    ...(starting.missingStartingBalance
      ? { missingInputs: ["starting_balance"] }
      : {}),
  });

  await tx
    .update(inventoryBags)
    .set({ status: "IN_USE" })
    .where(eq(inventoryBags.id, inventoryBagId));

  await writeAudit(
    {
      actorId: options?.actor?.id ?? null,
      actorRole: options?.actor?.role ?? null,
      action: "raw_bag_allocation.backfill_opened",
      targetType: "RawBagAllocationSession",
      targetId: session.id,
      after: {
        workflowBagId,
        inventoryBagId,
        startingBalanceQty: starting.startingBalanceQty,
        startingBalanceSource: starting.startingBalanceSource,
        missingStartingBalance: starting.missingStartingBalance,
        notes: BACKFILL_ALLOCATION_NOTES,
      },
    },
    tx,
  );

  return {
    ok: true,
    code: "CREATED",
    sessionId: session.id,
    startingBalanceQty: starting.startingBalanceQty,
  };
}

export async function loadActiveWorkflowBagBackfillReport(
  workflowBagIds?: string[],
): Promise<ActiveWorkflowBagBackfillRow[]> {
  const missing = await loadActiveRunsMissingAllocation();
  const targets =
    workflowBagIds && workflowBagIds.length > 0
      ? missing.filter((m) => workflowBagIds.includes(m.workflowBagId))
      : missing;
  if (targets.length === 0) return [];

  const wfIds = targets.map((t) => t.workflowBagId);
  const invIds = targets.map((t) => t.inventoryBagId);

  const bagDetails = await db
    .select({
      id: inventoryBags.id,
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
      bagQrCode: inventoryBags.bagQrCode,
    })
    .from(inventoryBags)
    .where(inArray(inventoryBags.id, invIds));

  const bagById = new Map(bagDetails.map((b) => [b.id, b]));

  const qrLabels = await db
    .select({ scanToken: qrCards.scanToken, label: qrCards.label })
    .from(qrCards)
    .where(
      inArray(
        qrCards.scanToken,
        bagDetails
          .map((b) => b.bagQrCode)
          .filter((t): t is string => t != null && t.length > 0),
      ),
    );
  const qrLabelByToken = new Map(qrLabels.map((q) => [q.scanToken, q.label]));

  const sessionsForWorkflow = await db
    .select({
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(inArray(rawBagAllocationSessions.workflowBagId, wfIds));
  const linkedWorkflowIds = new Set(
    sessionsForWorkflow.map((s) => s.workflowBagId).filter(Boolean) as string[],
  );

  const openSessions = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        inArray(rawBagAllocationSessions.inventoryBagId, invIds),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    );

  const openByBag = new Map(
    openSessions.map((s) => [s.inventoryBagId, s.workflowBagId]),
  );

  const sessionsForInventory = await db
    .select({ inventoryBagId: rawBagAllocationSessions.inventoryBagId })
    .from(rawBagAllocationSessions)
    .where(inArray(rawBagAllocationSessions.inventoryBagId, invIds));
  const bagsWithAnySession = new Set(
    sessionsForInventory.map((s) => s.inventoryBagId),
  );

  const lastClosedByBag = new Map<string, number | null>();
  for (const invId of invIds) {
    const [row] = await db
      .select({ endingBalanceQty: rawBagAllocationSessions.endingBalanceQty })
      .from(rawBagAllocationSessions)
      .where(
        and(
          eq(rawBagAllocationSessions.inventoryBagId, invId),
          inArray(rawBagAllocationSessions.allocationStatus, [
            "CLOSED",
            "RETURNED_TO_STOCK",
            "DEPLETED",
          ]),
        ),
      )
      .orderBy(desc(rawBagAllocationSessions.closedAt))
      .limit(1);
    lastClosedByBag.set(invId, row?.endingBalanceQty ?? null);
  }

  const lots = await db
    .select({
      workflowBagId: finishedLots.workflowBagId,
      id: finishedLots.id,
      status: finishedLots.status,
    })
    .from(finishedLots)
    .where(inArray(finishedLots.workflowBagId, wfIds));
  const lotByWf = new Map(
    lots
      .filter((l) => l.workflowBagId != null)
      .map((l) => [l.workflowBagId!, l]),
  );

  const zohoOps = await db
    .select({
      workflowBagId: finishedLots.workflowBagId,
      opId: zohoProductionOutputOps.id,
      status: zohoProductionOutputOps.status,
    })
    .from(zohoProductionOutputOps)
    .innerJoin(finishedLots, eq(finishedLots.id, zohoProductionOutputOps.finishedLotId))
    .where(
      and(
        inArray(finishedLots.workflowBagId, wfIds),
        isNull(zohoProductionOutputOps.voidedAt),
      ),
    );
  const zohoByWf = new Map(
    zohoOps
      .filter((z) => z.workflowBagId != null)
      .map((z) => [z.workflowBagId!, z]),
  );

  const stationRows = await db
    .select({
      workflowBagId: readStationLive.currentWorkflowBagId,
      stationLabel: stations.label,
    })
    .from(readStationLive)
    .innerJoin(stations, eq(stations.id, readStationLive.stationId))
    .where(inArray(readStationLive.currentWorkflowBagId, wfIds));
  const stationByWf = new Map(
    stationRows
      .filter((s) => s.workflowBagId != null)
      .map((s) => [s.workflowBagId!, s.stationLabel]),
  );

  const finalizedRows = await db
    .select({
      workflowBagId: readBagState.workflowBagId,
      isFinalized: readBagState.isFinalized,
    })
    .from(readBagState)
    .where(inArray(readBagState.workflowBagId, wfIds));
  const finalizedByWf = new Map(
    finalizedRows.map((r) => [r.workflowBagId, r.isFinalized]),
  );

  return targets.map((t) => {
    const bag = bagById.get(t.inventoryBagId);
    const openOtherWf = openByBag.get(t.inventoryBagId) ?? null;
    const hasOpenOther =
      openOtherWf != null && openOtherWf !== t.workflowBagId;
    const starting = resolveBackfillStartingBalance({
      pillCount: bag?.pillCount ?? null,
      declaredPillCount: bag?.declaredPillCount ?? null,
      lastClosedOrReturnedEndingBalanceQty:
        lastClosedByBag.get(t.inventoryBagId) ?? null,
    });
    const lot = lotByWf.get(t.workflowBagId);
    const zoho = zohoByWf.get(t.workflowBagId);
    const zohoCommitted = zoho?.status === "COMMITTED";
    const classification = classifyActiveWorkflowBagBackfill({
      workflowBagId: t.workflowBagId,
      inventoryBagId: t.inventoryBagId,
      isFinalized: finalizedByWf.get(t.workflowBagId) ?? false,
      inventoryBagStatus: bag?.status ?? null,
      hasAnyAllocationForWorkflow: linkedWorkflowIds.has(t.workflowBagId),
      hasOpenAllocationOnOtherWorkflow: hasOpenOther,
      finishedLotId: lot?.id ?? null,
      zohoOutputCommitted: zohoCommitted,
      startingBalance: starting,
    });

    return {
      workflowBagId: t.workflowBagId,
      inventoryBagId: t.inventoryBagId,
      bagQrCode: bag?.bagQrCode ?? t.bagQrCode,
      qrCardLabel:
        bag?.bagQrCode != null
          ? (qrLabelByToken.get(bag.bagQrCode) ?? null)
          : null,
      internalReceiptNumber: t.internalReceiptNumber,
      tabletTypeName: t.tabletTypeName,
      productName: t.productName,
      stage: t.stage,
      startedAt: t.startedAt,
      currentStationLabel: stationByWf.get(t.workflowBagId) ?? null,
      inventoryBagStatus: bag?.status ?? null,
      declaredPillCount: bag?.declaredPillCount ?? null,
      pillCount: bag?.pillCount ?? null,
      hasAnyAllocationForWorkflow: linkedWorkflowIds.has(t.workflowBagId),
      hasAnyAllocationForInventoryBag: bagsWithAnySession.has(t.inventoryBagId),
      hasOpenAllocationOnOtherWorkflow: hasOpenOther,
      openAllocationOtherWorkflowBagId: hasOpenOther ? openOtherWf : null,
      finishedLotId: lot?.id ?? null,
      finishedLotStatus: lot?.status ?? null,
      isFinalized: finalizedByWf.get(t.workflowBagId) ?? false,
      zohoOutputOpId: zoho?.opId ?? null,
      zohoOutputStatus: zoho?.status ?? null,
      zohoOutputCommitted: zohoCommitted,
      classification,
    };
  });
}

export type BackfillBatchResult = {
  repaired: Array<{ workflowBagId: string; sessionId: string }>;
  skipped: Array<{ workflowBagId: string; code: string; reason: string }>;
  errors: Array<{ workflowBagId: string; error: string }>;
};

export async function applySafeActiveAllocationBackfill(input: {
  workflowBagIds?: string[];
  limit?: number;
  actor?: Pick<CurrentUser, "id" | "role"> | null;
}): Promise<BackfillBatchResult> {
  let rows = await loadActiveWorkflowBagBackfillReport(input.workflowBagIds);
  rows = rows.filter((r) => r.classification.action === "SAFE_OPEN_ALLOCATION");
  if (input.limit != null && input.limit > 0) {
    rows = rows.slice(0, input.limit);
  }

  const result: BackfillBatchResult = {
    repaired: [],
    skipped: [],
    errors: [],
  };

  for (const row of rows) {
    try {
      const applied = await db.transaction(async (tx) =>
        backfillMissingAllocationForActiveWorkflowBag(tx, row.workflowBagId, {
          actor: input.actor ?? null,
        }),
      );
      if (applied.ok) {
        if (applied.code === "CREATED") {
          result.repaired.push({
            workflowBagId: row.workflowBagId,
            sessionId: applied.sessionId,
          });
        } else {
          result.skipped.push({
            workflowBagId: row.workflowBagId,
            code: applied.code,
            reason: "Allocation session already linked.",
          });
        }
      } else {
        result.errors.push({
          workflowBagId: row.workflowBagId,
          error: applied.error,
        });
      }
    } catch (err) {
      result.errors.push({
        workflowBagId: row.workflowBagId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export function summarizeBackfillReport(rows: ActiveWorkflowBagBackfillRow[]): {
  total: number;
  safeCount: number;
  skippedByAction: Record<string, number>;
} {
  const skippedByAction: Record<string, number> = {};
  let safeCount = 0;
  for (const row of rows) {
    const action = row.classification.action;
    skippedByAction[action] = (skippedByAction[action] ?? 0) + 1;
    if (action === "SAFE_OPEN_ALLOCATION") safeCount += 1;
  }
  return { total: rows.length, safeCount, skippedByAction };
}

export type BackfillCliOptions = {
  apply: boolean;
  yes: boolean;
  workflowBagId: string | null;
  limit: number | null;
};

export function parseBackfillMissingActiveAllocationsCli(
  argv: string[],
): BackfillCliOptions {
  let workflowBagId: string | null = null;
  let limit: number | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") continue;
    if (arg === "--yes") continue;
    if (arg.startsWith("--workflow-bag-id=")) {
      workflowBagId = arg.slice("--workflow-bag-id=".length) || null;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const n = Number.parseInt(arg.slice("--limit=".length), 10);
      limit = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return {
    apply: argv.includes("--apply"),
    yes: argv.includes("--yes"),
    workflowBagId,
    limit,
  };
}

export function validateBackfillApplyGate(
  opts: BackfillCliOptions,
): { ok: true } | { ok: false; error: string } {
  if (!opts.apply) return { ok: true };
  if (!opts.yes) {
    return {
      ok: false,
      error: "Apply mode requires --yes to confirm writes.",
    };
  }
  return { ok: true };
}
