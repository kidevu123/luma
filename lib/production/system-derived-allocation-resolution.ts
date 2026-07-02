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
    } & Extract<SystemDerivedResult, { eligible: true }>)
  | {
      available: false;
      sessionId: string | null;
      workflowBagId: string | null;
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

  // Product tablets-per-unit + deepest production output for the prior run.
  let tabletsPerUnit: number | null = null;
  let output: ReturnType<typeof pickDeepestOutput> = null;
  if (session.workflowBagId) {
    const [wf] = await db
      .select({ tabletsPerUnit: products.tabletsPerUnit })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .where(eq(workflowBags.id, session.workflowBagId))
      .limit(1);
    tabletsPerUnit = wf?.tabletsPerUnit ?? null;
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
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    available: true,
    sessionId: session.id,
    workflowBagId: session.workflowBagId!,
    inventoryBagId,
    ...result,
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
