// PARTIAL-1 — Available partial raw-bag helpers + query.
//
// "Available partial bag" = inventory_bags.status=AVAILABLE AND has ≥1
// closed/returned allocation session. No new DB status needed — derived
// from existing rawBagAllocationSessions ledger.

import { asc, eq, inArray, isNotNull, and, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  inventoryBags,
  products,
  rawBagAllocationSessions,
  readBagState,
  smallBoxes,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import {
  hasPartialPackagingComplete,
  isWorkflowBagResumableAtSealingAfterPartialPackaging,
} from "@/lib/production/sealing-partial-closeout";
import { canRestartAvailablePartialRawBag } from "@/lib/production/partial-bag-restart";

// ─── Types ──────────────────────────────────────────────────────────

type AllocationStatus = "OPEN" | "CLOSED" | "RETURNED_TO_STOCK" | "DEPLETED" | "VOIDED";

export interface PartialBagSession {
  allocationStatus: AllocationStatus;
  endingBalanceQty: number | null;
  closedAt: Date | null;
}

export interface AvailablePartialBagRow {
  bagId: string;
  bagNumber: number;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  supplierLot: string | null;
  receiveId: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  remainingEstimate: number | null;
  lastConsumedQty: number | null;
  lastUsedProductName: string | null;
  lastUsedAt: Date | null;
  lastSessionStatus: AllocationStatus | null;
}

export type PartialBagEligibility =
  | "ready"
  | "needs_allocation_closeout"
  | "missing_linkage";

export interface PartialBagAdminRow extends AvailablePartialBagRow {
  eligibility: PartialBagEligibility;
  eligibilityNote: string;
  activeWorkflowBagId: string | null;
  inventoryStatus: string;
}

// ─── Pure helpers ───────────────────────────────────────────────────

/** True if sessions contain ≥1 CLOSED or RETURNED_TO_STOCK record.
 *  A fresh bag (no sessions) returns false. */
export function isAvailablePartialBag(sessions: readonly PartialBagSession[]): boolean {
  return sessions.some(
    (s) =>
      s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
  );
}

/** True if any session is currently OPEN (belt-and-suspenders guard). */
export function hasOpenAllocationSession(
  sessions: readonly { allocationStatus: AllocationStatus }[],
): boolean {
  return sessions.some((s) => s.allocationStatus === "OPEN");
}

/** Remaining qty from the most-recent CLOSED/RETURNED_TO_STOCK session
 *  that recorded an endingBalanceQty. Falls back to null. */
export function deriveRemainingEstimate(sessions: readonly PartialBagSession[]): number | null {
  const relevant = sessions
    .filter(
      (s) =>
        (s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK") &&
        s.endingBalanceQty != null,
    )
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  return relevant[0]?.endingBalanceQty ?? null;
}

/** Classify why a partial-packaged inventory bag may or may not restart. */
export function classifyPartialBagInventoryEligibility(args: {
  inventoryStatus: string;
  sessions: readonly PartialBagSession[];
  hasPartialPackagingWorkflow: boolean;
}): { eligibility: PartialBagEligibility; note: string } {
  if (!args.hasPartialPackagingWorkflow) {
    return {
      eligibility: "missing_linkage",
      note: "No partial-packaging workflow evidence.",
    };
  }
  if (args.sessions.length === 0) {
    return {
      eligibility: "missing_linkage",
      note:
        "Partial production recorded, but no raw-bag allocation session exists. Close allocation at the floor when tablet use is known.",
    };
  }
  if (hasOpenAllocationSession(args.sessions)) {
    return {
      eligibility: "needs_allocation_closeout",
      note:
        "Allocation session still open. Record tablet consumption or weigh-back, then close or return remaining quantity at the floor.",
    };
  }
  if (
    canRestartAvailablePartialRawBag({
      inventoryStatus: args.inventoryStatus,
      sessions: args.sessions,
    })
  ) {
    return { eligibility: "ready", note: "Ready for a new production run." };
  }
  if (isAvailablePartialBag(args.sessions)) {
    return {
      eligibility: "needs_allocation_closeout",
      note:
        "Prior allocation closed without a reusable remaining balance. Confirm tablets remaining before restarting.",
    };
  }
  return {
    eligibility: "missing_linkage",
    note: "Partial workflow exists but inventory allocation history is incomplete.",
  };
}

// ─── DB query ───────────────────────────────────────────────────────

/** Load all AVAILABLE raw bags that have been through ≥1 production run.
 *  Returns rows sorted by last-used date desc (most recently used first). */
export async function loadAvailablePartialBags(): Promise<AvailablePartialBagRow[]> {
  // Step 1: All AVAILABLE bags with context
  const bagRows = await db
    .select({
      id: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      smallBoxId: inventoryBags.smallBoxId,
      tabletTypeName: tabletTypes.name,
      batchNumber: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .where(eq(inventoryBags.status, "AVAILABLE"))
    .orderBy(asc(inventoryBags.bagNumber));

  if (bagRows.length === 0) return [];

  const bagIds = bagRows.map((b) => b.id);

  // Step 2: All sessions for these bags (ordered oldest-first so JS picks last)
  const sessionRows = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      consumedQty: rawBagAllocationSessions.consumedQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      openedAt: rawBagAllocationSessions.openedAt,
      closedAt: rawBagAllocationSessions.closedAt,
      productName: products.name,
    })
    .from(rawBagAllocationSessions)
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(inArray(rawBagAllocationSessions.inventoryBagId, bagIds))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  // Step 3: Group sessions by bag, filter to partial bags, build output
  // Cast allocationStatus from string to AllocationStatus — the DB column is a
  // constrained text field; Drizzle infers string because there's no pgEnum.
  type SessionRow = Omit<(typeof sessionRows)[number], "allocationStatus"> & {
    allocationStatus: AllocationStatus;
  };
  const typedSessionRows = sessionRows as SessionRow[];
  const sessionsByBag = new Map<string, SessionRow[]>();
  for (const s of typedSessionRows) {
    const bagId = s.inventoryBagId;
    const list = sessionsByBag.get(bagId) ?? [];
    list.push(s);
    sessionsByBag.set(bagId, list);
  }

  const result: AvailablePartialBagRow[] = [];

  for (const bag of bagRows) {
    const sessions = sessionsByBag.get(bag.id) ?? [];
    if (!isAvailablePartialBag(sessions)) continue; // fresh bag, not partial

    const lastClosed = [...sessions]
      .filter(
        (s) =>
          s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK",
      )
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))[0];

    const remainingEstimate = deriveRemainingEstimate(sessions);

    result.push({
      bagId: bag.id,
      bagNumber: bag.bagNumber,
      bagQrCode: bag.bagQrCode,
      internalReceiptNumber: bag.internalReceiptNumber,
      tabletTypeName: bag.tabletTypeName ?? null,
      supplierLot: bag.batchNumber ?? null,
      receiveId: bag.receiveId ?? null,
      declaredPillCount: bag.declaredPillCount,
      pillCount: bag.pillCount,
      remainingEstimate,
      lastConsumedQty: lastClosed?.consumedQty ?? null,
      lastUsedProductName: lastClosed?.productName ?? null,
      lastUsedAt: lastClosed?.closedAt ?? null,
      lastSessionStatus: lastClosed?.allocationStatus ?? null,
    });
  }

  // Sort: most recently used first
  result.sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));

  return result;
}

