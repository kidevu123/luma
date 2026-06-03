// PARTIAL-BAG-REVIEW-CLOSEOUT-WORKFLOW-1 — admin resolution for partial
// bags missing allocation ledger. Never infers remaining from sealed cards.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import type { CurrentUser } from "@/lib/auth";
import {
  batches,
  inventoryBags,
  products,
  rawBagAllocationEvents,
  rawBagAllocationSessions,
  readBagState,
  smallBoxes,
  tabletTypes,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import { deriveBagStatusAfterClose } from "@/lib/production/bag-allocation";
import {
  classifyPartialBagInventoryEligibility,
  hasPartialClosePackagingWorkflowEvidence,
  type PartialBagEligibility,
} from "@/lib/production/partial-bags";
import { canRestartAvailablePartialRawBag } from "@/lib/production/partial-bag-restart";
import {
  hasPartialSealingCloseout,
  hasPartialPackagingComplete,
  isPartialSealingClosePayload,
  isPartialPackagingPayload,
  SEALING_PARTIAL_CLOSE_REASON_LABELS,
} from "@/lib/production/sealing-partial-closeout";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AllocationStatus =
  | "OPEN"
  | "CLOSED"
  | "RETURNED_TO_STOCK"
  | "DEPLETED"
  | "VOIDED";

import {
  confidenceForResolutionMethod,
  MIN_SUPERVISOR_ESTIMATE_NOTE_LENGTH,
  type PartialBagResolutionMethod,
} from "@/lib/production/partial-bag-resolution-constants";

export function validatePartialBagResolutionInput(args: {
  remainingTabletCount: number;
  resolutionMethod: PartialBagResolutionMethod;
  note: string;
  declaredStartingCount: number | null;
  consumedQty?: number | null;
}): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(args.remainingTabletCount) || args.remainingTabletCount < 0) {
    return { ok: false, error: "Remaining tablet count must be a whole number ≥ 0." };
  }
  const note = args.note.trim();
  if (note.length === 0) {
    return { ok: false, error: "A reason or note is required." };
  }
  if (
    args.resolutionMethod === "SUPERVISOR_ESTIMATE" &&
    note.length < MIN_SUPERVISOR_ESTIMATE_NOTE_LENGTH
  ) {
    return {
      ok: false,
      error: `Supervisor estimate requires a reason of at least ${MIN_SUPERVISOR_ESTIMATE_NOTE_LENGTH} characters.`,
    };
  }
  if (note.length > 500) {
    return { ok: false, error: "Note must be 500 characters or fewer." };
  }
  if (
    args.declaredStartingCount != null &&
    args.remainingTabletCount > args.declaredStartingCount
  ) {
    return {
      ok: false,
      error: "Remaining count cannot exceed the declared starting count.",
    };
  }
  if (args.consumedQty != null) {
    if (!Number.isInteger(args.consumedQty) || args.consumedQty < 0) {
      return { ok: false, error: "Consumed quantity must be a whole number ≥ 0." };
    }
    if (args.declaredStartingCount != null) {
      if (args.consumedQty + args.remainingTabletCount !== args.declaredStartingCount) {
        return {
          ok: false,
          error:
            "Consumed + remaining must equal declared starting count when both are provided.",
        };
      }
    }
  }
  return { ok: true };
}

