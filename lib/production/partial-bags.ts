// PARTIAL-1 — Available partial raw-bag helpers + query.
//
// "Available partial bag" = inventory_bags.status=AVAILABLE AND has ≥1
// closed/returned allocation session. No new DB status needed — derived
// from existing rawBagAllocationSessions ledger.

import { asc, desc, eq, inArray, isNotNull, and, notInArray } from "drizzle-orm";
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
  hasPartialSealingCloseout,
  hasFullSealingLaneClose,
  isWorkflowBagResumableAtSealingAfterPartialPackaging,
} from "@/lib/production/sealing-partial-closeout";
import { canRestartAvailablePartialRawBag } from "@/lib/production/partial-bag-restart";
import { bottleFinalizePayloadRemainingEstimate } from "@/lib/production/bag-allocation";

// ─── Types ──────────────────────────────────────────────────────────

type AllocationStatus = "OPEN" | "CLOSED" | "RETURNED_TO_STOCK" | "DEPLETED" | "VOIDED";

export interface PartialBagSession {
  allocationStatus: AllocationStatus;
  endingBalanceQty: number | null;
  closedAt: Date | null;
  confidence?: string | null;
  endingBalanceSource?: string | null;
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
  /** Confidence from the most recent closed/returned session with ending balance. */
  remainingConfidence: string | null;
  /** endingBalanceSource from the same session (e.g. SUPERVISOR_ESTIMATE). */
  remainingSource: string | null;
  lastConsumedQty: number | null;
  lastUsedProductName: string | null;
  lastUsedAt: Date | null;
  lastSessionStatus: AllocationStatus | null;
}

export type PartialBagEligibility =
  | "ready"
  | "needs_allocation_closeout"
  | "missing_linkage";

type WorkflowEventSlice = {
  eventType: string;
  payload?: Record<string, unknown> | null;
};

/** Partial close + downstream packaging (incl. legacy whole-bag packaging path). */
export function hasPartialClosePackagingWorkflowEvidence(
  events: readonly WorkflowEventSlice[],
): boolean {
  if (!hasPartialSealingCloseout(events) || hasFullSealingLaneClose(events)) {
    return false;
  }
  return (
    hasPartialPackagingComplete(events) ||
    events.some((ev) => ev.eventType === "PACKAGING_COMPLETE")
  );
}