/** Admin view: ready partial bags plus honest blocked/review rows for
 *  partial-packaged workflows that would otherwise disappear from the page. */
export async function loadPartialBagAdminRows(): Promise<PartialBagAdminRow[]> {
  const readyRows = await loadAvailablePartialBags();
  const adminRows: PartialBagAdminRow[] = readyRows.map((row) => ({
    ...row,
    eligibility: "ready" as const,
    eligibilityNote: "Ready for a new production run.",
    activeWorkflowBagId: null,
    inventoryStatus: "AVAILABLE",
  }));
  const listedBagIds = new Set(adminRows.map((r) => r.bagId));

  const partialWorkflowCandidates = await db
    .select({
      inventoryBagId: workflowBags.inventoryBagId,
      workflowBagId: workflowBags.id,
      inventoryStatus: inventoryBags.status,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      tabletTypeName: tabletTypes.name,
      batchNumber: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
      bagStage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      productName: products.name,
    })
    .from(workflowBags)
    .innerJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .innerJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(
      and(
        isNotNull(workflowBags.inventoryBagId),
        eq(readBagState.isFinalized, false),
        notInArray(inventoryBags.status, ["EMPTIED", "VOID", "QUARANTINED"]),
      ),
    );

  if (partialWorkflowCandidates.length === 0) {
    return adminRows;
  }

  const wfBagIds = partialWorkflowCandidates.map((c) => c.workflowBagId);
  const invBagIds = [
    ...new Set(
      partialWorkflowCandidates
        .map((c) => c.inventoryBagId)
        .filter((id): id is string => id != null),
    ),
  ];

  const wfEventRows = await db
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      eventType: workflowEvents.eventType,
      payload: workflowEvents.payload,
    })
    .from(workflowEvents)
    .where(inArray(workflowEvents.workflowBagId, wfBagIds));

  const eventsByWfBag = new Map<
    string,
    Array<{ eventType: string; payload: Record<string, unknown> | null }>
  >();
  for (const row of wfEventRows) {
    const list = eventsByWfBag.get(row.workflowBagId) ?? [];
    list.push({
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
    });
    eventsByWfBag.set(row.workflowBagId, list);
  }

  const sessionRows = await db
    .select({
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      closedAt: rawBagAllocationSessions.closedAt,
      consumedQty: rawBagAllocationSessions.consumedQty,
      productName: products.name,
    })
    .from(rawBagAllocationSessions)
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(inArray(rawBagAllocationSessions.inventoryBagId, invBagIds))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  type SessionRow = Omit<(typeof sessionRows)[number], "allocationStatus"> & {
    allocationStatus: AllocationStatus;
  };
  const typedSessionRows = sessionRows as SessionRow[];
  const sessionsByInvBag = new Map<string, SessionRow[]>();
  for (const s of typedSessionRows) {
    const list = sessionsByInvBag.get(s.inventoryBagId) ?? [];
    list.push(s);
    sessionsByInvBag.set(s.inventoryBagId, list);
  }

  for (const candidate of partialWorkflowCandidates) {
    if (!candidate.inventoryBagId || listedBagIds.has(candidate.inventoryBagId)) {
      continue;
    }
    const wfEvents = eventsByWfBag.get(candidate.workflowBagId) ?? [];
    const hasPartialPackagingWorkflow =
      hasPartialPackagingComplete(wfEvents) ||
      isWorkflowBagResumableAtSealingAfterPartialPackaging(wfEvents, {
        stage: candidate.bagStage,
        isFinalized: candidate.isFinalized,
      });
    if (!hasPartialPackagingWorkflow) continue;

    const sessions = sessionsByBagToPartial(
      sessionsByInvBag.get(candidate.inventoryBagId) ?? [],
    );
    const { eligibility, note } = classifyPartialBagInventoryEligibility({
      inventoryStatus: candidate.inventoryStatus,
      sessions,
      hasPartialPackagingWorkflow: true,
    });
    if (eligibility === "ready") continue;

    const lastClosed = [...(sessionsByInvBag.get(candidate.inventoryBagId) ?? [])]
      .filter(
        (s) =>
          s.allocationStatus === "CLOSED" ||
          s.allocationStatus === "RETURNED_TO_STOCK",
      )
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))[0];

    adminRows.push({
      bagId: candidate.inventoryBagId,
      bagNumber: candidate.bagNumber,
      bagQrCode: candidate.bagQrCode,
      internalReceiptNumber: candidate.internalReceiptNumber,
      tabletTypeName: candidate.tabletTypeName ?? null,
      supplierLot: candidate.batchNumber ?? null,
      receiveId: candidate.receiveId ?? null,
      declaredPillCount: candidate.declaredPillCount,
      pillCount: candidate.pillCount,
      remainingEstimate: deriveRemainingEstimate(sessions),
      lastConsumedQty: lastClosed?.consumedQty ?? null,
      lastUsedProductName:
        lastClosed?.productName ?? candidate.productName ?? null,
      lastUsedAt: lastClosed?.closedAt ?? null,
      lastSessionStatus: lastClosed?.allocationStatus ?? null,
      eligibility,
      eligibilityNote: note,
      activeWorkflowBagId: candidate.workflowBagId,
      inventoryStatus: candidate.inventoryStatus,
    });
    listedBagIds.add(candidate.inventoryBagId);
  }

  adminRows.sort((a, b) => {
    const rank = (e: PartialBagEligibility) =>
      e === "ready" ? 0 : e === "needs_allocation_closeout" ? 1 : 2;
    const d = rank(a.eligibility) - rank(b.eligibility);
    if (d !== 0) return d;
    return (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0);
  });

  return adminRows;
}

function sessionsByBagToPartial(
  sessions: Array<{
    allocationStatus: AllocationStatus;
    endingBalanceQty: number | null;
    closedAt: Date | null;
  }>,
): PartialBagSession[] {
  return sessions.map((s) => ({
    allocationStatus: s.allocationStatus,
    endingBalanceQty: s.endingBalanceQty,
    closedAt: s.closedAt,
  }));
}
