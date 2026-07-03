// AUTO-QC-RELEASE-1 — eligibility for auto-releasing a PENDING_QC finished lot
// to RELEASED. Fails closed: only a clean, boring lot with no QC signal is
// AUTO_RELEASE_READY. Everything else stays PENDING_QC for a human. This does
// NOT commit to Zoho — release only flips the internal Luma QC status (the Zoho
// output cron picks up RELEASED lots separately, as it already does for manual
// releases).

import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  finishedLotQcEvents,
  products,
  rawBagAllocationSessions,
  readBagState,
  workflowBags,
} from "@/lib/db/schema";

export type FinishedLotReleaseStatus =
  | "AUTO_RELEASE_READY"
  | "NEEDS_QC_REVIEW"
  | "BLOCKED"
  | "ALREADY_RELEASED"
  | "NOT_FOUND";

export type FinishedLotReleaseCode =
  | "READY"
  | "NOT_FOUND"
  | "ALREADY_RELEASED"
  | "NOT_PENDING_QC"
  | "ON_HOLD"
  | "MISSING_WORKFLOW_BAG"
  | "WORKFLOW_NOT_FINALIZED"
  | "MISSING_PRODUCT"
  | "INCOMPLETE_PRODUCT_SETUP"
  | "MISSING_OUTPUT_COUNTS"
  | "MISSING_RECEIPT"
  | "REWORK_PENDING"
  | "HAS_CORRECTION"
  | "EXCLUDED_FROM_OUTPUT"
  | "RECOVERY_FLAGGED"
  | "QC_EVENT_PRESENT"
  | "OPEN_ALLOCATION_ON_SOURCE"
  | "LOT_NUMBER_CONFLICT";

export type FinishedLotReleaseEvaluation = {
  status: FinishedLotReleaseStatus;
  code: FinishedLotReleaseCode;
  message: string;
};

export type FinishedLotReleaseEligibilityInput = {
  found: boolean;
  /** finished_lots.status */
  lotStatus: string | null;
  workflowBagId: string | null;
  workflowFinalized: boolean;
  productId: string | null;
  unitsPerDisplay: number | null;
  displaysPerCase: number | null;
  tabletsPerUnit: number | null;
  unitsProduced: number | null;
  finishedLotNumber: string | null;
  isOnHold: boolean;
  reworkPending: boolean;
  hasCorrection: boolean;
  excludedFromOutput: boolean;
  /** read_bag_state.recovery_status non-null (e.g. WRONG_ROUTE_RECOVERED). */
  recoveryFlagged: boolean;
  qcEventCount: number;
  openAllocationOnSource: boolean;
  lotNumberConflict: boolean;
};

function evalOf(
  status: FinishedLotReleaseStatus,
  code: FinishedLotReleaseCode,
  message: string,
): FinishedLotReleaseEvaluation {
  return { status, code, message };
}

/** Pure classifier — fail closed. Anything uncertain → NEEDS_QC_REVIEW/BLOCKED. */
export function classifyFinishedLotReleaseEligibility(
  input: FinishedLotReleaseEligibilityInput,
): FinishedLotReleaseEvaluation {
  if (!input.found) {
    return evalOf("NOT_FOUND", "NOT_FOUND", "Finished lot not found.");
  }
  if (input.lotStatus === "RELEASED") {
    return evalOf("ALREADY_RELEASED", "ALREADY_RELEASED", "Lot is already released.");
  }
  if (input.lotStatus !== "PENDING_QC") {
    return evalOf(
      "BLOCKED",
      "NOT_PENDING_QC",
      `Lot status is ${input.lotStatus ?? "unknown"} — only Pending QC lots can be auto-released.`,
    );
  }
  // Hard blockers — never auto-release.
  if (input.lotNumberConflict) {
    return evalOf("BLOCKED", "LOT_NUMBER_CONFLICT", "Another lot shares this lot number — review before release.");
  }
  if (input.excludedFromOutput) {
    return evalOf("BLOCKED", "EXCLUDED_FROM_OUTPUT", "Source run is excluded from output.");
  }
  if (!input.workflowBagId) {
    return evalOf("NEEDS_QC_REVIEW", "MISSING_WORKFLOW_BAG", "Lot has no source workflow bag — release manually after review.");
  }
  if (!input.workflowFinalized) {
    return evalOf("BLOCKED", "WORKFLOW_NOT_FINALIZED", "Source workflow bag is not finalized.");
  }
  if (!input.productId) {
    return evalOf("BLOCKED", "MISSING_PRODUCT", "Lot has no product mapped.");
  }
  // QC signals — keep it Pending for a human.
  if (input.isOnHold) {
    return evalOf("NEEDS_QC_REVIEW", "ON_HOLD", "Source bag is on hold.");
  }
  if (input.reworkPending) {
    return evalOf("NEEDS_QC_REVIEW", "REWORK_PENDING", "Rework is pending on the source bag.");
  }
  if (input.hasCorrection) {
    return evalOf("NEEDS_QC_REVIEW", "HAS_CORRECTION", "A post-finalization correction exists — review before release.");
  }
  if (input.recoveryFlagged) {
    return evalOf("NEEDS_QC_REVIEW", "RECOVERY_FLAGGED", "Source bag has a recovery flag (e.g. wrong-route) — review before release.");
  }
  if (input.qcEventCount > 0) {
    return evalOf("NEEDS_QC_REVIEW", "QC_EVENT_PRESENT", "QC events exist for this lot — review before release.");
  }
  if (input.openAllocationOnSource) {
    return evalOf("NEEDS_QC_REVIEW", "OPEN_ALLOCATION_ON_SOURCE", "Source bag still has an open allocation session — resolve it first.");
  }
  // Data completeness.
  if (input.unitsPerDisplay == null || input.displaysPerCase == null || input.tabletsPerUnit == null) {
    return evalOf("NEEDS_QC_REVIEW", "INCOMPLETE_PRODUCT_SETUP", "Product setup is incomplete — fix it before release.");
  }
  if (input.unitsProduced == null || input.unitsProduced <= 0) {
    return evalOf("NEEDS_QC_REVIEW", "MISSING_OUTPUT_COUNTS", "Lot has no positive output count.");
  }
  if (!input.finishedLotNumber || input.finishedLotNumber.trim() === "") {
    return evalOf("NEEDS_QC_REVIEW", "MISSING_RECEIPT", "Lot has no receipt / lot number.");
  }

  return evalOf("AUTO_RELEASE_READY", "READY", "Clean Pending QC lot — safe to auto-release.");
}