export interface PartialBagAdminRow extends AvailablePartialBagRow {
  eligibility: PartialBagEligibility;
  eligibilityNote: string;
  activeWorkflowBagId: string | null;
  inventoryStatus: string;
  /** Optional operator-entered remaining ESTIMATE from the latest
   *  BAG_FINALIZED event. Distinct from the system-calculated
   *  remainingEstimate (OUTPUT_DERIVED session balance) — never merged. */
  operatorRemainingEstimate: number | null;
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

type SessionWithProvenance = PartialBagSession;

/** Confidence + source from the same session as deriveRemainingEstimate. */
export function deriveRemainingProvenance(
  sessions: readonly SessionWithProvenance[],
): { confidence: string | null; source: string | null } {
  const relevant = sessions
    .filter(
      (s) =>
        (s.allocationStatus === "CLOSED" || s.allocationStatus === "RETURNED_TO_STOCK") &&
        s.endingBalanceQty != null,
    )
    .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
  const latest = relevant[0];
  return {
    confidence: latest?.confidence ?? null,
    source: latest?.endingBalanceSource ?? null,
  };
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
      endingBalanceSource: rawBagAllocationSessions.endingBalanceSource,
      confidence: rawBagAllocationSessions.confidence,
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
    const { confidence: remainingConfidence, source: remainingSource } =
      deriveRemainingProvenance(sessions);

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
      remainingConfidence,
      remainingSource,
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
    // Ready rows are keyed off inventory bags only (no workflow-event access),
    // so no operator estimate is available here — surfaced on blocked/held rows.
    operatorRemainingEstimate: null,
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
      endingBalanceSource: rawBagAllocationSessions.endingBalanceSource,
      confidence: rawBagAllocationSessions.confidence,
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
      hasPartialClosePackagingWorkflowEvidence(wfEvents) ||
      isWorkflowBagResumableAtSealingAfterPartialPackaging(wfEvents, {
        stage: candidate.bagStage,
        isFinalized: candidate.isFinalized,
      });
    if (!hasPartialPackagingWorkflow) continue;

    const sessions = sessionsByBagToPartial(
      sessionsByInvBag.get(candidate.inventoryBagId) ?? [],
    );
    let { eligibility, note } = classifyPartialBagInventoryEligibility({
      inventoryStatus: candidate.inventoryStatus,
      sessions,
      hasPartialPackagingWorkflow: true,
    });
    if (
      candidate.isFinalized &&
      eligibility === "missing_linkage" &&
      hasPartialSealingCloseout(wfEvents) &&
      !hasPartialPackagingComplete(wfEvents)
    ) {
      note =
        "Partial close and packaging ran on a legacy terminal path (workflow finalized). No allocation session exists — record tablet use and close allocation before restart.";
    }
    if (eligibility === "ready") continue;

    const lastClosed = [...(sessionsByInvBag.get(candidate.inventoryBagId) ?? [])]
      .filter(
        (s) =>
          s.allocationStatus === "CLOSED" ||
          s.allocationStatus === "RETURNED_TO_STOCK",
      )
      .sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))[0];

    const provenance = deriveRemainingProvenance(sessions);
    // Operator estimate (if any) from the bag's BAG_FINALIZED event — kept
    // distinct from the system-calculated remainingEstimate above.
    const operatorRemainingEstimate =
      wfEvents
        .filter((e) => e.eventType === "BAG_FINALIZED")
        .map((e) => bottleFinalizePayloadRemainingEstimate(e.payload))
        .find((v) => v != null) ?? null;

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
      remainingConfidence: provenance.confidence,
      remainingSource: provenance.source,
      lastConsumedQty: lastClosed?.consumedQty ?? null,
      lastUsedProductName:
        lastClosed?.productName ?? candidate.productName ?? null,
      lastUsedAt: lastClosed?.closedAt ?? null,
      lastSessionStatus: lastClosed?.allocationStatus ?? null,
      eligibility,
      eligibilityNote: note,
      activeWorkflowBagId: candidate.workflowBagId,
      inventoryStatus: candidate.inventoryStatus,
      operatorRemainingEstimate,
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

// ── P1-PARTIAL · explicit reuse confirmation context ────────────────
//
// Starting from a partial bag is an explicit flow: the operator must
// see what the bag is before a new run opens. This context feeds the
// floor confirmation panel (previous product/run, consumed, remaining
// + confidence/source, supplier lot, allocation history).

export type PartialReuseContext = {
  previousProductName: string | null;
  /** Product kind of the last run (e.g. BOTTLE) — lets the floor tailor the
   *  partial-reuse panel ("partial bottle bag"). */
  previousProductKind: string | null;
  lastConsumedQty: number | null;
  /** System-calculated remaining (OUTPUT_DERIVED allocation balance). */
  remainingEstimate: number | null;
  remainingConfidence: string | null;
  remainingSource: string | null;
  /** Optional operator-entered estimate from the last BAG_FINALIZED — shown
   *  SEPARATELY from the system figure, never merged. */
  operatorRemainingEstimate: number | null;
  supplierLot: string | null;
  declaredPillCount: number | null;
  closedSessionCount: number;
  /** ISO string for client serialization. */
  lastClosedAt: string | null;
};

// Accepts a transaction or the root db handle.
type AnyDb = Pick<typeof db, "select">;

