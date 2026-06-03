// BAG-CARD-104 legacy partial finalization — read-only verification +
// apply helpers for scripts/repair-bag-card-104-legacy-partial-finalization.ts

import { and, asc, eq } from "drizzle-orm";
import type { db as Db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  readBagState,
  workflowBags,
  workflowEvents,
} from "@/lib/db/schema";
import {
  assessRebuildSafety,
  CORRECTION_KIND_VOID_ERRONEOUS_BAG_FINALIZATION,
  findVoidedWorkflowEventIds,
  isBagFinalizedEventVoided,
  type WorkflowEventSlice,
} from "@/lib/production/bag-finalization-void";
import {
  hasFullSealingLaneClose,
  hasPartialSealingCloseout,
  isPartialSealingClosePayload,
} from "@/lib/production/sealing-partial-closeout";
import { writeAudit } from "@/lib/db/audit";
import { projectEvent } from "@/lib/projector";
import { applyVoidErroneousBagFinalizationRepair } from "@/lib/projector/bag-finalization-void-repair";

type RepairTx = Parameters<typeof applyVoidErroneousBagFinalizationRepair>[0];

type DbOrTx = Parameters<Parameters<typeof Db.transaction>[0]>[0] | typeof Db;

export const REPAIR_SCRIPT_VERSION = "bag-card-104-legacy-partial-finalization-v1";

export type RepairTarget = {
  workflowBagId: string;
  inventoryBagId: string;
  bagCardToken: string;
  receiptNumber: string;
};

export const DEFAULT_TARGET: RepairTarget = {
  workflowBagId: "3d026c01-4521-4825-9c08-3e8e9bd87196",
  inventoryBagId: "a23bec0d-36e8-4b65-a172-a605eb22c559",
  bagCardToken: "bag-card-104",
  receiptNumber: "352171",
};

export type RepairEventChain = {
  partialSealingEventId: string | null;
  partialSealingOccurredAt: Date | null;
  sealedPartialCount: number | null;
  packagingCompleteEventId: string | null;
  packagingCompleteOccurredAt: Date | null;
  bagFinalizedEventId: string | null;
  bagFinalizedOccurredAt: Date | null;
  voidCorrectionEventId: string | null;
};

export type RepairCurrentState = {
  workflowBag: {
    id: string;
    inventoryBagId: string | null;
    finalizedAt: Date | null;
    receiptNumber: string | null;
  } | null;
  readBagState: {
    stage: string;
    isFinalized: boolean;
  } | null;
  inventoryBag: {
    id: string;
    status: string;
    bagQrCode: string | null;
    internalReceiptNumber: string | null;
  } | null;
  qrCard: {
    id: string;
    scanToken: string;
    label: string;
    status: string;
    assignedWorkflowBagId: string | null;
  } | null;
};

export type ProposedMutation =
  | {
      kind: "append_void_correction";
      correctedEventId: string;
      description: string;
    }
  | {
      kind: "clear_workflow_finalized_at";
      description: string;
    }
  | {
      kind: "update_read_bag_state";
      stage: string;
      isFinalized: false;
      description: string;
    }
  | {
      kind: "assign_qr_card";
      qrCardId: string;
      workflowBagId: string;
      description: string;
    }
  | {
      kind: "audit_log";
      action: "partial_bag.legacy_finalization_repair";
      description: string;
    };

export type RepairVerificationResult =
  | {
      ok: true;
      target: RepairTarget;
      eventChain: RepairEventChain;
      current: RepairCurrentState;
      proposedMutations: ProposedMutation[];
      rebuildSafety: ReturnType<typeof assessRebuildSafety>;
      resumableStage: string;
      alreadyRepaired: boolean;
    }
  | { ok: false; abortReason: string };

function asPayload(
  payload: unknown,
): Record<string, unknown> | null {
  return (payload as Record<string, unknown> | null) ?? null;
}