export function canAdminResolvePartialBagInventory(args: {
  eligibility: PartialBagEligibility;
  inventoryStatus: string;
  hasOpenSession: boolean;
  hasPartialPackagingWorkflow: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (args.eligibility === "ready") {
    return { ok: false, reason: "Bag is already ready for restart." };
  }
  if (args.hasOpenSession) {
    return {
      ok: false,
      reason:
        "An allocation session is still open. Close it at the floor before admin resolution.",
    };
  }
  if (!args.hasPartialPackagingWorkflow) {
    return {
      ok: false,
      reason: "No partial-packaging workflow evidence for this inventory bag.",
    };
  }
  if (["VOID", "QUARANTINED", "EMPTIED"].includes(args.inventoryStatus)) {
    return {
      ok: false,
      reason: `Inventory bag status ${args.inventoryStatus} cannot be resolved here.`,
    };
  }
  if (
    args.eligibility !== "missing_linkage" &&
    args.eligibility !== "needs_allocation_closeout"
  ) {
    return { ok: false, reason: "Bag is not eligible for admin inventory resolution." };
  }
  return { ok: true };
}

export type PartialBagReviewContext = {
  inventoryBagId: string;
  bagQrCode: string | null;
  internalReceiptNumber: string | null;
  receiveId: string | null;
  tabletTypeName: string | null;
  supplierLot: string | null;
  declaredPillCount: number | null;
  pillCount: number | null;
  inventoryStatus: string;
  eligibility: PartialBagEligibility;
  eligibilityNote: string;
  activeWorkflowBagId: string | null;
  lastUsedProductName: string | null;
  partialSealingAt: Date | null;
  partialSealedCount: number | null;
  partialCloseReason: string | null;
  partialPackagingAt: Date | null;
  partialPackagingFlag: boolean;
  workflowFinalized: boolean;
};

function readPartialSealedCount(
  payload: Record<string, unknown> | null,
): number | null {
  const n = payload?.sealed_partial_count;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function readPartialCloseReasonLabel(
  payload: Record<string, unknown> | null,
): string | null {
  const reason = payload?.partial_close_reason;
  if (typeof reason !== "string") return null;
  const labels = SEALING_PARTIAL_CLOSE_REASON_LABELS as Record<string, string>;
  return labels[reason] ?? reason;
}

/** Load review context for the admin resolve form. */
export async function loadPartialBagReviewContext(
  inventoryBagId: string,
): Promise<PartialBagReviewContext | null> {
  const [bagRow] = await db
    .select({
      id: inventoryBags.id,
      bagQrCode: inventoryBags.bagQrCode,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      declaredPillCount: inventoryBags.declaredPillCount,
      pillCount: inventoryBags.pillCount,
      status: inventoryBags.status,
      tabletTypeName: tabletTypes.name,
      batchNumber: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  if (!bagRow) return null;

  const wfCandidates = await db
    .select({
      workflowBagId: workflowBags.id,
      productName: products.name,
      bagStage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
    })
    .from(workflowBags)
    .innerJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .innerJoin(inventoryBags, eq(inventoryBags.id, workflowBags.inventoryBagId))
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .where(
      and(
        eq(workflowBags.inventoryBagId, inventoryBagId),
        notInArray(inventoryBags.status, ["VOID", "QUARANTINED"]),
      ),
    );

  if (wfCandidates.length === 0) return null;

  const wfBagIds = wfCandidates.map((c) => c.workflowBagId);
  const wfEventRows = await db
    .select({
      workflowBagId: workflowEvents.workflowBagId,
      eventType: workflowEvents.eventType,
      payload: workflowEvents.payload,
      occurredAt: workflowEvents.occurredAt,
    })
    .from(workflowEvents)
    .where(inArray(workflowEvents.workflowBagId, wfBagIds))
    .orderBy(workflowEvents.occurredAt);

  const eventsByWf = new Map<
    string,
    Array<{
      eventType: string;
      payload: Record<string, unknown> | null;
      occurredAt: Date;
    }>
  >();
  for (const row of wfEventRows) {
    const list = eventsByWf.get(row.workflowBagId) ?? [];
    list.push({
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      occurredAt: row.occurredAt,
    });
    eventsByWf.set(row.workflowBagId, list);
  }

  let activeWorkflowBagId: string | null = null;
  let hasPartialWorkflow = false;
  let lastProduct: string | null = null;
  let partialSealingAt: Date | null = null;
  let partialSealedCount: number | null = null;
  let partialCloseReason: string | null = null;
  let partialPackagingAt: Date | null = null;
  let partialPackagingFlag = false;
  let workflowFinalized = false;

  for (const candidate of wfCandidates) {
    const events = eventsByWf.get(candidate.workflowBagId) ?? [];
    const slices = events.map((e) => ({
      eventType: e.eventType,
      payload: e.payload,
    }));
    if (!hasPartialClosePackagingWorkflowEvidence(slices)) continue;
    activeWorkflowBagId = candidate.workflowBagId;
    hasPartialWorkflow = true;
    lastProduct = candidate.productName ?? null;
    workflowFinalized = candidate.isFinalized;

    for (const ev of events) {
      if (
        ev.eventType === "SEALING_COMPLETE" &&
        isPartialSealingClosePayload(ev.payload)
      ) {
        partialSealingAt = ev.occurredAt;
        partialSealedCount = readPartialSealedCount(ev.payload);
        partialCloseReason = readPartialCloseReasonLabel(ev.payload);
      }
      if (ev.eventType === "PACKAGING_COMPLETE") {
        partialPackagingAt = ev.occurredAt;
        partialPackagingFlag = isPartialPackagingPayload(ev.payload);
      }
    }
    break;
  }

  if (!hasPartialWorkflow || !activeWorkflowBagId) return null;

  const sessionRows = await db
    .select({
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      closedAt: rawBagAllocationSessions.closedAt,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId))
    .orderBy(desc(rawBagAllocationSessions.openedAt));

  const typedSessions = sessionRows.map((s) => ({
    allocationStatus: s.allocationStatus as AllocationStatus,
    endingBalanceQty: s.endingBalanceQty,
    closedAt: s.closedAt,
  }));

  const { eligibility, note } = classifyPartialBagInventoryEligibility({
    inventoryStatus: bagRow.status,
    sessions: typedSessions,
    hasPartialPackagingWorkflow: true,
  });

  let eligibilityNote = note;
  if (
    workflowFinalized &&
    eligibility === "missing_linkage" &&
    hasPartialSealingCloseout(
      (eventsByWf.get(activeWorkflowBagId) ?? []).map((e) => ({
        eventType: e.eventType,
        payload: e.payload,
      })),
    ) &&
    !hasPartialPackagingComplete(
      (eventsByWf.get(activeWorkflowBagId) ?? []).map((e) => ({
        eventType: e.eventType,
        payload: e.payload,
      })),
    )
  ) {
    eligibilityNote =
      "Partial close and packaging ran on a legacy terminal path (workflow finalized). No allocation session exists — record tablet use and close allocation before restart.";
  }

  return {
    inventoryBagId: bagRow.id,
    bagQrCode: bagRow.bagQrCode,
    internalReceiptNumber: bagRow.internalReceiptNumber,
    receiveId: bagRow.receiveId ?? null,
    tabletTypeName: bagRow.tabletTypeName ?? null,
    supplierLot: bagRow.batchNumber ?? null,
    declaredPillCount: bagRow.declaredPillCount,
    pillCount: bagRow.pillCount,
    inventoryStatus: bagRow.status,
    eligibility,
    eligibilityNote,
    activeWorkflowBagId,
    lastUsedProductName: lastProduct,
    partialSealingAt,
    partialSealedCount,
    partialCloseReason,
    partialPackagingAt,
    partialPackagingFlag,
    workflowFinalized,
  };
}

export type ResolvePartialBagInventoryArgs = {
  inventoryBagId: string;
  remainingTabletCount: number;
  resolutionMethod: PartialBagResolutionMethod;
  note: string;
  consumedQty?: number | null;
  actor: CurrentUser;
};

/** Admin resolution: record physically verified remaining tablets and
 *  create a closed allocation session. Never uses sealed card counts. */
export async function resolvePartialBagInventoryLedger(
  args: ResolvePartialBagInventoryArgs,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const context = await loadPartialBagReviewContext(args.inventoryBagId);
  if (!context) {
    return { ok: false, error: "Partial bag review context not found." };
  }

  const sessionRows = await db
    .select({
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      closedAt: rawBagAllocationSessions.closedAt,
      poId: rawBagAllocationSessions.poId,
      productId: rawBagAllocationSessions.productId,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId))
    .orderBy(desc(rawBagAllocationSessions.openedAt));

  const typedSessions = sessionRows.map((s) => ({
    allocationStatus: s.allocationStatus as AllocationStatus,
    endingBalanceQty: s.endingBalanceQty,
    closedAt: s.closedAt,
  }));

  const hasOpenSession = typedSessions.some((s) => s.allocationStatus === "OPEN");
  const eligibility = classifyPartialBagInventoryEligibility({
    inventoryStatus: context.inventoryStatus,
    sessions: typedSessions,
    hasPartialPackagingWorkflow: true,
  }).eligibility;

  const gate = canAdminResolvePartialBagInventory({
    eligibility,
    inventoryStatus: context.inventoryStatus,
    hasOpenSession,
    hasPartialPackagingWorkflow: true,
  });
  if (!gate.ok) return { ok: false, error: gate.reason };

  if (
    canRestartAvailablePartialRawBag({
      inventoryStatus: context.inventoryStatus,
      sessions: typedSessions,
    })
  ) {
    return { ok: false, error: "Bag is already ready for restart." };
  }

  const declaredStarting =
    context.declaredPillCount ?? context.pillCount ?? null;
  const inputCheck = validatePartialBagResolutionInput({
    remainingTabletCount: args.remainingTabletCount,
    resolutionMethod: args.resolutionMethod,
    note: args.note,
    declaredStartingCount: declaredStarting,
    consumedQty: args.consumedQty ?? null,
  });
  if (!inputCheck.ok) return { ok: false, error: inputCheck.error };

  const consumedQty =
    args.consumedQty ??
    (declaredStarting != null
      ? declaredStarting - args.remainingTabletCount
      : null);

  const confidence = confidenceForResolutionMethod(args.resolutionMethod);
  const endingSource = args.resolutionMethod;
  const now = new Date();
  const clientEventId = randomUUID();

  const bagPoRows = (await db.execute(sql`
    SELECT po.id::text AS po_id
    FROM inventory_bags ib
    LEFT JOIN small_boxes sb ON sb.id = ib.small_box_id
    LEFT JOIN receives r ON r.id = sb.receive_id
    LEFT JOIN purchase_orders po ON po.id = r.po_id
    WHERE ib.id = ${args.inventoryBagId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ po_id: string | null }>;
  const poId = bagPoRows[0]?.po_id ?? null;

  let sessionId = "";
  await db.transaction(async (tx) => {
    const priorState = {
      inventoryStatus: context.inventoryStatus,
      eligibility,
      sessionCount: typedSessions.length,
      workflowBagId: context.activeWorkflowBagId,
    };

    const [session] = await tx
      .insert(rawBagAllocationSessions)
      .values({
        inventoryBagId: args.inventoryBagId,
        ...(poId ? { poId } : {}),
        ...(context.activeWorkflowBagId
          ? { workflowBagId: context.activeWorkflowBagId }
          : {}),
        allocationStatus:
          args.remainingTabletCount > 0 ? "RETURNED_TO_STOCK" : "DEPLETED",
        openedAt: now,
        closedAt: now,
        openedByUserId: args.actor.id,
        closedByUserId: args.actor.id,
        ...(declaredStarting != null
          ? {
              startingBalanceQty: declaredStarting,
              startingBalanceSource: "VENDOR_DECLARED",
            }
          : {}),
        ...(consumedQty != null && consumedQty > 0
          ? {
              consumedQty,
              consumedQtySource: args.resolutionMethod,
            }
          : {}),
        endingBalanceQty: args.remainingTabletCount,
        endingBalanceSource: endingSource,
        unitOfMeasure: "tablets",
        confidence,
        notes: `admin_partial_bag_review_closeout | ${args.note.trim()}`,
      })
      .returning({ id: rawBagAllocationSessions.id });

    if (!session) throw new Error("Failed to create allocation session.");
    sessionId = session.id;

    const eventBase = {
      allocationSessionId: session.id,
      inventoryBagId: args.inventoryBagId,
      ...(poId ? { poId } : {}),
      ...(context.activeWorkflowBagId
        ? { workflowBagId: context.activeWorkflowBagId }
        : {}),
      unitOfMeasure: "tablets" as const,
      payload: {
        admin_partial_bag_review_closeout: true,
        resolution_method: args.resolutionMethod,
        note: args.note.trim(),
        entered_by_user_id: args.actor.id,
        workflow_bag_id: context.activeWorkflowBagId,
        prior_eligibility: eligibility,
      },
      confidence,
      clientEventId,
    };

    if (declaredStarting != null) {
      await tx.insert(rawBagAllocationEvents).values({
        ...eventBase,
        eventType: "RAW_BAG_OPENED",
        quantity: String(declaredStarting),
        quantitySource: "VENDOR_DECLARED",
        clientEventId: `${clientEventId}-open`,
      });
    }

    if (consumedQty != null && consumedQty > 0) {
      await tx.insert(rawBagAllocationEvents).values({
        ...eventBase,
        eventType: "RAW_BAG_PARTIAL_CONSUMED",
        quantity: String(consumedQty),
        quantitySource: args.resolutionMethod,
        clientEventId: `${clientEventId}-consumed`,
      });
    }

    if (args.resolutionMethod === "WEIGH_BACK") {
      await tx.insert(rawBagAllocationEvents).values({
        ...eventBase,
        eventType: "RAW_BAG_REWEIGHED",
        quantity: String(args.remainingTabletCount),
        quantitySource: "WEIGH_BACK",
        clientEventId: `${clientEventId}-reweigh`,
      });
    } else {
      await tx.insert(rawBagAllocationEvents).values({
        ...eventBase,
        eventType: "RAW_BAG_RETURNED_TO_STOCK",
        quantity: String(args.remainingTabletCount),
        quantitySource: args.resolutionMethod,
        clientEventId: `${clientEventId}-return`,
      });
    }

    const newBagStatus = deriveBagStatusAfterClose(args.remainingTabletCount);
    if (newBagStatus != null) {
      await tx
        .update(inventoryBags)
        .set({ status: newBagStatus })
        .where(eq(inventoryBags.id, args.inventoryBagId));
    }

    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: args.actor.role,
        action: "partial_bag.inventory_resolution",
        targetType: "InventoryBag",
        targetId: args.inventoryBagId,
        before: priorState,
        after: {
          sessionId: session.id,
          allocationStatus:
            args.remainingTabletCount > 0 ? "RETURNED_TO_STOCK" : "DEPLETED",
          endingBalanceQty: args.remainingTabletCount,
          consumedQty,
          resolutionMethod: args.resolutionMethod,
          confidence,
          inventoryStatus: newBagStatus ?? context.inventoryStatus,
          workflowBagId: context.activeWorkflowBagId,
        },
      },
      tx,
    );
  });

  return { ok: true, sessionId };
}
