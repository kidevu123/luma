// BAG-PRODUCTION-SUMMARY-1 — pure per-bag production breakdown.
//
// One normalized, read-only view of "what happened to this bag": received,
// produced, remaining, percent complete — with honest sources and flags.
// All numbers come from Luma's canonical data (inventory bag counts,
// finalized bag metrics / stage outputs, allocation sessions, finished
// lots, Zoho ops); the DB loader lives in
// lib/db/queries/bag-production-summary.ts. This module never fabricates
// values: missing is null + a "Missing"/"Unknown" label, negative
// remaining is shown negative (over-consumed), ambiguity fails closed to
// "Needs review".

import { computeUnitsUnderProduct } from "@/lib/production/wrong-product-correction";

export type BagSummaryWorkflowInput = {
  workflowBagId: string;
  productId: string | null;
  productName: string | null;
  productKind: string | null;
  tabletsPerUnit: number | null;
  /** Current packaging structure — produced units are recomputed live from
   *  the metrics COUNTS under this structure (STALE-SNAPSHOT-MATH-1: the
   *  finalize-time units_yielded snapshot goes stale when the product's
   *  structure is corrected afterwards). */
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  stage: string | null;
  isFinalized: boolean;
  finalizedAt: Date | null;
  excludedFromOutput: boolean;
  recoveryStatus: string | null;
  /** read_bag_metrics snapshot when the bag finalized (null before then). */
  metrics: {
    masterCases: number;
    displaysMade: number;
    looseCards: number;
    damagedPackaging: number;
    rippedCards: number;
    unitsYielded: number;
  } | null;
  /** Deepest recorded stage output when metrics are absent (existing
   *  FINISHED > PACKAGING > SEALING rule from output-reconciliation). */
  deepestOutput: { stage: "FINISHED" | "PACKAGING" | "SEALING"; units: number } | null;
};

export type BagSummaryAllocationInput = {
  sessionId: string;
  /** OPEN | CLOSED | RETURNED_TO_STOCK | DEPLETED (VOIDED filtered out). */
  status: string;
  startingBalanceQty: number | null;
  endingBalanceQty: number | null;
  endingBalanceSource: string | null;
  consumedQty: number | null;
  openedAt: Date | null;
};

export type BagSummaryLotInput = {
  id: string;
  lotNumber: string;
  status: string;
  workflowBagId: string | null;
};

/** Normalized by the loader using the v1.22.1 done-policy vocabulary. */
export type BagSummaryZohoStatus =
  | "COMMITTED"
  | "QUEUED"
  | "READY_TO_QUEUE"
  | "NEEDS_MAPPING"
  | "NOT_READY"
  | "FAILED"
  | "NOT_REQUIRED"
  | "NONE";

export type BagProductionSummaryInput = {
  inventoryBagId: string;
  receiveId: string | null;
  receiptNumber: string | null;
  poId: string | null;
  poNumber: string | null;
  tabletName: string | null;
  supplierLot: string | null;
  qrToken: string | null;
  bagStatus: string;
  pillCount: number | null;
  declaredPillCount: number | null;
  workflows: BagSummaryWorkflowInput[];
  allocationSessions: BagSummaryAllocationInput[];
  finishedLots: BagSummaryLotInput[];
  zoho: { opId: string | null; status: BagSummaryZohoStatus | string; reason: string | null } | null;
};

