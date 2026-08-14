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
// P5-SUPERVISOR Task 5 — the confidence-tiered supervisor gate.
//
// P4b documented the typed-lead badge as a legacy-parity fallback: with a
// shift open, an unrecognized badge fell back to the station's operator
// session, so the badge was accountability provenance, not a refusal.
// P5 REPLACES that honor-system control with a real check:
//
//   HIGH / MEDIUM confidence (system-derived, facts.needsEntry === false)
//     No supervisor session needed. The number came from production
//     output; the operator is accepting a derivation, not entering one.
//     Accountability is the station's open operator session (via
//     resolveStationAccountability's step-2 fallback).
//
//   LOW confidence (facts.needsEntry === true, i.e. Luma cannot derive
//     the remaining balance and the operator must count)
//     Requires an OPEN, unexpired station_supervisor_sessions row for
//     this station. Enforced server-side inside this module — a hand-
//     crafted request cannot bypass it. The screen (operator-screen.tsx)
//     opens the SupervisorSheet inline before submitting on this branch;
//     the server check is what makes the UI cosmetic.
//     Accountability is the supervisor session's employee, resolved
//     through resolveStationAccountability's SUPERVISOR_OVERRIDE path so
//     the audit trail records who authorised the count.
//
// The badge field (input.overrideEmployeeCode) is intentionally gone —
// nothing here accepts one, and the operator screen removed the
// LeadCodeField that used to collect it.

import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  employees,
  rawBagAllocationSessions,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import { closeAllocationSessionInTx } from "@/lib/production/raw-bag-allocation-lifecycle";
import { resolveStationAccountability } from "@/lib/production/station-operator-session";
import {
  computeSystemDerivedResolutionForBag,
  resolveAllocationFromProductionOutput,
} from "@/lib/production/system-derived-allocation-resolution";
import { requireSupervisorSession } from "./supervisor-session";
import type { Blocker } from "./types";

/** What the RESOLVE_PARTIAL screen needs, or null when this bag has no
 *  prior-run ledger to resolve (the ordinary case). */
export type PartialAllocationFacts = {
  inventoryBagId: string;
  /** The EXACT prior-run session this screen is about. Carried forward
   *  so the manual-count close writes to the row the read identified
   *  rather than re-selecting one — two OPEN rows on the same physical
   *  bag would otherwise let a second query pick a different session,
   *  and the one it could pick is the CURRENT run's own ledger. */
  sessionId: string;
  /** That session's opening balance, read alongside its id for the same
   *  reason. Null on a legacy row that never recorded one. */
  startingBalanceQty: number | null;
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
    .select({
      id: rawBagAllocationSessions.id,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.inventoryBagId, args.inventoryBagId),
        eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ne(rawBagAllocationSessions.workflowBagId, args.workflowBagId),
      ),
    )
    // Deterministic: oldest first, id as the tiebreaker. `limit(1)` on an
    // unordered select is whatever the planner returns, which can change
    // between the read that drew the screen and any later read. Oldest
    // matches loadInventoryContext's own ordering
    // (floor-partial-bag-start-resolution.ts) — the stalest ledger is the
    // one blocking this bag.
    .orderBy(asc(rawBagAllocationSessions.openedAt), asc(rawBagAllocationSessions.id))
    .limit(1);
  if (!priorOpen) return null;

  // Exclude THIS run's own session. Without it the derivation could be
  // computed from the ledger of the bag the operator is still working —
  // and the write below closes whatever it derived.
  const resolution = await computeSystemDerivedResolutionForBag(
    args.inventoryBagId,
    { excludeWorkflowBagId: args.workflowBagId },
  );
  if (resolution.available) {
    return {
      inventoryBagId: args.inventoryBagId,
      sessionId: priorOpen.id,
      startingBalanceQty: priorOpen.startingBalanceQty,
      estimate: resolution.derivedRemainingTablets,
      needsEntry: false,
    };
  }
  return {
    inventoryBagId: args.inventoryBagId,
    sessionId: priorOpen.id,
    startingBalanceQty: priorOpen.startingBalanceQty,
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
  // P5-SUPERVISOR Task 5 — reworded from the P4b legacy-badge message to
  // point at the unlock. The check itself is now a live station_supervisor
  // _sessions row (see requireSupervisorSession below), so the sentence
  // matches the action the operator must take: get a supervisor to unlock
  // the station. The screen opens the SupervisorSheet inline before
  // submitting on the LOW branch, so an operator who reads this sentence
  // is usually the caller of a hand-crafted request or someone whose
  // supervisor session expired mid-count.
  PARTIAL_SUPERVISOR_REQUIRED: {
    code: "PARTIAL_SUPERVISOR_REQUIRED",
    operatorSentence:
      "A supervisor needs to unlock this station to confirm the count.",
    supervisorDetail:
      "LOW-confidence RESOLVE_PARTIAL (facts.needsEntry === true) requires an OPEN station_supervisor_sessions row for this station. requireSupervisorSession returned null — either no supervisor unlocked, or the 15-minute session expired before the submission landed.",
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
};

/** Total: every rejection is a Blocker. Called only from advanceBag,
 *  which wraps unexpected throws as ADVANCE_FAILED.
 *
 *  PRECONDITION — the caller MUST have authenticated the station, the
 *  same guarantee recordStageEvent and claimQueuedBag require.
 *
 *  P5-SUPERVISOR Task 5: on the LOW-confidence path (facts.needsEntry
 *  === true), this function refuses without an OPEN station_supervisor
 *  _sessions row for the station. HIGH/MEDIUM (system-derived) does not
 *  require an unlock — the operator is accepting a derivation, not
 *  entering one — and continues to use the station's open operator
 *  session for accountability. */
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

  if (!facts.needsEntry) {
    // HIGH/MEDIUM confidence — the derivation is available. No
    // supervisor unlock required (spec: LOW is the only confidence
    // level that gets gated). Accountability falls to the station's
    // open operator session via resolveStationAccountability's step-2
    // path; a station with no session at all still surfaces the write's
    // downstream refusal shape rather than being rejected here for
    // "no accountable employee" — the HIGH/MEDIUM path used to accept
    // any-badge-plus-session-fallback and we preserve that surface.
    let derivedEmployeeId: string | null = null;
    await db.transaction(async (tx) => {
      const accountability = await resolveStationAccountability(tx, {
        stationId: input.stationId,
      });
      derivedEmployeeId = accountability.accountableEmployeeId;
    });
    const actor = { id: derivedEmployeeId as string | null, role: null };

    const operatorEstimate = input.physicalQty ?? input.estimate ?? null;
    const result = await resolveAllocationFromProductionOutput({
      inventoryBagId: facts.inventoryBagId,
      actor,
      operatorRemainingEstimate: operatorEstimate,
      // Same exclusion the read used. This helper re-derives internally
      // and CLOSES what it derives, so without it the two halves of this
      // flow could disagree about which session they mean — the read
      // showing the prior run's estimate and the write closing the
      // current run's ledger.
      excludeWorkflowBagId: input.workflowBagId,
    });
    if (!result.ok) return rejected(result.error);
    return { ok: true };
  }

  // LOW confidence (facts.needsEntry === true). Requires a live
  // supervisor session for this station — this is the P5 replacement
  // for the P4b typed-lead badge. Server-side check, so a hand-crafted
  // request without a session is refused here even when the UI would
  // otherwise render the SupervisorSheet inline before submitting.
  const supSession = await db.transaction((tx) =>
    requireSupervisorSession(tx, input.stationId),
  );
  if (!supSession) {
    return {
      ok: false,
      blocker: PARTIAL_BLOCKERS.PARTIAL_SUPERVISOR_REQUIRED as Blocker,
    };
  }

  // Resolve the supervisor's employee code and hand it to
  // resolveStationAccountability so the accountability provenance
  // carries the SUPERVISOR_OVERRIDE hint on the manual-count write.
  // The session's employeeId is authoritative — the code lookup is
  // purely so the accountability resolver can honour its normal
  // employee-code shape without a second code path. If the code is
  // missing (a data-hygiene edge case), we still attribute the write
  // to the supervisor session's employeeId directly.
  const [supEmp] = await db
    .select({ code: employees.employeeCode })
    .from(employees)
    .where(eq(employees.id, supSession.employeeId))
    .limit(1);
  const supervisorCode = supEmp?.code ?? null;

  let leadEmployeeId: string | null = null;
  await db.transaction(async (tx) => {
    const accountability = await resolveStationAccountability(tx, {
      stationId: input.stationId,
      ...(supervisorCode ? { overrideEmployeeCode: supervisorCode } : {}),
      sourceHint: "SUPERVISOR_OVERRIDE",
    });
    leadEmployeeId =
      accountability.accountableEmployeeId ?? supSession.employeeId;
  });
  const actor = { id: leadEmployeeId as string | null, role: null };

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
    facts,
    physicalQty: input.physicalQty,
    actor,
  });
}

