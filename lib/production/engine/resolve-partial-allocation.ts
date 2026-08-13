// RESOLVE-PARTIAL-1 — the RESOLVE_PARTIAL intent's read and write.
//
// WHAT THE SCREEN IS ASKING. A physical raw bag can carry an OPEN
// raw-bag allocation session from a PREVIOUS run (the operator stopped
// mid-bag and the ledger was never closed). Until that session is
// closed, the bag cannot open a new one — ensureOpenRawBagAllocation-
// SessionForWorkflowBag answers OPEN_SESSION_ON_BAG, which
// assign-bag-product.ts turns into OpenAllocationBlockError and the
// floor has rendered as open-allocation-calc-panel.tsx since SPLIT-BAG-1.
// The spec's partial-bag screens are that panel with the machinery
// removed: HIGH/MEDIUM confidence shows the conclusion and one button,
// LOW asks the operator to count.
//
// WHERE THE NUMBERS COME FROM. computeSystemDerivedResolutionForBag —
// the same read resolveScannedBagAllocationAction uses. Available means
// production output can derive the remaining balance (the estimate);
// unavailable means it cannot, which is precisely NextAction's
// needsEntry.
//
// WHAT THE WRITE DOES. Both paths land on the SAME helper the legacy
// floor action calls, resolveAllocationFromProductionOutput, and it
// already accepts the operator's number as `operatorRemainingEstimate`
// (it records it as provenance alongside the derived close). When the
// derivation is NOT available there is nothing for that helper to close
// against, so the operator's physical count closes the session directly
// through closeAllocationSessionInTx — the same function
// resolveAllocationFromProductionOutput itself calls — with
// MANUAL_ENTRY provenance rather than OUTPUT_DERIVED. Nothing is
// dropped and nothing is invented: an operator count is never labelled
// system-derived (luma-data-honesty).
//
// THE LEAD GATE IS PRESERVED. resolveScannedBagAllocationAction is
// lead-gated (resolveStationAccountability with a SUPERVISOR_OVERRIDE
// badge) because closing an allocation ledger is not an ordinary
// operator gesture. That gate is kept here verbatim in intent — the
// spec's inline supervisor PIN replaces the typed badge in P5, when
// station_supervisor_sessions lands.

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { rawBagAllocationSessions } from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { closeAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  computeSystemDerivedResolutionForBag,
  resolveAllocationFromProductionOutput,
} from "@/lib/production/system-derived-allocation-resolution";
import type { Blocker } from "./types";

/** What the RESOLVE_PARTIAL screen needs, or null when this bag has no
 *  prior-run ledger to resolve (the ordinary case). */
export type PartialAllocationFacts = {
  inventoryBagId: string;
  /** System-derived tablets remaining, or null when it cannot be
   *  derived. Never a physical count. */
  estimate: number | null;
  /** True when Luma cannot derive the remaining balance and the
   *  operator must count. Mirrors the spec's LOW screen. */
  needsEntry: boolean;
};

/** Does this physical bag still carry an OPEN allocation session that
 *  belongs to a DIFFERENT workflow bag?
 *
 *  The bag's OWN open session is the normal in-production state and must
 *  never raise the partial screen; only a session left behind by another
 *  run blocks this one. Same predicate ensureOpenRawBagAllocation-
 *  SessionForWorkflowBag refuses on, evaluated as a read so the screen
 *  can ask BEFORE the operator hits the refusal. */
export async function loadPartialAllocationFacts(args: {
  inventoryBagId: string | null;
  workflowBagId: string;
}): Promise<PartialAllocationFacts | null> {
  if (!args.inventoryBagId) return null;
  const [priorOpen] = await db
    .select({ id: rawBagAllocationSessions.id })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ne(rawBagAllocationSessions.workflowBagId, args.workflowBagId),
      ),
    )
    .limit(1);
  if (!priorOpen) return null;

  const resolution = await computeSystemDerivedResolutionForBag(
    args.inventoryBagId,
  );
  if (resolution.available) {
    return {
      inventoryBagId: args.inventoryBagId,
      estimate: resolution.derivedRemainingTablets,
      needsEntry: false,
    };
  }
  return {
    inventoryBagId: args.inventoryBagId,
    estimate: null,
    needsEntry: true,
  };
}