export type FinishedLotReleaseCandidate = {
  finishedLotId: string;
  finishedLotNumber: string | null;
  productName: string | null;
  unitsProduced: number | null;
  evaluation: FinishedLotReleaseEvaluation;
};

/** Load + classify every PENDING_QC finished lot (bounded). Read-only. */
export async function listFinishedLotReleaseCandidates(
  cap = 300,
): Promise<FinishedLotReleaseCandidate[]> {
  const lots = await db
    .select({
      id: finishedLots.id,
      status: finishedLots.status,
      workflowBagId: finishedLots.workflowBagId,
      productId: finishedLots.productId,
      productName: products.name,
      unitsProduced: finishedLots.unitsProduced,
      finishedLotNumber: finishedLots.finishedLotNumber,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
      tabletsPerUnit: products.tabletsPerUnit,
      finalizedAt: workflowBags.finalizedAt,
      inventoryBagId: workflowBags.inventoryBagId,
      isOnHold: readBagState.isOnHold,
      reworkPending: readBagState.reworkPending,
      hasCorrection: readBagState.hasCorrection,
      excludedFromOutput: readBagState.excludedFromOutput,
      recoveryStatus: readBagState.recoveryStatus,
    })
    .from(finishedLots)
    .leftJoin(products, eq(products.id, finishedLots.productId))
    .leftJoin(workflowBags, eq(workflowBags.id, finishedLots.workflowBagId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, finishedLots.workflowBagId))
    .where(eq(finishedLots.status, "PENDING_QC"))
    .limit(cap);

  if (lots.length === 0) return [];

  const lotIds = lots.map((l) => l.id);
  const inventoryBagIds = lots
    .map((l) => l.inventoryBagId)
    .filter((id): id is string => id != null);
  const lotNumbers = lots
    .map((l) => l.finishedLotNumber)
    .filter((n): n is string => n != null && n.trim() !== "");

  const [qcEventRows, openAllocRows, conflictRows] = await Promise.all([
    db
      .select({ finishedLotId: finishedLotQcEvents.finishedLotId })
      .from(finishedLotQcEvents)
      .where(inArray(finishedLotQcEvents.finishedLotId, lotIds)),
    inventoryBagIds.length > 0
      ? db
          .select({ inventoryBagId: rawBagAllocationSessions.inventoryBagId })
          .from(rawBagAllocationSessions)
          .where(
            and(
              inArray(rawBagAllocationSessions.inventoryBagId, inventoryBagIds),
              eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
            ),
          )
      : Promise.resolve([] as Array<{ inventoryBagId: string }>),
    lotNumbers.length > 0
      ? db
          .select({ finishedLotNumber: finishedLots.finishedLotNumber, id: finishedLots.id })
          .from(finishedLots)
          .where(inArray(finishedLots.finishedLotNumber, lotNumbers))
      : Promise.resolve([] as Array<{ finishedLotNumber: string; id: string }>),
  ]);

  const qcByLot = new Map<string, number>();
  for (const r of qcEventRows) {
    qcByLot.set(r.finishedLotId, (qcByLot.get(r.finishedLotId) ?? 0) + 1);
  }
  const openByInventory = new Set(openAllocRows.map((r) => r.inventoryBagId));
  const lotNumberCounts = new Map<string, number>();
  for (const r of conflictRows) {
    lotNumberCounts.set(r.finishedLotNumber, (lotNumberCounts.get(r.finishedLotNumber) ?? 0) + 1);
  }

  return lots.map((l) => {
    const evaluation = classifyFinishedLotReleaseEligibility({
      found: true,
      lotStatus: l.status,
      workflowBagId: l.workflowBagId,
      workflowFinalized: l.finalizedAt != null,
      productId: l.productId,
      unitsPerDisplay: l.unitsPerDisplay,
      displaysPerCase: l.displaysPerCase,
      tabletsPerUnit: l.tabletsPerUnit,
      unitsProduced: l.unitsProduced,
      finishedLotNumber: l.finishedLotNumber,
      isOnHold: l.isOnHold ?? false,
      reworkPending: l.reworkPending ?? false,
      hasCorrection: l.hasCorrection ?? false,
      excludedFromOutput: l.excludedFromOutput ?? false,
      recoveryFlagged: l.recoveryStatus != null,
      qcEventCount: qcByLot.get(l.id) ?? 0,
      openAllocationOnSource:
        l.inventoryBagId != null && openByInventory.has(l.inventoryBagId),
      lotNumberConflict:
        (l.finishedLotNumber != null && (lotNumberCounts.get(l.finishedLotNumber) ?? 0) > 1),
    });
    return {
      finishedLotId: l.id,
      finishedLotNumber: l.finishedLotNumber,
      productName: l.productName,
      unitsProduced: l.unitsProduced,
      evaluation,
    };
  });
}