/** Close the prior run's OPEN session against an operator-counted
 *  remaining. Provenance is MANUAL_ENTRY on both columns — this number
 *  was counted by a person, and calling it OUTPUT_DERIVED would make the
 *  ledger claim a derivation that never happened.
 *
 *  Writes to facts.sessionId — the row loadPartialAllocationFacts
 *  identified, which is by construction NOT the current run's own
 *  session. Re-selecting "the OPEN session on this inventory bag" here
 *  would match the current run's ledger whenever two are open at once,
 *  and closing that would end a run that is still going. */
async function closeFromPhysicalCount(args: {
  facts: PartialAllocationFacts;
  physicalQty: number;
  actor: { id: string | null; role: null };
}): Promise<{ ok: true } | { ok: false; blocker: Blocker }> {
  const { sessionId, startingBalanceQty, inventoryBagId } = args.facts;
  if (startingBalanceQty == null) {
    return rejected(
      `Session ${sessionId} has no starting balance to count against.`,
    );
  }

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
    // closeAllocationSessionInTx re-reads the row and refuses anything
    // that is no longer OPEN, so a session closed between the read and
    // this write is a clean refusal rather than a double close.
    const closed = await closeAllocationSessionInTx(tx, {
      sessionId,
      finishedLotId: null,
      consumedQty: consumed,
      endingBalanceQty: args.physicalQty,
      consumedQtySource: "MANUAL_ENTRY",
      endingBalanceSource: "MANUAL_ENTRY",
      notes:
        `Operator physical count at the station: ${args.physicalQty.toLocaleString()} tablets remaining ` +
        `(${startingBalanceQty.toLocaleString()} start \u2212 ${consumed.toLocaleString()} consumed). ` +
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
        targetId: sessionId,
        after: {
          resolution_source: "OPERATOR_PHYSICAL_COUNT",
          inventory_bag_id: inventoryBagId,
          starting_balance_qty: startingBalanceQty,
          counted_remaining_tablets: args.physicalQty,
          derived_consumed_tablets: consumed,
          note: "Physically counted at the station \u2014 not a system-derived balance.",
        },
      },
      tx,
    );
    return { ok: true as const };
  });
}