const PARTIAL_BLOCKERS: Readonly<Record<string, Blocker>> = {
  PARTIAL_NOTHING_TO_RESOLVE: {
    code: "PARTIAL_NOTHING_TO_RESOLVE",
    operatorSentence: "There is nothing to resolve on this bag.",
    supervisorDetail:
      "No OPEN raw_bag_allocation_sessions row from a prior workflow bag on this inventory bag.",
    suggestedAction: "NONE",
  },
  PARTIAL_SUPERVISOR_REQUIRED: {
    code: "PARTIAL_SUPERVISOR_REQUIRED",
    operatorSentence:
      "A lead has to confirm this bag's remaining count. Ask a supervisor.",
    supervisorDetail:
      "Closing a raw-bag allocation session is lead-gated (resolveScannedBagAllocationAction's own gate); no badge code was supplied.",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
  PARTIAL_QUANTITY_REQUIRED: {
    code: "PARTIAL_QUANTITY_REQUIRED",
    operatorSentence: "Enter how many tablets are left in this bag.",
    supervisorDetail:
      "RESOLVE_PARTIAL arrived with neither inputs.physicalQty nor partialRemainingEstimate, and the balance cannot be derived from production output.",
    suggestedAction: "ENTER_QUANTITY",
  },
  PARTIAL_RESOLVE_REJECTED: {
    code: "PARTIAL_RESOLVE_REJECTED",
    operatorSentence: "This bag's remaining count could not be saved. Ask a supervisor.",
    supervisorDetail: "The allocation close was refused.",
    suggestedAction: "NOTIFY_SUPERVISOR",
  },
};

function rejected(detail: string): { ok: false; blocker: Blocker } {
  const base = PARTIAL_BLOCKERS.PARTIAL_RESOLVE_REJECTED as Blocker;
  return { ok: false, blocker: { ...base, supervisorDetail: detail } };
}

export type ResolvePartialAllocationInput = {
  stationId: string;
  workflowBagId: string;
  inventoryBagId: string | null;
  /** The operator's own count, from the LOW/needsEntry screen. */
  physicalQty?: number;
  /** The estimate the HIGH/MEDIUM screen showed and the operator
   *  accepted. Recorded as provenance; the close still uses the
   *  derivation so the ledger and the audit agree. */
  estimate?: number;
  /** Lead badge code — the gate resolveScannedBagAllocationAction
   *  enforces. */
  overrideEmployeeCode?: string;
};

/** Total: every rejection is a Blocker. Called only from advanceBag,
 *  which wraps unexpected throws as ADVANCE_FAILED.
 *
 *  PRECONDITION — the caller MUST have authenticated the station, the
 *  same guarantee recordStageEvent and claimQueuedBag require. */
export async function resolvePartialAllocation(
  input: ResolvePartialAllocationInput,
): Promise<{ ok: true } | { ok: false; blocker: Blocker }> {
  const facts = await loadPartialAllocationFacts({
    inventoryBagId: input.inventoryBagId,
    workflowBagId: input.workflowBagId,
  });
  if (!facts) {
    return { ok: false, blocker: PARTIAL_BLOCKERS.PARTIAL_NOTHING_TO_RESOLVE as Blocker };
  }

  const badge = input.overrideEmployeeCode?.trim();
  if (!badge) {
    return {
      ok: false,
      blocker: PARTIAL_BLOCKERS.PARTIAL_SUPERVISOR_REQUIRED as Blocker,
    };
  }

  // Same gate, same resolver, same refusal shape as the legacy floor
  // action: a normal operator badge does not close a ledger.
  let leadEmployeeId: string | null = null;
  await db.transaction(async (tx) => {
    const accountability = await resolveStationAccountability(tx, {
      stationId: input.stationId,
      overrideEmployeeCode: badge,
      sourceHint: "SUPERVISOR_OVERRIDE",
    });
    leadEmployeeId = accountability.accountableEmployeeId;
  });
  if (!leadEmployeeId) {
    return {
      ok: false,
      blocker: PARTIAL_BLOCKERS.PARTIAL_SUPERVISOR_REQUIRED as Blocker,
    };
  }
  const actor = { id: leadEmployeeId as string | null, role: null };

  if (!facts.needsEntry) {
    // The derivation is available: close from production output, exactly
    // as resolveScannedBagAllocationAction does, carrying the operator's
    // number (whichever screen supplied one) as supporting provenance.
    const operatorEstimate = input.physicalQty ?? input.estimate ?? null;
    const result = await resolveAllocationFromProductionOutput({
      inventoryBagId: facts.inventoryBagId,
      actor,
      operatorRemainingEstimate: operatorEstimate,
    });
    if (!result.ok) return rejected(result.error);
    return { ok: true };
  }

  // No derivation. The operator's physical count is the only honest
  // number, so it must be present — never defaulted to zero, which would
  // silently deplete a bag that still has tablets in it.
  if (input.physicalQty == null) {
    return {
      ok: false,
      blocker: PARTIAL_BLOCKERS.PARTIAL_QUANTITY_REQUIRED as Blocker,
    };
  }
  return closeFromPhysicalCount({
    inventoryBagId: facts.inventoryBagId,
    physicalQty: input.physicalQty,
    actor,
  });
}

/** Close the prior run's OPEN session against an operator-counted
 *  remaining. Provenance is MANUAL_ENTRY on both columns — this number
 *  was counted by a person, and calling it OUTPUT_DERIVED would make the
 *  ledger claim a derivation that never happened. */
async function closeFromPhysicalCount(args: {
  inventoryBagId: string;
  physicalQty: number;
  actor: { id: string | null; role: null };
}): Promise<{ ok: true } | { ok: false; blocker: Blocker }> {
  const [session] = await db
    .select({
      id: rawBagAllocationSessions.id,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
      ),
    )
    .limit(1);
  if (!session || session.startingBalanceQty == null) {
    return { ok: false, blocker: PARTIAL_BLOCKERS.PARTIAL_NOTHING_TO_RESOLVE as Blocker };
  }
  const startingBalanceQty = session.startingBalanceQty;

  const consumed = startingBalanceQty - args.physicalQty;
  if (consumed <= 0) {
    // closeAllocationSessionInTx refuses a non-positive consumption, and
    // the refusal is right: a bag that consumed nothing was never really
    // run, and a count ABOVE the starting balance is a miscount, not a
    // ledger fact.
    return rejected(
      `Counted remaining (${args.physicalQty}) is not less than the starting balance (${startingBalanceQty}).`,
    );
  }

  return db.transaction(async (tx) => {
    const closed = await closeAllocationSessionInTx(tx, {
      sessionId: session.id,
      finishedLotId: null,
      consumedQty: consumed,
      endingBalanceQty: args.physicalQty,
      consumedQtySource: "MANUAL_ENTRY",
      endingBalanceSource: "MANUAL_ENTRY",
      notes:
        `Operator physical count at the station: ${args.physicalQty.toLocaleString()} tablets remaining ` +
        `(${startingBalanceQty.toLocaleString()} start − ${consumed.toLocaleString()} consumed). ` +
        `Counted by a person, not derived from production output.`,
      actor: args.actor,
    });
    if (!closed.ok) return rejected(closed.error);

    await writeAudit(
      {
        actorId: args.actor.id,
        actorRole: null,
        action: "raw_bag_allocation.operator_physical_count_resolution",
        targetType: "RawBagAllocationSession",
        targetId: session.id,
        after: {
          resolution_source: "OPERATOR_PHYSICAL_COUNT",
          inventory_bag_id: args.inventoryBagId,
          starting_balance_qty: startingBalanceQty,
          counted_remaining_tablets: args.physicalQty,
          derived_consumed_tablets: consumed,
          note: "Physically counted at the station — not a system-derived balance.",
        },
      },
      tx,
    );
    return { ok: true as const };
  });
}