export function verifyLegacyPartialFinalizationRepair(args: {
  workflowBagId: string;
  inventoryBagId: string;
  bagCardToken: string;
  receiptNumber: string;
  events: readonly WorkflowEventSlice[];
  current: RepairCurrentState;
  synthesizerSupportsVoid: boolean;
}): RepairVerificationResult {
  const target = {
    workflowBagId: args.workflowBagId,
    inventoryBagId: args.inventoryBagId,
    bagCardToken: args.bagCardToken,
    receiptNumber: args.receiptNumber,
  };

  if (!args.current.workflowBag) {
    return { ok: false, abortReason: "Target workflow_bag row not found." };
  }
  if (args.current.workflowBag.id !== args.workflowBagId) {
    return { ok: false, abortReason: "Workflow bag id mismatch." };
  }
  if (args.current.workflowBag.inventoryBagId !== args.inventoryBagId) {
    return {
      ok: false,
      abortReason: `Inventory bag mismatch (expected ${args.inventoryBagId}).`,
    };
  }
  if (!args.current.inventoryBag) {
    return { ok: false, abortReason: "Target inventory_bag row not found." };
  }
  if (args.current.inventoryBag.id !== args.inventoryBagId) {
    return { ok: false, abortReason: "Inventory bag id mismatch." };
  }
  if (
    args.current.inventoryBag.internalReceiptNumber !== args.receiptNumber &&
    args.current.workflowBag.receiptNumber !== args.receiptNumber
  ) {
    return {
      ok: false,
      abortReason: `Receipt mismatch (expected ${args.receiptNumber}).`,
    };
  }

  const qrToken = args.current.qrCard?.scanToken ?? args.current.inventoryBag.bagQrCode;
  if (qrToken !== args.bagCardToken) {
    return {
      ok: false,
      abortReason: `QR token mismatch (expected ${args.bagCardToken}, got ${qrToken ?? "null"}).`,
    };
  }

  const partialSealing = [...args.events]
    .filter(
      (e) =>
        e.eventType === "SEALING_COMPLETE" &&
        isPartialSealingClosePayload(asPayload(e.payload)),
    )
    .sort(
      (a, b) =>
        new Date(b.occurredAt ?? 0).getTime() -
        new Date(a.occurredAt ?? 0).getTime(),
    )[0];

  if (!partialSealing?.id) {
    return {
      ok: false,
      abortReason: "Missing SEALING_COMPLETE with partial_close=true.",
    };
  }

  const partialPayload = asPayload(partialSealing.payload);
  if (partialPayload?.lane_close === true) {
    return {
      ok: false,
      abortReason: "Partial sealing event has lane_close=true (not a partial close).",
    };
  }
  const sealedPartialCount =
    typeof partialPayload?.sealed_partial_count === "number"
      ? partialPayload.sealed_partial_count
      : null;
  if (sealedPartialCount == null || sealedPartialCount <= 0) {
    return {
      ok: false,
      abortReason: "Partial sealing event missing sealed_partial_count > 0.",
    };
  }

  const partialAt = partialSealing.occurredAt
    ? new Date(partialSealing.occurredAt)
    : null;

  const packagingComplete = args.events.find(
    (e) =>
      e.eventType === "PACKAGING_COMPLETE" &&
      partialAt != null &&
      e.occurredAt != null &&
      new Date(e.occurredAt).getTime() >= partialAt.getTime(),
  );
  if (!packagingComplete?.id) {
    return {
      ok: false,
      abortReason: "Missing PACKAGING_COMPLETE after partial sealing close.",
    };
  }

  const packagingAt = packagingComplete.occurredAt
    ? new Date(packagingComplete.occurredAt)
    : null;
  const bagFinalized = args.events.find(
    (e) =>
      e.eventType === "BAG_FINALIZED" &&
      packagingAt != null &&
      e.occurredAt != null &&
      new Date(e.occurredAt).getTime() >= packagingAt.getTime(),
  );
  if (!bagFinalized?.id) {
    return {
      ok: false,
      abortReason: "Missing BAG_FINALIZED after partial packaging.",
    };
  }

  if (hasFullSealingLaneClose(args.events)) {
    return {
      ok: false,
      abortReason: "Whole-lane sealing close exists after partial close — not eligible.",
    };
  }

  const voidedIds = findVoidedWorkflowEventIds(args.events);
  const voidCorrection = args.events.find(
    (e) =>
      e.eventType === "SUBMISSION_CORRECTED" &&
      e.payload?.correction_kind === CORRECTION_KIND_VOID_ERRONEOUS_BAG_FINALIZATION,
  );

  const card = args.current.qrCard;
  if (
    card &&
    card.status === "ASSIGNED" &&
    card.assignedWorkflowBagId &&
    card.assignedWorkflowBagId !== args.workflowBagId
  ) {
    return {
      ok: false,
      abortReason: `QR card is ASSIGNED to another workflow (${card.assignedWorkflowBagId}).`,
    };
  }

  const resumableStage =
    hasPartialSealingCloseout(args.events) && !hasFullSealingLaneClose(args.events)
      ? "BLISTERED"
      : "BLISTERED";

  const alreadyRepaired =
    isBagFinalizedEventVoided(bagFinalized.id, args.events) &&
    args.current.readBagState?.isFinalized === false &&
    args.current.workflowBag.finalizedAt == null &&
    (card?.status !== "IDLE" ||
      card?.assignedWorkflowBagId === args.workflowBagId);

  const hasVoidCorrection =
    voidCorrection != null || voidedIds.has(bagFinalized.id);

  const proposedMutations: ProposedMutation[] = [];

  if (!hasVoidCorrection) {
    proposedMutations.push({
      kind: "append_void_correction",
      correctedEventId: bagFinalized.id,
      description:
        "Append SUBMISSION_CORRECTED with correction_kind VOID_ERRONEOUS_BAG_FINALIZATION referencing the erroneous BAG_FINALIZED event (events preserved).",
    });
  }

  if (args.current.workflowBag.finalizedAt != null) {
    proposedMutations.push({
      kind: "clear_workflow_finalized_at",
      description: "Clear workflow_bags.finalized_at so the bag is not terminal.",
    });
  }

  if (
    args.current.readBagState?.isFinalized !== false ||
    args.current.readBagState?.stage === "FINALIZED"
  ) {
    proposedMutations.push({
      kind: "update_read_bag_state",
      stage: resumableStage,
      isFinalized: false,
      description: `Set read_bag_state to resumable partial stage ${resumableStage} with is_finalized=false.`,
    });
  }

  if (
    card &&
    (card.status === "IDLE" ||
      (card.status === "ASSIGNED" && card.assignedWorkflowBagId !== args.workflowBagId))
  ) {
    proposedMutations.push({
      kind: "assign_qr_card",
      qrCardId: card.id,
      workflowBagId: args.workflowBagId,
      description: "Restore QR card ASSIGNED to this workflow bag for sealing resume.",
    });
  }

  if (!alreadyRepaired) {
    proposedMutations.push({
      kind: "audit_log",
      action: "partial_bag.legacy_finalization_repair",
      description: "Write audit_log with before/after state and repair reason.",
    });
  }

  const willApplyVoidCorrection =
    hasVoidCorrection ||
    proposedMutations.some((m) => m.kind === "append_void_correction");

  const rebuildSafety = assessRebuildSafety({
    events: args.events,
    bagFinalizedEventId: bagFinalized.id,
    hasVoidCorrection: willApplyVoidCorrection,
    synthesizerSupportsVoid: args.synthesizerSupportsVoid,
  });

  return {
    ok: true,
    target,
    eventChain: {
      partialSealingEventId: partialSealing.id,
      partialSealingOccurredAt: partialAt,
      sealedPartialCount,
      packagingCompleteEventId: packagingComplete.id,
      packagingCompleteOccurredAt: packagingAt,
      bagFinalizedEventId: bagFinalized.id,
      bagFinalizedOccurredAt: bagFinalized.occurredAt
        ? new Date(bagFinalized.occurredAt)
        : null,
      voidCorrectionEventId: voidCorrection?.id ?? null,
    },
    current: args.current,
    proposedMutations,
    rebuildSafety,
    resumableStage,
    alreadyRepaired,
  };
}