export type BagProductionSummary = {
  inventoryBagId: string;
  receiveId: string | null;
  receiptNumber: string | null;
  poId: string | null;
  poNumber: string | null;
  tabletName: string | null;
  supplierLot: string | null;
  qrToken: string | null;
  bagStatus: string;

  receivedTablets: number | null;
  /** Actual | Supplier-declared | Missing (data-honesty vocabulary). */
  receivedSource: string;
  producedTablets: number | null;
  /** Packaging counts | Finished output | Sealing counts | No production recorded | Unknown */
  producedSource: string;
  expectedRemainingTablets: number | null;
  recordedRemainingTablets: number | null;
  /** Friendly label for the recorded remaining's source, or null. */
  remainingSource: string | null;
  /** recorded − expected when both are known. */
  remainingDifference: number | null;
  /** The number admins should read first: recorded when present, else expected. */
  remainingDisplay: number | null;
  percentComplete: number | null;

  outputCounts: {
    cases: number;
    displays: number;
    loose: number;
    damaged: number;
    ripped: number;
    unitsYielded: number;
  } | null;

  workflowCount: number;
  /** Latest workflow (loader orders oldest → newest). */
  workflow: {
    workflowBagId: string;
    productName: string | null;
    routeType: string | null;
    stage: string | null;
    finalized: boolean;
    finalizedAt: Date | null;
    excludedFromOutput: boolean;
    recoveryStatus: string | null;
  } | null;

  allocation: {
    sessionId: string;
    status: string;
    startingBalance: number | null;
    endingBalance: number | null;
    consumedQty: number | null;
    source: string | null;
    isOpen: boolean;
    isTerminal: boolean;
  } | null;

  finishedLot: { id: string; lotNumber: string; status: string } | null;
  zoho: { status: string; opId: string | null; reason: string | null };

  flags: {
    overConsumed: boolean;
    partialRemaining: boolean;
    splitBag: boolean;
    multipleWorkflows: boolean;
    consumptionUnknown: boolean;
    remainingMismatch: boolean;
    needsReview: boolean;
  };

  nextAction: string;
  blockerReason: string | null;
};

const TERMINAL_ALLOCATION = new Set(["CLOSED", "RETURNED_TO_STOCK", "DEPLETED"]);

const REMAINING_SOURCE_LABELS: Record<string, string> = {
  SUPERVISOR_ESTIMATE: "Supervisor estimate",
  OPERATOR_ESTIMATE: "Operator estimate",
  SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT: "System-derived",
  ALLOCATION_REPAIR_CLOSEOUT: "Allocation closeout",
  ADMIN_WRONG_PRODUCT_CORRECTION: "Admin correction",
  PRIOR_RETURNED_BALANCE: "Prior returned balance",
  DECLARED: "Supplier-declared",
  WEIGHED: "Weighed",
};

function remainingSourceLabel(source: string | null, status: string): string {
  if (status === "DEPLETED") return "Depleted (allocation closeout)";
  if (!source) return "Allocation closeout";
  return REMAINING_SOURCE_LABELS[source] ?? source;
}

const PRODUCED_SOURCE_BY_STAGE: Record<string, string> = {
  FINISHED: "Finished output",
  PACKAGING: "Packaging counts",
  SEALING: "Sealing counts",
};

type WorkflowProduction = {
  tablets: number | null;
  units: number | null;
  source: string | null;
  unknown: boolean;
};

/** Live units for a workflow with a metrics snapshot: recomputed from the
 *  submitted COUNTS under the CURRENT product structure. The finalize-time
 *  units_yielded snapshot is only a fallback (structure missing) — it goes
 *  stale when the product's packaging structure is corrected after the bag
 *  finalized (STALE-SNAPSHOT-MATH-1, receipt 6337-46). */
function liveUnitsForWorkflow(wf: BagSummaryWorkflowInput): number | null {
  if (!wf.metrics) return wf.deepestOutput?.units ?? null;
  const live = computeUnitsUnderProduct(
    {
      masterCases: wf.metrics.masterCases,
      displaysMade: wf.metrics.displaysMade,
      looseCards: wf.metrics.looseCards,
      bottlesCompleted: 0,
    },
    { unitsPerDisplay: wf.unitsPerDisplay, displaysPerCase: wf.displaysPerCase },
  );
  return live ?? wf.metrics.unitsYielded;
}

/** Produced tablets for one workflow. Excluded (recovered) workflows
 *  contribute nothing — their output is invalid for normal output. */