/** Single-lot eligibility (used by the batch action's in-flight re-check). */
export async function evaluateFinishedLotReleaseEligibility(
  finishedLotId: string,
): Promise<FinishedLotReleaseEvaluation> {
  const candidates = await listFinishedLotReleaseCandidatesByIds([finishedLotId]);
  return (
    candidates[0]?.evaluation ??
    // Not in the PENDING_QC set → resolve its terminal state directly.
    (await resolveNonPendingEvaluation(finishedLotId))
  );
}

async function resolveNonPendingEvaluation(
  finishedLotId: string,
): Promise<FinishedLotReleaseEvaluation> {
  const [row] = await db
    .select({ status: finishedLots.status })
    .from(finishedLots)
    .where(eq(finishedLots.id, finishedLotId))
    .limit(1);
  return classifyFinishedLotReleaseEligibility({
    found: row != null,
    lotStatus: row?.status ?? null,
    workflowBagId: null,
    workflowFinalized: false,
    productId: null,
    unitsPerDisplay: null,
    displaysPerCase: null,
    tabletsPerUnit: null,
    unitsProduced: null,
    finishedLotNumber: null,
    isOnHold: false,
    reworkPending: false,
    hasCorrection: false,
    excludedFromOutput: false,
    recoveryFlagged: false,
    qcEventCount: 0,
    openAllocationOnSource: false,
    lotNumberConflict: false,
  });
}

/** Load + classify a specific set of lot ids that are PENDING_QC. */
async function listFinishedLotReleaseCandidatesByIds(
  ids: string[],
): Promise<FinishedLotReleaseCandidate[]> {
  if (ids.length === 0) return [];
  const all = await listFinishedLotReleaseCandidates(1000);
  const set = new Set(ids);
  return all.filter((c) => set.has(c.finishedLotId));
}

export type FinishedLotReleaseSummary = {
  pendingQc: number;
  autoReleaseReady: number;
  needsReview: number;
  blocked: number;
  readyLotIds: string[];
  capped: boolean;
  topReasons: Array<{ code: FinishedLotReleaseCode; message: string; count: number }>;
};

/** READ-ONLY dry-run for the summary cards + batch preview. */
export async function summarizeFinishedLotReleaseBacklog(
  cap = 300,
): Promise<FinishedLotReleaseSummary> {
  const rows = await listFinishedLotReleaseCandidates(cap);
  let autoReleaseReady = 0;
  let needsReview = 0;
  let blocked = 0;
  const readyLotIds: string[] = [];
  const reasonCounts = new Map<string, { message: string; count: number }>();

  for (const r of rows) {
    if (r.evaluation.status === "AUTO_RELEASE_READY") {
      autoReleaseReady++;
      readyLotIds.push(r.finishedLotId);
      continue;
    }
    if (r.evaluation.status === "NEEDS_QC_REVIEW") needsReview++;
    else blocked++;
    const entry = reasonCounts.get(r.evaluation.code) ?? {
      message: r.evaluation.message,
      count: 0,
    };
    entry.count++;
    reasonCounts.set(r.evaluation.code, entry);
  }

  const topReasons = Array.from(reasonCounts.entries())
    .map(([code, v]) => ({ code: code as FinishedLotReleaseCode, message: v.message, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    pendingQc: rows.length,
    autoReleaseReady,
    needsReview,
    blocked,
    readyLotIds,
    capped: rows.length >= cap,
    topReasons,
  };
}

// Suppress unused-import lint for helpers reserved for future filters.
void isNotNull;
void isNull;
void ne;
void sql;
