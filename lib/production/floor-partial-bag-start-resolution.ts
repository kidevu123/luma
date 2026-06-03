// FLOOR-PARTIAL-BAG-START-RESOLUTION-1 — classify raw bag scans before
// the generic receive-first error. Reuses /partial-bags eligibility rules.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  readBagState,
  rawBagAllocationSessions,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import {
  classifyPartialBagInventoryEligibility,
  hasPartialClosePackagingWorkflowEvidence,
  type PartialBagSession,
} from "@/lib/production/partial-bags";
import { canRestartAvailablePartialRawBag } from "@/lib/production/partial-bag-restart";
import { isWorkflowBagResumableAtSealingAfterPartialPackaging } from "@/lib/production/sealing-partial-closeout";
import { lookupInventoryBagByQrScanToken } from "@/lib/production/workflow-bag-tablet-context";

type DbOrTx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export type RawBagStartStatus =
  | "UNLINKED"
  | "FRESH_READY"
  | "PARTIAL_READY"
  | "PARTIAL_NEEDS_REVIEW"
  | "PARTIAL_NEEDS_ALLOCATION_CLOSEOUT"
  | "DEPLETED"
  | "ACTIVE_ELSEWHERE";

export type RawBagStartClassification = {
  status: RawBagStartStatus;
  inventoryBagId: string | null;
  canStart: boolean;
  operatorMessage: string;
  eligibilityNote: string | null;
};

export const RAW_BAG_START_OPERATOR_MESSAGES = {
  UNLINKED:
    "This bag QR has not been linked to a received bag. Receive the bag first on the Receive Pills page.",
  PARTIAL_NEEDS_REVIEW:
    "This partial bag needs inventory review before it can be started. Ask a lead/admin to resolve remaining tablets on Available Partial Bags.",
  PARTIAL_READY_WRONG_STATION:
    "This partial bag is ready for a new run. Scan it at a blister, handpack, or combined first-operation station, or use Available Partial Bags → Start run.",
  DEPLETED: "This bag has no tablets remaining and cannot be started again.",
  ACTIVE_ELSEWHERE:
    "This bag is already active in production elsewhere. Ask a supervisor before continuing.",
} as const;

type InventoryContext = {
  inventoryBagId: string;
  inventoryStatus: string;
  sessions: PartialBagSession[];
  hasPartialPackagingWorkflow: boolean;
  hasActiveNonFinalizedWorkflow: boolean;
};

/** Pure classification from loaded inventory context (no card state). */
export function classifyRawBagStartFromInventoryContext(
  ctx: InventoryContext | null,
): RawBagStartClassification {
  if (!ctx) {
    return {
      status: "UNLINKED",
      inventoryBagId: null,
      canStart: false,
      operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.UNLINKED,
      eligibilityNote: null,
    };
  }

  if (ctx.inventoryStatus === "EMPTIED" || ctx.inventoryStatus === "VOID") {
    return {
      status: "DEPLETED",
      inventoryBagId: ctx.inventoryBagId,
      canStart: false,
      operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.DEPLETED,
      eligibilityNote: null,
    };
  }

  if (
    ctx.sessions.length > 0 &&
    ctx.sessions.every(
      (s) => s.allocationStatus === "DEPLETED" || s.allocationStatus === "VOIDED",
    )
  ) {
    return {
      status: "DEPLETED",
      inventoryBagId: ctx.inventoryBagId,
      canStart: false,
      operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.DEPLETED,
      eligibilityNote: null,
    };
  }

  if (ctx.hasPartialPackagingWorkflow) {
    const { eligibility, note } = classifyPartialBagInventoryEligibility({
      inventoryStatus: ctx.inventoryStatus,
      sessions: ctx.sessions,
      hasPartialPackagingWorkflow: true,
    });

    if (eligibility === "ready") {
      const partialReady = canRestartAvailablePartialRawBag({
        inventoryStatus: ctx.inventoryStatus,
        sessions: ctx.sessions,
      });
      return {
        status: partialReady ? "PARTIAL_READY" : "FRESH_READY",
        inventoryBagId: ctx.inventoryBagId,
        canStart: true,
        operatorMessage: "",
        eligibilityNote: note,
      };
    }

    if (eligibility === "needs_allocation_closeout") {
      return {
        status: "PARTIAL_NEEDS_ALLOCATION_CLOSEOUT",
        inventoryBagId: ctx.inventoryBagId,
        canStart: false,
        operatorMessage: note,
        eligibilityNote: note,
      };
    }

    return {
      status: "PARTIAL_NEEDS_REVIEW",
      inventoryBagId: ctx.inventoryBagId,
      canStart: false,
      operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW,
      eligibilityNote: note,
    };
  }

  if (ctx.hasActiveNonFinalizedWorkflow) {
    return {
      status: "ACTIVE_ELSEWHERE",
      inventoryBagId: ctx.inventoryBagId,
      canStart: false,
      operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.ACTIVE_ELSEWHERE,
      eligibilityNote: null,
    };
  }

  if (!ctx.hasPartialPackagingWorkflow) {
    if (ctx.inventoryStatus === "AVAILABLE") {
      return {
        status: "FRESH_READY",
        inventoryBagId: ctx.inventoryBagId,
        canStart: true,
        operatorMessage: "",
        eligibilityNote: null,
      };
    }
    return {
      status: "DEPLETED",
      inventoryBagId: ctx.inventoryBagId,
      canStart: false,
      operatorMessage: `Raw bag status is ${ctx.inventoryStatus}; only AVAILABLE bags can start production.`,
      eligibilityNote: null,
    };
  }

  return {
    status: "PARTIAL_NEEDS_REVIEW",
    inventoryBagId: ctx.inventoryBagId,
    canStart: false,
    operatorMessage: RAW_BAG_START_OPERATOR_MESSAGES.PARTIAL_NEEDS_REVIEW,
    eligibilityNote: null,
  };
}

