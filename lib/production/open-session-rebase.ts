// REBASE-OPEN-SESSION-1 — correct an OPEN raw-bag allocation session's starting
// balance that was opened from the wrong count (pre-v1.16.0 bug: a reused
// partial bag started from the original declared count instead of the prior
// returned balance). This REBASES the balance in place and leaves the session
// OPEN so the run can still accept production numbers later — it does NOT close,
// deplete, finalize, touch the QR, or invent any production output.

import { and, eq } from "drizzle-orm";
import type { CurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/db/audit";
import { rawBagAllocationEvents, rawBagAllocationSessions } from "@/lib/db/schema";
import { loadLatestTerminalAllocationSession } from "@/lib/production/raw-bag-allocation-lifecycle";
import { deriveStageOutputForBag } from "@/lib/production/output-reconciliation";

type RebaseActor =
  | Pick<CurrentUser, "id" | "role">
  | { id: string | null; role: CurrentUser["role"] | null };

/** True only when a run has POSITIVE recorded production output. Critical:
 *  deriveStageOutputForBag returns `sealedOutput` as 0 (not null) when there are
 *  no sealing events (that column is COALESCE(...,0)+COALESCE(...,0)), so a
 *  `!= null` check would treat a fresh, un-consumed run as "has output" and
 *  wrongly block the rebase. Zero / null = no output. */
export function hasRealProductionOutput(output: {
  grossBlisters: number | null;
  sealedOutput: number | null;
  packagedOutput: number | null;
  finishedOutput: number | null;
}): boolean {
  return (
    (output.grossBlisters ?? 0) > 0 ||
    (output.sealedOutput ?? 0) > 0 ||
    (output.packagedOutput ?? 0) > 0 ||
    (output.finishedOutput ?? 0) > 0
  );
}

export type OpenSessionRebaseEligibility =
  | {
      available: true;
      sessionId: string;
      workflowBagId: string | null;
      currentStartingBalance: number | null;
      priorSessionId: string;
      priorEndingBalance: number;
      priorEndingBalanceSource: string | null;
      priorStatus: string;
      newStartingBalance: number;
    }
  | { available: false; reason: string; message: string };

/** READ-ONLY: can this bag's OPEN session be rebased to the prior returned
 *  balance? Eligible only when: exactly one OPEN session, a prior TERMINAL
 *  session with ending balance > 0 exists, the current starting balance differs
 *  from it, and NO production output has been recorded on the open run. */
export async function computeOpenSessionRebaseEligibility(
  inventoryBagId: string,
): Promise<OpenSessionRebaseEligibility> {
  const openSessions = await db
    .select({
      id: rawBagAllocationSessions.id,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
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
      reason: "SESSION_NOT_OPEN",
      message: "This bag has no open allocation session to correct.",
    };
  }
  if (openSessions.length > 1) {
    return {
      available: false,
      reason: "MULTIPLE_OPEN_SESSIONS",
      message: "This bag has more than one open session — resolve them individually.",
    };
  }
  const session = openSessions[0]!;

  const priorTerminal = await loadLatestTerminalAllocationSession(db, inventoryBagId);
  if (!priorTerminal) {
    return {
      available: false,
      reason: "NO_PRIOR_TERMINAL_SESSION",
      message:
        "No prior closed/returned session exists — nothing to rebase from. Use a manual count instead.",
    };
  }
  if (priorTerminal.endingBalanceQty == null || priorTerminal.endingBalanceQty <= 0) {
    return {
      available: false,
      reason: "NO_PRIOR_RETURNED_BALANCE",
      message:
        "The prior session left no positive returned balance (it was depleted or unknown). Use a manual count or mark depleted.",
    };
  }
  if (session.startingBalanceQty === priorTerminal.endingBalanceQty) {
    return {
      available: false,
      reason: "ALREADY_CORRECT",
      message: `The open session already starts at the prior returned balance (${priorTerminal.endingBalanceQty.toLocaleString()}).`,
    };
  }

  // Guard: never rebase a session that already has production output — the
  // starting balance would then be entangled with recorded consumption.
  // deriveStageOutputForBag returns sealedOutput as 0 (not null) when there are
  // NO sealing events (that column is COALESCE(...,0)+COALESCE(...,0)), so a
  // strict `!= null` check would treat a fresh run with zero output as "has
  // output" and wrongly block the rebase. Treat only POSITIVE output as real
  // consumption (same as pickDeepestOutput). Handpack/release/pickup events are
  // not output; prior-run sealing evidence lives on a DIFFERENT workflow bag.
  if (session.workflowBagId) {
    const output = await deriveStageOutputForBag(session.workflowBagId);
    if (hasRealProductionOutput(output)) {
      return {
        available: false,
        reason: "HAS_PRODUCTION_OUTPUT",
        message:
          "Production output has already been recorded on this run — rebasing the starting balance is unsafe. Review the run manually.",
      };
    }
  }

  return {
    available: true,
    sessionId: session.id,
    workflowBagId: session.workflowBagId ?? null,
    currentStartingBalance: session.startingBalanceQty,
    priorSessionId: priorTerminal.id,
    priorEndingBalance: priorTerminal.endingBalanceQty,
    priorEndingBalanceSource: priorTerminal.endingBalanceSource,
    priorStatus: priorTerminal.allocationStatus,
    newStartingBalance: priorTerminal.endingBalanceQty,
  };
}

export type RebaseOpenSessionResult =
  | { ok: true; newStartingBalance: number; priorSessionId: string }
  | { ok: false; reason: string; error: string };

/** WRITE: rebase the OPEN session's starting balance to the prior returned
 *  balance (PRIOR_RETURNED_BALANCE). Session stays OPEN; QR, inventory status,
 *  workflow, and production counts are untouched. Audited. */
export async function rebaseOpenSessionStartingBalance(args: {
  inventoryBagId: string;
  note?: string | null;
  actor: RebaseActor;
}): Promise<RebaseOpenSessionResult> {
  const eligibility = await computeOpenSessionRebaseEligibility(args.inventoryBagId);
  if (!eligibility.available) {
    return { ok: false, reason: eligibility.reason, error: eligibility.message };
  }

  const note =
    args.note?.trim() ||
    `Rebased open session starting balance from ${eligibility.currentStartingBalance ?? "unknown"} to ` +
      `${eligibility.newStartingBalance.toLocaleString()} (prior ${eligibility.priorStatus} session returned balance). ` +
      `Session left OPEN for later production entry; no output recorded.`;

  return db.transaction(async (tx) => {
    // Re-check inside the tx that the session is still OPEN (race-safe).
    const [current] = await tx
      .select({
        allocationStatus: rawBagAllocationSessions.allocationStatus,
        startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
        poId: rawBagAllocationSessions.poId,
        productId: rawBagAllocationSessions.productId,
        workflowBagId: rawBagAllocationSessions.workflowBagId,
      })
      .from(rawBagAllocationSessions)
      .where(eq(rawBagAllocationSessions.id, eligibility.sessionId))
      .limit(1);
    if (!current || current.allocationStatus !== "OPEN") {
      return {
        ok: false as const,
        reason: "SESSION_NOT_OPEN",
        error: "The session is no longer open — refresh and try again.",
      };
    }

    await tx
      .update(rawBagAllocationSessions)
      .set({
        startingBalanceQty: eligibility.newStartingBalance,
        startingBalanceSource: "PRIOR_RETURNED_BALANCE",
        // allocationStatus stays OPEN; closedAt/consumedQty/endingBalance untouched.
      })
      .where(eq(rawBagAllocationSessions.id, eligibility.sessionId));

    await tx.insert(rawBagAllocationEvents).values({
      allocationSessionId: eligibility.sessionId,
      inventoryBagId: args.inventoryBagId,
      ...(current.poId ? { poId: current.poId } : {}),
      ...(current.productId ? { productId: current.productId } : {}),
      ...(current.workflowBagId ? { workflowBagId: current.workflowBagId } : {}),
      eventType: "RAW_BAG_ADJUSTED",
      quantity: String(eligibility.newStartingBalance),
      unitOfMeasure: "tablets",
      quantitySource: "PRIOR_RETURNED_BALANCE",
      ...(args.actor.id ? { actorUserId: args.actor.id } : {}),
      payload: {
        admin_correction: "rebase_open_session_starting_balance",
        old_starting_balance: eligibility.currentStartingBalance,
        new_starting_balance: eligibility.newStartingBalance,
        prior_session_id: eligibility.priorSessionId,
        prior_ending_balance: eligibility.priorEndingBalance,
        prior_ending_balance_source: eligibility.priorEndingBalanceSource,
        prior_status: eligibility.priorStatus,
        session_left_open: true,
        note,
      },
      confidence: "MEDIUM",
    });

    await writeAudit(
      {
        actorId: args.actor.id ?? null,
        actorRole: args.actor.role ?? null,
        action: "raw_bag_allocation.starting_balance_rebased",
        targetType: "RawBagAllocationSession",
        targetId: eligibility.sessionId,
        before: { starting_balance_qty: eligibility.currentStartingBalance },
        after: {
          starting_balance_qty: eligibility.newStartingBalance,
          starting_balance_source: "PRIOR_RETURNED_BALANCE",
          prior_session_id: eligibility.priorSessionId,
          prior_ending_balance: eligibility.priorEndingBalance,
          prior_ending_balance_source: eligibility.priorEndingBalanceSource,
          prior_status: eligibility.priorStatus,
          session_left_open: true,
          inventory_bag_id: args.inventoryBagId,
          note,
        },
      },
      tx,
    );

    return {
      ok: true as const,
      newStartingBalance: eligibility.newStartingBalance,
      priorSessionId: eligibility.priorSessionId,
    };
  });
}
