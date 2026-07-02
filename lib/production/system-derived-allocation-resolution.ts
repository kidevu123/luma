// SPLIT-BAG-1 — service that resolves an OPEN raw-bag allocation session using
// system-derived remaining (from production output). Read path computes
// eligibility for display (workbench / floor blocker); write path closes the
// session via the proven closeAllocationSessionInTx — same operation and QR
// handling as a manual closeout, just with a system-derived balance and an
// explicit, auditable SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT provenance.

import { and, eq } from "drizzle-orm";
import type { CurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  products,
  rawBagAllocationSessions,
  workflowBags,
} from "@/lib/db/schema";
import { closeAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";
import { deriveStageOutputForBag } from "@/lib/production/output-reconciliation";
import {
  deriveSystemRemainingFromOutput,
  pickDeepestOutput,
  labelSystemDerivedStage,
  SYSTEM_DERIVED_SOURCE,
  type SystemDerivedResult,
} from "@/lib/production/system-derived-allocation";

type AllocationActor =
  | Pick<CurrentUser, "id" | "role">
  | { id: string | null; role: CurrentUser["role"] | null };

export type SystemDerivedResolution =
  | ({
      available: true;
      sessionId: string;
      workflowBagId: string;
      inventoryBagId: string;
      previousProductName: string | null;
    } & Extract<SystemDerivedResult, { eligible: true }>)
  | {
      available: false;
      sessionId: string | null;
      workflowBagId: string | null;
      previousProductName: string | null;
      reason: string;
      message: string;
    };

/** READ-ONLY: can this bag's OPEN session be resolved from production output?
 *  Returns the derived numbers when yes, or an explicit reason when no. */
export async function computeSystemDerivedResolutionForBag(
  inventoryBagId: string,
): Promise<SystemDerivedResolution> {
  const openSessions = await db
    .select({
      id: rawBagAllocationSessions.id,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
      allocationStatus: rawBagAllocationSessions.allocationStatus,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    );

  if (openSessions.length === 0) {
    return {
      available: false,
      sessionId: null,
      workflowBagId: null,
      previousProductName: null,
      reason: "SESSION_NOT_OPEN",
      message: "This bag has no open allocation session to resolve.",
    };
  }
  const session = openSessions[0]!;

  // Starting balance: session value, else the bag's known pill count.
  let startingBalanceQty = session.startingBalanceQty;
  if (startingBalanceQty == null) {
    const [bag] = await db
      .select({
        pillCount: inventoryBags.pillCount,
        declaredPillCount: inventoryBags.declaredPillCount,
      })
      .from(inventoryBags)
      .where(eq(inventoryBags.id, inventoryBagId))
      .limit(1);
    startingBalanceQty = bag?.pillCount ?? bag?.declaredPillCount ?? null;
  }

  // Product tablets-per-unit + name + deepest production output for the prior run.
  let tabletsPerUnit: number | null = null;
  let previousProductName: string | null = null;
  let output: ReturnType<typeof pickDeepestOutput> = null;
  if (session.workflowBagId) {
    const [wf] = await db
      .select({
        tabletsPerUnit: products.tabletsPerUnit,
        productName: products.name,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .where(eq(workflowBags.id, session.workflowBagId))
      .limit(1);
    tabletsPerUnit = wf?.tabletsPerUnit ?? null;
    previousProductName = wf?.productName ?? null;
    const stageOut = await deriveStageOutputForBag(session.workflowBagId);
    output = pickDeepestOutput(stageOut);
  }

  const result = deriveSystemRemainingFromOutput({
    sessionStatus: session.allocationStatus,
    openSessionCount: openSessions.length,
    startingBalanceQty,
    tabletsPerUnit,
    outputUnits: output?.units ?? null,
    outputStage: output?.stage ?? null,
  });

  if (!result.eligible) {
    return {
      available: false,
      sessionId: session.id,
      workflowBagId: session.workflowBagId ?? null,
      previousProductName,
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    available: true,
    sessionId: session.id,
    workflowBagId: session.workflowBagId!,
    inventoryBagId,
    previousProductName,
    ...result,
  };
}

// ── Floor blocker payload (structured, no string parsing) ────────────

export type FloorOpenAllocationBlock = {
  /** Structural blocker type for the floor UI. */
  blocker:
    | "OPEN_ALLOCATION_CAN_USE_CALCULATED_REMAINING"
    | "OPEN_ALLOCATION_NEEDS_MANUAL";
  inventoryBagId: string;
  cardId: string | null;
  sessionId: string | null;
  workflowBagId: string | null;
  previousProductName: string | null;
  eligible: boolean;
  message: string;
  // Present only when eligible:
  startingTabletCount?: number;
  derivedConsumedTablets?: number;
  derivedRemainingTablets?: number;
  outputStage?: string;
  outputStageLabel?: string;
  outputUnits?: number;
  tabletsPerUnit?: number;
  // Present only when ineligible:
  reason?: string;
};

/** Map a resolution into the floor blocker payload. Pure — no DB. */
export function buildFloorOpenAllocationBlock(args: {
  inventoryBagId: string;
  cardId: string | null;
  resolution: SystemDerivedResolution;
}): FloorOpenAllocationBlock {
  const { inventoryBagId, cardId, resolution } = args;
  if (resolution.available) {
    return {
      blocker: "OPEN_ALLOCATION_CAN_USE_CALCULATED_REMAINING",
      inventoryBagId,
      cardId,
      sessionId: resolution.sessionId,
      workflowBagId: resolution.workflowBagId,
      previousProductName: resolution.previousProductName,
      eligible: true,
      message:
        "Luma can calculate the remaining balance from the previous production counts.",
      startingTabletCount: resolution.startingTabletCount,
      derivedConsumedTablets: resolution.derivedConsumedTablets,
      derivedRemainingTablets: resolution.derivedRemainingTablets,
      outputStage: resolution.outputStage,
      outputStageLabel: labelSystemDerivedStage(resolution.outputStage),
      outputUnits: resolution.outputUnits,
      tabletsPerUnit: resolution.tabletsPerUnit,
    };
  }
  return {
    blocker: "OPEN_ALLOCATION_NEEDS_MANUAL",
    inventoryBagId,
    cardId,
    sessionId: resolution.sessionId,
    workflowBagId: resolution.workflowBagId,
    previousProductName: resolution.previousProductName,
    eligible: false,
    reason: resolution.reason,
    message: resolution.message,
  };
}

export type ResolveSystemDerivedResult =
  | {
      ok: true;
      startingTabletCount: number;
      derivedConsumedTablets: number;
      derivedRemainingTablets: number;
      depleted: boolean;
    }
  | { ok: false; reason: string; error: string };

/** WRITE: resolve the OPEN session from production output. Closes it (CLOSED
 *  when remaining > 0 → bag AVAILABLE, QR held; DEPLETED when 0 → QR released
 *  with assignedWorkflowBagId cleared, all via closeAllocationSessionInTx).
 *  Optional operator estimate / weigh-back grams are recorded as SUPPORTING
 *  evidence only — they never replace the system-derived remaining. */
export async function resolveAllocationFromProductionOutput(args: {
  inventoryBagId: string;
  actor: AllocationActor;
  operatorRemainingEstimate?: number | null;
  weighBackGrams?: number | null;
  note?: string | null;
}): Promise<ResolveSystemDerivedResult> {
  const resolution = await computeSystemDerivedResolutionForBag(
    args.inventoryBagId,
  );
  if (!resolution.available) {
    return { ok: false, reason: resolution.reason, error: resolution.message };
  }

  const stageLabel = labelSystemDerivedStage(resolution.outputStage);
  const note =
    args.note?.trim() ||
    `System-derived from production output (${stageLabel}): ` +
      `${resolution.startingTabletCount.toLocaleString()} start − ` +
      `${resolution.derivedConsumedTablets.toLocaleString()} consumed = ` +
      `${resolution.derivedRemainingTablets.toLocaleString()} remaining. ` +
      `Calculated from production counts, not a physical count.`;

  return db.transaction(async (tx) => {
    const closed = await closeAllocationSessionInTx(tx, {
      sessionId: resolution.sessionId,
      finishedLotId: null,
      consumedQty: resolution.derivedConsumedTablets,
      endingBalanceQty: resolution.derivedRemainingTablets,
      consumedQtySource: "OUTPUT_DERIVED",
      endingBalanceSource: "OUTPUT_DERIVED",
      notes: note,
      actor: args.actor,
    });
    if (!closed.ok) {
      return {
        ok: false,
        reason: "ALLOCATION_CLOSE_FAILED",
        error: closed.error,
      };
    }

    // Rich, honest provenance — this is the auditable record that the close was
    // derived from production output, plus any supporting operator/weight input.
    await writeAudit(
      {
        actorId: args.actor.id ?? null,
        actorRole: args.actor.role ?? null,
        action: "raw_bag_allocation.system_derived_resolution",
        targetType: "RawBagAllocationSession",
        targetId: resolution.sessionId,
        after: {
          resolution_source: SYSTEM_DERIVED_SOURCE,
          starting_tablet_count: resolution.startingTabletCount,
          derived_consumed_tablets: resolution.derivedConsumedTablets,
          derived_remaining_tablets: resolution.derivedRemainingTablets,
          output_stage: resolution.outputStage,
          output_units: resolution.outputUnits,
          tablets_per_unit: resolution.tabletsPerUnit,
          source_workflow_bag_id: resolution.workflowBagId,
          inventory_bag_id: resolution.inventoryBagId,
          operator_remaining_estimate: args.operatorRemainingEstimate ?? null,
          weigh_back_grams: args.weighBackGrams ?? null,
          note: "Calculated from previous production counts — not physically counted.",
        },
      },
      tx,
    );

    return {
      ok: true,
      startingTabletCount: resolution.startingTabletCount,
      derivedConsumedTablets: resolution.derivedConsumedTablets,
      derivedRemainingTablets: resolution.derivedRemainingTablets,
      depleted: resolution.derivedRemainingTablets <= 0,
    };
  });
}
