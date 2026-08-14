// SPLIT-BAG-1 — service that resolves an OPEN raw-bag allocation session using
// system-derived remaining (from production output). Read path computes
// eligibility for display (workbench / floor blocker); write path closes the
// session via the proven closeAllocationSessionInTx — same operation and QR
// handling as a manual closeout, just with a system-derived balance and an
// explicit, auditable SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT provenance.

import { and, asc, eq, ne } from "drizzle-orm";
import type { CurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import {
  inventoryBags,
  products,
  rawBagAllocationSessions,
  readBagMetrics,
  workflowBags,
} from "@/lib/db/schema";
import { closeAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";
import { deriveStageOutputForBag } from "@/lib/production/output-reconciliation";
import {
  deriveSystemRemainingFromOutput,
  pickDeepestOutput,
  pickFinalizedOutput,
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
      /** True when derivation used finalized read_bag_metrics counts rather than
       *  live stage-segment sums (Bug A fix for multi-pickup runs). */
      usedFinalizedCounts: boolean;
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
 *  Returns the derived numbers when yes, or an explicit reason when no.
 *
 *  P4b Task 5 fix round 2 — `opts.excludeWorkflowBagId`. A physical bag can
 *  carry more than one OPEN session (the exact state the floor's partial
 *  screen exists to clear), and this select used to take whichever row the
 *  planner returned first. For every EXISTING caller that is harmless-ish
 *  and unchanged: they are asking "what is open on this bag" from outside
 *  any run. For the RESOLVE_PARTIAL path it is not — that caller has a run
 *  of its OWN in flight, and picking its session would derive, and then
 *  CLOSE, the ledger of the bag the operator is still working. So the
 *  exclusion is opt-in (behaviour unchanged unless passed) while the
 *  ORDERING is unconditional: an unordered `select` has no defined row
 *  order, so two reads a second apart could legitimately disagree, and a
 *  deterministic read is strictly better for every caller. */
export async function computeSystemDerivedResolutionForBag(
  inventoryBagId: string,
  opts?: { excludeWorkflowBagId?: string },
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
        ...(opts?.excludeWorkflowBagId
          ? [ne(rawBagAllocationSessions.workflowBagId, opts.excludeWorkflowBagId)]
          : []),
      ),
    )
    // Oldest first, id as the tiebreaker — the same ordering
    // loadInventoryContext and loadPartialAllocationFacts use. The
    // stalest ledger is the one blocking the bag.
    .orderBy(
      asc(rawBagAllocationSessions.openedAt),
      asc(rawBagAllocationSessions.id),
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
  // When the workflow bag is FINALIZED, prefer the finalized read_bag_metrics counts
  // over stage-segment sums (Bug A fix): multi-pickup runs accumulate all segments
  // into read_bag_metrics but sealing segments only reflect individual segment sums.
  let tabletsPerUnit: number | null = null;
  let previousProductName: string | null = null;
  let output: ReturnType<typeof pickDeepestOutput> = null;
  let usedFinalizedCounts = false;
  if (session.workflowBagId) {
    const [wf] = await db
      .select({
        tabletsPerUnit: products.tabletsPerUnit,
        productName: products.name,
        unitsPerDisplay: products.unitsPerDisplay,
        displaysPerCase: products.displaysPerCase,
        finalizedAt: workflowBags.finalizedAt,
      })
      .from(workflowBags)
      .leftJoin(products, eq(products.id, workflowBags.productId))
      .where(eq(workflowBags.id, session.workflowBagId))
      .limit(1);
    tabletsPerUnit = wf?.tabletsPerUnit ?? null;
    previousProductName = wf?.productName ?? null;

    // When finalized, use the finalized read_bag_metrics counts (authoritative
    // across all pickups/segments). Fall back to stage-segment derivation for
    // mid-run (unfinalized) resolution so the floor live path keeps working.
    if (wf?.finalizedAt) {
      const [metrics] = await db
        .select({
          masterCases: readBagMetrics.masterCases,
          displaysMade: readBagMetrics.displaysMade,
          looseCards: readBagMetrics.looseCards,
        })
        .from(readBagMetrics)
        .where(eq(readBagMetrics.workflowBagId, session.workflowBagId))
        .limit(1);
      if (metrics) {
        const finalizedOut = pickFinalizedOutput({
          isFinalized: true,
          masterCases: metrics.masterCases,
          displaysMade: metrics.displaysMade,
          looseCards: metrics.looseCards,
          unitsPerDisplay: wf.unitsPerDisplay ?? null,
          displaysPerCase: wf.displaysPerCase ?? null,
        });
        if (finalizedOut) {
          output = finalizedOut;
          usedFinalizedCounts = true;
        }
      }
    }

    // Fall back to stage-segment derivation when not finalized or finalized
    // output could not be computed (incomplete packaging structure, zero counts).
    if (!output) {
      const stageOut = await deriveStageOutputForBag(session.workflowBagId);
      output = pickDeepestOutput(stageOut);
    }
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
    usedFinalizedCounts,
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
  /** Threaded straight through to computeSystemDerivedResolutionForBag —
   *  see its comment. This function CLOSES the session it derives, so a
   *  caller with a run in flight must be able to say "not mine". */
  excludeWorkflowBagId?: string;
}): Promise<ResolveSystemDerivedResult> {
  const resolution = await computeSystemDerivedResolutionForBag(
    args.inventoryBagId,
    args.excludeWorkflowBagId
      ? { excludeWorkflowBagId: args.excludeWorkflowBagId }
      : undefined,
  );
  if (!resolution.available) {
    return { ok: false, reason: resolution.reason, error: resolution.message };
  }

  const stageLabel = labelSystemDerivedStage(resolution.outputStage);
  const countSource = resolution.usedFinalizedCounts
    ? "Calculated from finalized production counts"
    : "Calculated from production counts";
  const note =
    args.note?.trim() ||
    `System-derived from production output (${stageLabel}): ` +
      `${resolution.startingTabletCount.toLocaleString()} start − ` +
      `${resolution.derivedConsumedTablets.toLocaleString()} consumed = ` +
      `${resolution.derivedRemainingTablets.toLocaleString()} remaining. ` +
      `${countSource}, not a physical count.`;

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
          used_finalized_counts: resolution.usedFinalizedCounts,
          note: resolution.usedFinalizedCounts
            ? "Calculated from finalized production counts — not physically counted."
            : "Calculated from previous production counts — not physically counted.",
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