export async function loadPartialReuseContext(
  tx: AnyDb,
  inventoryBagId: string,
): Promise<PartialReuseContext> {
  const sessionRows = await tx
    .select({
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      endingBalanceSource: rawBagAllocationSessions.endingBalanceSource,
      confidence: rawBagAllocationSessions.confidence,
      consumedQty: rawBagAllocationSessions.consumedQty,
      closedAt: rawBagAllocationSessions.closedAt,
      productName: products.name,
      productKind: products.kind,
    })
    .from(rawBagAllocationSessions)
    .leftJoin(products, eq(products.id, rawBagAllocationSessions.productId))
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  // Operator estimate (if any) from the most-recent BAG_FINALIZED of a workflow
  // bag that used this inventory bag — kept separate from the system figure.
  const finalizedRows = await tx
    .select({ payload: workflowEvents.payload })
    .from(workflowEvents)
    .innerJoin(
      workflowBags,
      eq(workflowBags.id, workflowEvents.workflowBagId),
    )
    .where(
      and(
        eq(workflowBags.inventoryBagId, inventoryBagId),
        eq(workflowEvents.eventType, "BAG_FINALIZED"),
      ),
    )
    .orderBy(desc(workflowEvents.occurredAt))
    .limit(5);
  let operatorRemainingEstimate: number | null = null;
  for (const row of finalizedRows) {
    const est = bottleFinalizePayloadRemainingEstimate(
      row.payload as Record<string, unknown> | null,
    );
    if (est != null) {
      operatorRemainingEstimate = est;
      break;
    }
  }

  const [bagRow] = await tx
    .select({
      declaredPillCount: inventoryBags.declaredPillCount,
      supplierLot: batches.batchNumber,
    })
    .from(inventoryBags)
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  const sessions = sessionsByBagToPartial(
    sessionRows.map((s) => ({
      allocationStatus: s.allocationStatus as AllocationStatus,
      endingBalanceQty: s.endingBalanceQty,
      endingBalanceSource: s.endingBalanceSource,
      confidence: s.confidence,
      closedAt: s.closedAt,
    })),
  );
  const provenance = deriveRemainingProvenance(sessions);
  const closed = sessionRows
    .filter(
      (s) =>
        s.allocationStatus === "CLOSED" ||
        s.allocationStatus === "RETURNED_TO_STOCK" ||
        s.allocationStatus === "DEPLETED",
    )
    .sort(
      (a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0),
    );
  const last = closed[0] ?? null;

  return {
    previousProductName: last?.productName ?? null,
    previousProductKind: last?.productKind ?? null,
    lastConsumedQty: last?.consumedQty ?? null,
    remainingEstimate: deriveRemainingEstimate(sessions),
    remainingConfidence: provenance.confidence,
    remainingSource: provenance.source,
    operatorRemainingEstimate,
    supplierLot: bagRow?.supplierLot ?? null,
    declaredPillCount: bagRow?.declaredPillCount ?? null,
    closedSessionCount: closed.length,
    lastClosedAt: last?.closedAt ? last.closedAt.toISOString() : null,
  };
}

// ── P1-PARTIAL · held / void / recently depleted bags ───────────────
//
// Workbench sections beyond the reusable set: bags on QA hold, voided
// records, and recently depleted bags (14-day window so the section
// stays scannable). Only bags with ≥1 allocation session OR a blocked
// status are listed — fresh AVAILABLE bags don't belong here.

export type HeldOrDepletedPartialBagRow = {
  bagId: string;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  supplierLot: string | null;
  inventoryStatus: string;
  lastNote: string | null;
  lastClosedAt: Date | null;
};