async function loadInventoryContext(
  dbOrTx: DbOrTx,
  inventoryBagId: string,
): Promise<Omit<InventoryContext, "inventoryBagId"> & { inventoryBagId: string }> {
  const [bag] = await dbOrTx
    .select({ status: inventoryBags.status })
    .from(inventoryBags)
    .where(eq(inventoryBags.id, inventoryBagId))
    .limit(1);

  const sessionRows = await dbOrTx
    .select({
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      closedAt: rawBagAllocationSessions.closedAt,
    })
    .from(rawBagAllocationSessions)
    .where(eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId))
    .orderBy(asc(rawBagAllocationSessions.openedAt));

  const sessions = sessionRows as PartialBagSession[];

  const wfRows = await dbOrTx
    .select({
      workflowBagId: workflowBags.id,
      bagStage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
    })
    .from(workflowBags)
    .innerJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .where(eq(workflowBags.inventoryBagId, inventoryBagId))
    .orderBy(desc(workflowBags.startedAt));

  let hasPartialPackagingWorkflow = false;
  let hasActiveNonFinalizedWorkflow = false;

  if (wfRows.length > 0) {
    const wfBagIds = wfRows.map((r) => r.workflowBagId);
    const eventRows = await dbOrTx
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
    for (const row of eventRows) {
      const list = eventsByWfBag.get(row.workflowBagId) ?? [];
      list.push({
        eventType: row.eventType,
        payload: (row.payload as Record<string, unknown> | null) ?? null,
      });
      eventsByWfBag.set(row.workflowBagId, list);
    }

    for (const wf of wfRows) {
      const wfEvents = eventsByWfBag.get(wf.workflowBagId) ?? [];
      if (
        hasPartialClosePackagingWorkflowEvidence(wfEvents) ||
        isWorkflowBagResumableAtSealingAfterPartialPackaging(wfEvents, {
          stage: wf.bagStage,
          isFinalized: wf.isFinalized,
        })
      ) {
        hasPartialPackagingWorkflow = true;
      }
      if (!wf.isFinalized) {
        hasActiveNonFinalizedWorkflow = true;
      }
    }
  }

  return {
    inventoryBagId,
    inventoryStatus: bag?.status ?? "",
    sessions,
    hasPartialPackagingWorkflow,
    hasActiveNonFinalizedWorkflow,
  };
}

async function resolveInventoryBagIdForScanTokens(
  dbOrTx: DbOrTx,
  tokens: readonly string[],
): Promise<string | null> {
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const link = await lookupInventoryBagByQrScanToken(dbOrTx, trimmed);
    if (link?.inventoryBagId) return link.inventoryBagId;
  }
  return null;
}

/** Load inventory + partial workflow context and classify start eligibility. */
export async function loadRawBagStartClassificationForScan(
  dbOrTx: DbOrTx,
  args: { scannedToken: string; cardScanToken?: string | null },
): Promise<RawBagStartClassification> {
  const tokens = [
    args.scannedToken,
    ...(args.cardScanToken ? [args.cardScanToken] : []),
  ];
  const inventoryBagId = await resolveInventoryBagIdForScanTokens(dbOrTx, tokens);
  if (!inventoryBagId) {
    return classifyRawBagStartFromInventoryContext(null);
  }
  const ctx = await loadInventoryContext(dbOrTx, inventoryBagId);
  return classifyRawBagStartFromInventoryContext(ctx);
}

/** Admin start gate — block partial bags that are not Ready. */
export function adminStartBlockedMessage(
  classification: RawBagStartClassification,
): string | null {
  if (classification.canStart) return null;
  if (classification.status === "UNLINKED") {
    return RAW_BAG_START_OPERATOR_MESSAGES.UNLINKED;
  }
  return classification.operatorMessage;
}