export async function loadRepairCurrentState(
  dbOrTx: DbOrTx,
  args: { workflowBagId: string; bagCardToken: string },
): Promise<RepairCurrentState> {
  const [workflowBag] = await dbOrTx
    .select({
      id: workflowBags.id,
      inventoryBagId: workflowBags.inventoryBagId,
      finalizedAt: workflowBags.finalizedAt,
      receiptNumber: workflowBags.receiptNumber,
    })
    .from(workflowBags)
    .where(eq(workflowBags.id, args.workflowBagId))
    .limit(1);

  const [readState] = workflowBag
    ? await dbOrTx
        .select({ stage: readBagState.stage, isFinalized: readBagState.isFinalized })
        .from(readBagState)
        .where(eq(readBagState.workflowBagId, args.workflowBagId))
        .limit(1)
    : [];

  const inventoryBagId = workflowBag?.inventoryBagId ?? null;
  const [inventoryBag] = inventoryBagId
    ? await dbOrTx
        .select({
          id: inventoryBags.id,
          status: inventoryBags.status,
          bagQrCode: inventoryBags.bagQrCode,
          internalReceiptNumber: inventoryBags.internalReceiptNumber,
        })
        .from(inventoryBags)
        .where(eq(inventoryBags.id, inventoryBagId))
        .limit(1)
    : [];

  const [qrCard] = await dbOrTx
    .select({
      id: qrCards.id,
      scanToken: qrCards.scanToken,
      label: qrCards.label,
      status: qrCards.status,
      assignedWorkflowBagId: qrCards.assignedWorkflowBagId,
    })
    .from(qrCards)
    .where(eq(qrCards.scanToken, args.bagCardToken))
    .limit(1);

  return {
    workflowBag: workflowBag ?? null,
    readBagState: readState ?? null,
    inventoryBag: inventoryBag ?? null,
    qrCard: qrCard ?? null,
  };
}