export async function loadHeldAndDepletedPartialBags(): Promise<{
  held: HeldOrDepletedPartialBagRow[];
  depleted: HeldOrDepletedPartialBagRow[];
}> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      bagId: inventoryBags.id,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      tabletTypeName: tabletTypes.name,
      supplierLot: batches.batchNumber,
      inventoryStatus: inventoryBags.status,
      lastNote: rawBagAllocationSessions.notes,
      lastClosedAt: rawBagAllocationSessions.closedAt,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(
      rawBagAllocationSessions,
      eq(rawBagAllocationSessions.inventoryBagId, inventoryBags.id),
    )
    .where(
      inArray(inventoryBags.status, ["QUARANTINED", "VOID", "EMPTIED"]),
    );

  // Collapse the session join to the most recent closed session per bag.
  const byBag = new Map<string, HeldOrDepletedPartialBagRow>();
  for (const row of rows) {
    const existing = byBag.get(row.bagId);
    if (
      !existing ||
      (row.lastClosedAt?.getTime() ?? 0) >
        (existing.lastClosedAt?.getTime() ?? 0)
    ) {
      byBag.set(row.bagId, {
        bagId: row.bagId,
        bagQrCode: row.bagQrCode,
        internalReceiptNumber: row.internalReceiptNumber,
        tabletTypeName: row.tabletTypeName ?? null,
        supplierLot: row.supplierLot ?? null,
        inventoryStatus: row.inventoryStatus,
        lastNote: row.lastNote ?? null,
        lastClosedAt: row.lastClosedAt ?? null,
      });
    }
  }
  const all = [...byBag.values()];
  const held = all.filter(
    (r) => r.inventoryStatus === "QUARANTINED" || r.inventoryStatus === "VOID",
  );
  const depleted = all.filter(
    (r) =>
      r.inventoryStatus === "EMPTIED" &&
      r.lastClosedAt != null &&
      r.lastClosedAt.getTime() >= cutoff.getTime(),
  );
  const byRecency = (
    a: HeldOrDepletedPartialBagRow,
    b: HeldOrDepletedPartialBagRow,
  ) => (b.lastClosedAt?.getTime() ?? 0) - (a.lastClosedAt?.getTime() ?? 0);
  held.sort(byRecency);
  depleted.sort(byRecency);
  return { held, depleted };
}

// ── P0-ALLOC-REPAIR · active runs missing source allocation ─────────
//
// Admin visibility for the floor's "Source bag allocation missing"
// warning: every unfinalized workflow bag whose inventory bag has NO
// allocation session linked to that run. Legacy bags (started before
// allocation auto-open) land here until a lead repairs them from the
// station screen or an admin resolves the partial inventory.

export type ActiveRunMissingAllocationRow = {
  workflowBagId: string;
  inventoryBagId: string;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  tabletTypeName: string | null;
  productName: string | null;
  stage: string | null;
  startedAt: Date | null;
};

export async function loadActiveRunsMissingAllocation(): Promise<
  ActiveRunMissingAllocationRow[]
> {
  const candidates = await db
    .select({
      workflowBagId: workflowBags.id,
      inventoryBagId: workflowBags.inventoryBagId,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      tabletTypeName: tabletTypes.name,
      productName: products.name,
      stage: readBagState.stage,
      startedAt: workflowBags.startedAt,
    })
    .from(workflowBags)
    .innerJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .innerJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(eq(readBagState.isFinalized, false));
  if (candidates.length === 0) return [];

  const linked = await db
    .select({ workflowBagId: rawBagAllocationSessions.workflowBagId })
    .from(rawBagAllocationSessions)
    .where(
      inArray(
        rawBagAllocationSessions.workflowBagId,
        candidates.map((c) => c.workflowBagId),
      ),
    );
  const linkedIds = new Set(linked.map((l) => l.workflowBagId));

  return candidates
    .filter((c) => !linkedIds.has(c.workflowBagId))
    .map((c) => ({
      workflowBagId: c.workflowBagId,
      inventoryBagId: c.inventoryBagId as string,
      bagQrCode: c.bagQrCode,
      internalReceiptNumber: c.internalReceiptNumber,
      tabletTypeName: c.tabletTypeName ?? null,
      productName: c.productName ?? null,
      stage: c.stage ?? null,
      startedAt: c.startedAt as Date | null,
    }))
    .sort(
      (a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0),
    );
}

function sessionsByBagToPartial(
  sessions: Array<{
    allocationStatus: AllocationStatus;
    endingBalanceQty: number | null;
    endingBalanceSource?: string | null;
    confidence?: string | null;
    closedAt: Date | null;
  }>,
): PartialBagSession[] {
  return sessions.map((s) => ({
    allocationStatus: s.allocationStatus,
    endingBalanceQty: s.endingBalanceQty,
    closedAt: s.closedAt,
    confidence: s.confidence ?? null,
    endingBalanceSource: s.endingBalanceSource ?? null,
  }));
}