function computeWorkflowProduction(wf: BagSummaryWorkflowInput): WorkflowProduction {
  if (wf.excludedFromOutput) {
    return { tablets: 0, units: null, source: null, unknown: false };
  }
  const units = liveUnitsForWorkflow(wf);
  if (units == null) {
    // No output recorded yet — honestly zero produced so far, not unknown.
    return { tablets: 0, units: null, source: null, unknown: false };
  }
  if (wf.tabletsPerUnit == null) {
    return { tablets: null, units, source: "Unknown", unknown: true };
  }
  const source = wf.metrics
    ? "Packaging counts"
    : PRODUCED_SOURCE_BY_STAGE[wf.deepestOutput?.stage ?? ""] ?? "Packaging counts";
  return { tablets: units * wf.tabletsPerUnit, units, source, unknown: false };
}

function latestAllocation(
  sessions: BagSummaryAllocationInput[],
): BagSummaryAllocationInput | null {
  if (sessions.length === 0) return null;
  const sorted = [...sessions].sort((a, b) => {
    const ta = a.openedAt?.getTime() ?? 0;
    const tb = b.openedAt?.getTime() ?? 0;
    return ta - tb;
  });
  // Prefer an OPEN session (it is the live one); otherwise the newest.
  const open = sorted.filter((s) => s.status === "OPEN");
  if (open.length > 0) return open[open.length - 1] ?? null;
  return sorted[sorted.length - 1] ?? null;
}