export async function loadWorkflowEventSlices(
  dbOrTx: DbOrTx,
  workflowBagId: string,
): Promise<WorkflowEventSlice[]> {
  const rows = await dbOrTx
    .select({
      id: workflowEvents.id,
      eventType: workflowEvents.eventType,
      occurredAt: workflowEvents.occurredAt,
      payload: workflowEvents.payload,
    })
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowBagId, workflowBagId))
    .orderBy(asc(workflowEvents.occurredAt), asc(workflowEvents.id));
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    occurredAt: r.occurredAt,
    payload: asPayload(r.payload),
  }));
}

export async function applyLegacyPartialFinalizationRepair(
  tx: RepairTx,
  verified: Extract<RepairVerificationResult, { ok: true }>,
  args: { actorNote?: string | null },
): Promise<{ applied: boolean; voidCorrectionEventId: string | null }> {
  if (verified.alreadyRepaired) {
    return { applied: false, voidCorrectionEventId: verified.eventChain.voidCorrectionEventId };
  }

  if (!verified.rebuildSafety.survivesReadModelRebuild) {
    throw new Error(
      `Refusing apply: ${verified.rebuildSafety.summary}`,
    );
  }

  const before = {
    workflow_bag: verified.current.workflowBag,
    read_bag_state: verified.current.readBagState,
    qr_card: verified.current.qrCard,
    inventory_bag: verified.current.inventoryBag,
  };

  let voidCorrectionEventId = verified.eventChain.voidCorrectionEventId;
  const occurredAt = new Date();

  if (!voidCorrectionEventId && verified.eventChain.bagFinalizedEventId) {
    const clientEventId = crypto.randomUUID();
    await projectEvent(tx, {
      workflowBagId: verified.target.workflowBagId,
      eventType: "SUBMISSION_CORRECTED",
      clientEventId,
      occurredAt,
      payload: {
        client_event_id: clientEventId,
        corrected_event_id: verified.eventChain.bagFinalizedEventId,
        corrected_event_type: "BAG_FINALIZED",
        correction_kind: CORRECTION_KIND_VOID_ERRONEOUS_BAG_FINALIZATION,
        original_value: { terminal: true },
        corrected_value: {
          terminal: false,
          resume_stage: verified.resumableStage,
        },
        correction_reason: "OTHER",
        preserves_original_accountable_employee: true,
        notes:
          "Operator submitted partial close; legacy packaging path finalized workflow before partial-packaging guard was live.",
        accountable_employee_id: null,
        accountability_source: "MANUAL_TEXT",
        accountable_employee_name_snapshot: "legacy-partial-finalization-repair",
        entered_by_user_id: null,
        repair_script_version: REPAIR_SCRIPT_VERSION,
        inventory_bag_id: verified.target.inventoryBagId,
        bag_card_token: verified.target.bagCardToken,
      },
      accountabilitySource: "MANUAL_TEXT",
      accountableEmployeeNameSnapshot: "legacy-partial-finalization-repair",
    });
    voidCorrectionEventId = clientEventId;
  } else if (
    verified.eventChain.voidCorrectionEventId &&
    (verified.current.workflowBag?.finalizedAt != null ||
      verified.current.readBagState?.isFinalized !== false ||
      verified.current.readBagState?.stage === "FINALIZED" ||
      verified.current.qrCard?.status === "IDLE")
  ) {
    await applyVoidErroneousBagFinalizationRepair(tx, {
        workflowBagId: verified.target.workflowBagId,
        resumeStage: verified.resumableStage,
        bagCardScanToken: verified.target.bagCardToken,
        occurredAt,
    });
  }

  const after = {
    workflow_bag: verified.current.workflowBag
      ? { ...verified.current.workflowBag, finalizedAt: null }
      : null,
    read_bag_state: {
      stage: verified.resumableStage,
      isFinalized: false,
    },
    qr_card: verified.current.qrCard
      ? {
          ...verified.current.qrCard,
          status: "ASSIGNED",
          assignedWorkflowBagId: verified.target.workflowBagId,
        }
      : null,
    inventory_bag: verified.current.inventoryBag,
    void_correction_event_id: voidCorrectionEventId,
  };

  await writeAudit(
    {
      actorId: null,
      actorRole: null,
      action: "partial_bag.legacy_finalization_repair",
      targetType: "WorkflowBag",
      targetId: verified.target.workflowBagId,
      before,
      after: {
        ...after,
        reason:
          "Operator submitted partial close, legacy packaging path finalized workflow before partial-packaging guard was live",
        script_version: REPAIR_SCRIPT_VERSION,
        operator_note: args.actorNote ?? null,
      },
    },
    tx,
  );

  return { applied: true, voidCorrectionEventId };
}
