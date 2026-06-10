// P0-ALLOC-REPAIR — Source-bag allocation status for an in-flight run.
//
// The floor station screen shows where the current bag's allocation
// ledger stands and offers leads an immediate repair when it is
// missing. Four distinguishable situations (the requirement: never a
// generic warning):
//   healthy        — OPEN session linked to this run.
//   closed         — this run's session exists but was already closed.
//   missing_legacy — run started before allocation auto-open shipped
//                    (CARD_ASSIGNED has no allocation_session_id).
//   missing_bug    — run claims a session id but none can be found —
//                    a data bug leads should repair AND report.

export type SourceAllocationStatusKind =
  | "healthy"
  | "closed"
  | "missing_legacy"
  | "missing_bug"
  | "no_inventory_link";

export type SourceAllocationStatus = {
  kind: SourceAllocationStatusKind;
  sessionId: string | null;
  /** Operator/lead-facing one-liner. */
  message: string;
  /** True when the panel should offer the lead repair action. */
  repairable: boolean;
};

export type SessionForStatus = {
  id: string;
  allocationStatus: string;
  workflowBagId: string | null;
};

export function classifySourceAllocation(args: {
  workflowBagId: string;
  hasInventoryLink: boolean;
  /** Sessions on the inventory bag (any run). */
  sessions: readonly SessionForStatus[];
  /** Whether this run's CARD_ASSIGNED payload recorded an
   *  allocation_session_id (auto-open era) — distinguishes legacy
   *  bags from bugs. */
  cardAssignedHadAllocationId: boolean;
}): SourceAllocationStatus {
  if (!args.hasInventoryLink) {
    return {
      kind: "no_inventory_link",
      sessionId: null,
      message:
        "This run is not linked to a received bag, so source allocation " +
        "cannot be tracked. A lead should link the bag from the Receive " +
        "Pills page.",
      repairable: false,
    };
  }

  const linked = args.sessions.filter(
    (s) => s.workflowBagId === args.workflowBagId,
  );
  const openLinked = linked.find((s) => s.allocationStatus === "OPEN");
  if (openLinked) {
    return {
      kind: "healthy",
      sessionId: openLinked.id,
      message: "Source bag allocation open and healthy.",
      repairable: false,
    };
  }
  const closedLinked = linked[0] ?? null;
  if (closedLinked) {
    return {
      kind: "closed",
      sessionId: closedLinked.id,
      message:
        "Source allocation for this run is already closed. If this bag is " +
        "still being poured, a lead can reopen it so consumption stays on " +
        "the ledger.",
      repairable: true,
    };
  }

  if (args.cardAssignedHadAllocationId) {
    return {
      kind: "missing_bug",
      sessionId: null,
      message:
        "Source bag allocation missing — this run opened a session that " +
        "can no longer be found. A lead should repair the allocation now " +
        "and report the issue.",
      repairable: true,
    };
  }
  return {
    kind: "missing_legacy",
    sessionId: null,
    message:
      "Source bag allocation missing — this bag started before allocation " +
      "tracking. A lead can open one now so the run stays traceable.",
    repairable: true,
  };
}