export function computeBagProductionSummary(
  input: BagProductionSummaryInput,
): BagProductionSummary {
  // ── Received ──────────────────────────────────────────────────────────
  let receivedTablets: number | null = null;
  let receivedSource = "Missing";
  if (input.pillCount != null) {
    receivedTablets = input.pillCount;
    receivedSource = "Actual";
  } else if (input.declaredPillCount != null) {
    receivedTablets = input.declaredPillCount;
    receivedSource = "Supplier-declared";
  }

  // ── Produced (sum across workflows) ───────────────────────────────────
  const productions = input.workflows.map(computeWorkflowProduction);
  const consumptionUnknown = productions.some((p) => p.unknown);
  let producedTablets: number | null;
  let producedSource: string;
  if (input.workflows.length === 0) {
    producedTablets = 0;
    producedSource = "No production recorded";
  } else if (consumptionUnknown) {
    producedTablets = null;
    producedSource = "Unknown";
  } else {
    producedTablets = productions.reduce((sum, p) => sum + (p.tablets ?? 0), 0);
    const sources = [...new Set(productions.map((p) => p.source).filter(Boolean))];
    producedSource =
      sources.length > 0
        ? (sources as string[]).join(" + ")
        : "No production recorded";
  }

  // Output counts from the latest workflow with a metrics snapshot.
  const latestWithMetrics = [...input.workflows]
    .reverse()
    .find((w) => w.metrics != null);
  const outputCounts = latestWithMetrics?.metrics
    ? {
        cases: latestWithMetrics.metrics.masterCases,
        displays: latestWithMetrics.metrics.displaysMade,
        loose: latestWithMetrics.metrics.looseCards,
        damaged: latestWithMetrics.metrics.damagedPackaging,
        ripped: latestWithMetrics.metrics.rippedCards,
        // Live math — never the finalize-time snapshot (which goes stale
        // when the product structure is corrected afterwards).
        unitsYielded:
          liveUnitsForWorkflow(latestWithMetrics) ??
          latestWithMetrics.metrics.unitsYielded,
      }
    : null;

  // ── Remaining ─────────────────────────────────────────────────────────
  const expectedRemainingTablets =
    receivedTablets != null && producedTablets != null
      ? receivedTablets - producedTablets
      : null;

  const alloc = latestAllocation(input.allocationSessions);
  const allocIsOpen = alloc?.status === "OPEN";
  const allocIsTerminal = alloc != null && TERMINAL_ALLOCATION.has(alloc.status);
  let recordedRemainingTablets: number | null = null;
  let remainingSource: string | null = null;
  if (alloc && allocIsTerminal) {
    if (alloc.status === "DEPLETED") {
      recordedRemainingTablets = 0;
    } else {
      recordedRemainingTablets = alloc.endingBalanceQty;
    }
    if (recordedRemainingTablets != null) {
      remainingSource = remainingSourceLabel(alloc.endingBalanceSource, alloc.status);
    }
  }

  const remainingDifference =
    expectedRemainingTablets != null && recordedRemainingTablets != null
      ? recordedRemainingTablets - expectedRemainingTablets
      : null;
  const remainingDisplay = recordedRemainingTablets ?? expectedRemainingTablets;

  const percentComplete =
    receivedTablets != null && receivedTablets > 0 && producedTablets != null
      ? Math.round((producedTablets / receivedTablets) * 100)
      : null;

  // ── Latest workflow / lot / zoho ──────────────────────────────────────
  const latestWorkflow = input.workflows[input.workflows.length - 1] ?? null;
  const latestLot = input.finishedLots[input.finishedLots.length - 1] ?? null;
  const zoho = {
    status: input.zoho?.status ?? "NONE",
    opId: input.zoho?.opId ?? null,
    reason: input.zoho?.reason ?? null,
  };

  // ── Flags ─────────────────────────────────────────────────────────────
  const overConsumed =
    (expectedRemainingTablets != null && expectedRemainingTablets < 0) ||
    (recordedRemainingTablets != null && recordedRemainingTablets < 0);
  const flags = {
    overConsumed,
    partialRemaining:
      recordedRemainingTablets != null && recordedRemainingTablets > 0,
    splitBag: input.allocationSessions.length > 1,
    multipleWorkflows: input.workflows.length > 1,
    consumptionUnknown,
    remainingMismatch:
      remainingDifference != null && remainingDifference !== 0,
    needsReview: false, // set below
  };

  // ── Next action (fail closed) ─────────────────────────────────────────
  const { nextAction, blockerReason } = deriveBagNextAction({
    bagStatus: input.bagStatus,
    latestWorkflow,
    latestLotStatus: latestLot?.status ?? null,
    zohoStatus: zoho.status,
    allocIsOpen,
    hasProducedOutput: (producedTablets ?? 0) > 0 || consumptionUnknown,
    receivedKnown: receivedTablets != null,
    consumptionUnknown,
  });

  flags.needsReview =
    consumptionUnknown ||
    receivedTablets == null ||
    /needs review/i.test(nextAction);

  return {
    inventoryBagId: input.inventoryBagId,
    receiveId: input.receiveId,
    receiptNumber: input.receiptNumber,
    poId: input.poId,
    poNumber: input.poNumber,
    tabletName: input.tabletName,
    supplierLot: input.supplierLot,
    qrToken: input.qrToken,
    bagStatus: input.bagStatus,
    receivedTablets,
    receivedSource,
    producedTablets,
    producedSource,
    expectedRemainingTablets,
    recordedRemainingTablets,
    remainingSource,
    remainingDifference,
    remainingDisplay,
    percentComplete,
    outputCounts,
    workflowCount: input.workflows.length,
    workflow: latestWorkflow
      ? {
          workflowBagId: latestWorkflow.workflowBagId,
          productName: latestWorkflow.productName,
          routeType: latestWorkflow.productKind,
          stage: latestWorkflow.stage,
          finalized: latestWorkflow.isFinalized,
          finalizedAt: latestWorkflow.finalizedAt,
          excludedFromOutput: latestWorkflow.excludedFromOutput,
          recoveryStatus: latestWorkflow.recoveryStatus,
        }
      : null,
    allocation: alloc
      ? {
          sessionId: alloc.sessionId,
          status: alloc.status,
          startingBalance: alloc.startingBalanceQty,
          endingBalance: alloc.endingBalanceQty,
          consumedQty: alloc.consumedQty,
          source: alloc.endingBalanceSource,
          isOpen: allocIsOpen,
          isTerminal: allocIsTerminal,
        }
      : null,
    finishedLot: latestLot
      ? { id: latestLot.id, lotNumber: latestLot.lotNumber, status: latestLot.status }
      : null,
    zoho,
    flags,
    nextAction,
    blockerReason,
  };
}

function deriveBagNextAction(args: {
  bagStatus: string;
  latestWorkflow: BagSummaryWorkflowInput | null;
  latestLotStatus: string | null;
  zohoStatus: string;
  allocIsOpen: boolean;
  hasProducedOutput: boolean;
  receivedKnown: boolean;
  consumptionUnknown: boolean;
}): { nextAction: string; blockerReason: string | null } {
  const wf = args.latestWorkflow;

  if (wf?.excludedFromOutput || wf?.recoveryStatus) {
    if (wf.recoveryStatus === "EXTERNAL_RECOVERY_REQUIRED") {
      return {
        nextAction: "Needs review — committed Zoho output",
        blockerReason: "Recovered, but Zoho output was already committed.",
      };
    }
    return {
      nextAction: "Wrong route recovered — start correct workflow",
      blockerReason: null,
    };
  }

  if (!wf) {
    if (args.bagStatus === "EMPTIED" || args.bagStatus === "DEPLETED") {
      return {
        nextAction: "Needs review — emptied with no production recorded",
        blockerReason: "Bag is emptied but no production run was recorded.",
      };
    }
    return { nextAction: "Start workflow", blockerReason: null };
  }

  if (args.consumptionUnknown) {
    return {
      nextAction: "Needs review — production/remaining unknown",
      blockerReason:
        "Output exists but tablets-per-unit is missing — complete product setup to compute produced tablets.",
    };
  }

  if (!wf.isFinalized) {
    return { nextAction: "Finalize workflow (on floor)", blockerReason: null };
  }

  if (!args.latestLotStatus) {
    if (args.allocIsOpen && args.hasProducedOutput) {
      return {
        nextAction: "Resolve remaining / close allocation",
        blockerReason: "Production output exists but the allocation is still open.",
      };
    }
    return { nextAction: "Issue finished lot", blockerReason: null };
  }

  switch (args.latestLotStatus) {
    case "PENDING_QC":
      return { nextAction: "Release lot (QC review)", blockerReason: null };
    case "ON_HOLD":
      return {
        nextAction: "Review QC hold",
        blockerReason: "Finished lot is on hold.",
      };
    case "RELEASED":
      break;
    case "SHIPPED":
      return { nextAction: "Done", blockerReason: null };
    case "RECALLED":
      return {
        nextAction: "Needs review — lot recalled",
        blockerReason: "Finished lot was recalled.",
      };
    default:
      return {
        nextAction: `Needs review — lot status ${args.latestLotStatus}`,
        blockerReason: null,
      };
  }

  switch (args.zohoStatus) {
    case "COMMITTED":
    case "QUEUED":
    case "NOT_REQUIRED":
      return { nextAction: "Done", blockerReason: null };
    case "NEEDS_MAPPING":
      return {
        nextAction: "Fix Zoho mapping",
        blockerReason: "Zoho needs mapping before the output can be queued.",
      };
    case "FAILED":
      return {
        nextAction: "Retry Zoho",
        blockerReason: "Zoho output op failed.",
      };
    case "READY_TO_QUEUE":
    case "NONE":
      return { nextAction: "Queue Zoho", blockerReason: null };
    case "NOT_READY":
      return {
        nextAction: "Review Zoho readiness",
        blockerReason: "Zoho op needs setup/review before queueing.",
      };
    default:
      return { nextAction: "Needs review — Zoho status unclear", blockerReason: null };
  }
}
