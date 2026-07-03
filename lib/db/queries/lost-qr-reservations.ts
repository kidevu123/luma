// BATCH-LOST-QR-RESERVATION-REPAIR-1 — detector + guarded batch repair for
// receive/intake bags whose bag_qr_code points at a RAW_BAG card that drifted
// to IDLE (lost intake reservation). Read-only detector; batch repair reuses
// the exact same guard + single-row repair as v1.19.2, so it can never touch a
// card active in production, a retired/wrong-type card, a conflicting token, or
// a non-AVAILABLE bag. It never touches allocation sessions or workflow bags.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  inventoryBags,
  qrCards,
  smallBoxes,
  receives,
  workflowBags,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/db/audit";
import {
  canRepairQrReservation,
  repairQrReservation,
  type QrRepairActor,
} from "@/lib/db/queries/bag-edits";

export type LostQrReservationCandidate = {
  inventoryBagId: string;
  bagNumber: number | null;
  bagQrCode: string;
  bagStatus: string;
  internalReceiptNumber: string | null;
  receiveName: string | null;
  qrCardId: string;
  qrCardStatus: string;
  safe: boolean;
  reason: string;
};

export type LostQrReservationScan = {
  total: number;
  safeToRepair: number;
  unsafe: number;
  candidates: LostQrReservationCandidate[];
  reasonCounts: Array<{ reason: string; count: number }>;
};

/** READ-ONLY. Every inventory bag whose bag_qr_code points at an IDLE RAW_BAG
 *  card, classified safe/unsafe via the shared canRepairQrReservation guard. */
export async function listLostQrReservationCandidates(): Promise<LostQrReservationScan> {
  // Bags pointing at a RAW_BAG card that is IDLE + unassigned (the lost-
  // reservation shape). Join the card by scan_token = bag_qr_code.
  const rows = await db
    .select({
      inventoryBagId: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      bagStatus: inventoryBags.status,
      internalReceiptNumber: inventoryBags.internalReceiptNumber,
      receiveName: receives.receiveName,
      qrCardId: qrCards.id,
      qrCardType: qrCards.cardType,
      qrCardStatus: qrCards.status,
      qrAssignedWorkflowBagId: qrCards.assignedWorkflowBagId,
    })
    .from(inventoryBags)
    .innerJoin(qrCards, eq(qrCards.scanToken, inventoryBags.bagQrCode))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .where(
      and(
        eq(qrCards.cardType, "RAW_BAG"),
        eq(qrCards.status, "IDLE"),
        isNull(qrCards.assignedWorkflowBagId),
      ),
    );

  if (rows.length === 0) {
    return { total: 0, safeToRepair: 0, unsafe: 0, candidates: [], reasonCounts: [] };
  }

  // How many bags claim each token (a token claimed by >1 bag is a conflict).
  const tokens = [...new Set(rows.map((r) => r.bagQrCode).filter((t): t is string => t != null))];
  const claimRows = tokens.length
    ? await db
        .select({ token: inventoryBags.bagQrCode, count: sql<number>`count(*)::int` })
        .from(inventoryBags)
        .where(inArray(inventoryBags.bagQrCode, tokens))
        .groupBy(inventoryBags.bagQrCode)
    : [];
  const claimsByToken = new Map<string, number>();
  for (const c of claimRows) if (c.token) claimsByToken.set(c.token, c.count);

  const candidates: LostQrReservationCandidate[] = rows.map((r) => {
    const otherBagClaimsToken = (claimsByToken.get(r.bagQrCode ?? "") ?? 0) > 1;
    const guard = canRepairQrReservation({
      bagStatus: r.bagStatus,
      bagQrCode: r.bagQrCode,
      card: {
        cardType: r.qrCardType,
        status: r.qrCardStatus,
        assignedWorkflowBagId: r.qrAssignedWorkflowBagId,
      },
      otherBagClaimsToken,
    });
    return {
      inventoryBagId: r.inventoryBagId,
      bagNumber: r.bagNumber ?? null,
      bagQrCode: r.bagQrCode ?? "",
      bagStatus: r.bagStatus,
      internalReceiptNumber: r.internalReceiptNumber ?? null,
      receiveName: r.receiveName ?? null,
      qrCardId: r.qrCardId,
      qrCardStatus: r.qrCardStatus,
      safe: guard.ok,
      reason: guard.ok ? "SAFE_TO_REPAIR" : guard.reason,
    };
  });

  const safeToRepair = candidates.filter((c) => c.safe).length;
  const reasonCounts = Array.from(
    candidates.reduce((m, c) => m.set(c.reason, (m.get(c.reason) ?? 0) + 1), new Map<string, number>()),
  )
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: candidates.length,
    safeToRepair,
    unsafe: candidates.length - safeToRepair,
    candidates,
    reasonCounts,
  };
}

// ── QR production-desync classifier ─────────────────────────────────────────
// Separates the "bag points at an IDLE RAW_BAG card" population into actionable
// categories, so the IN_USE production-side rows are never confused with a safe
// intake lost reservation. Pure — fail closed to a review category.

export type QrIdlePointedCategory =
  /** AVAILABLE bag, safe to re-reserve as intake (v1.20.0 batch handles these). */
  | "SAFE_INTAKE_LOST_RESERVATION"
  /** AVAILABLE bag but a token conflict / other guard failure — manual review. */
  | "AVAILABLE_NEEDS_REVIEW"
  /** IN_USE bag whose workflow finalized: QR correctly released at finalize.
   *  Expected post-production history — NOT re-reservable. */
  | "IN_USE_FINALIZED_QR_RELEASED"
  /** IN_USE bag whose workflow is still ACTIVE but QR is idle — a real
   *  production-side desync. Manual review; do NOT intake-repair. */
  | "IN_USE_ACTIVE_QR_IDLE"
  /** IN_USE bag with no workflow at all — ambiguous, manual review. */
  | "IN_USE_NO_WORKFLOW"
  /** EMPTIED/DEPLETED bag: spent, QR released. No floor reservation needed. */
  | "DEPLETED_QR_RELEASED"
  /** Any other bag status — manual review. */
  | "OTHER_NEEDS_REVIEW";

export type QrIdlePointedClassifyInput = {
  bagStatus: string;
  hasWorkflow: boolean;
  workflowFinalized: boolean;
  intakeGuardOk: boolean;
};

export function classifyQrIdlePointedBag(
  input: QrIdlePointedClassifyInput,
): { category: QrIdlePointedCategory; label: string; actionable: boolean; note: string } {
  if (input.bagStatus === "AVAILABLE") {
    return input.intakeGuardOk
      ? { category: "SAFE_INTAKE_LOST_RESERVATION", label: "Lost intake reservation — re-reserve", actionable: true, note: "Re-reservable intake lost reservation." }
      : { category: "AVAILABLE_NEEDS_REVIEW", label: "Available — needs review", actionable: false, note: "Available but failed the intake guard (e.g. token conflict) — review." };
  }
  if (input.bagStatus === "EMPTIED" || input.bagStatus === "DEPLETED") {
    return { category: "DEPLETED_QR_RELEASED", label: "Depleted/emptied — finished history", actionable: false, note: "Bag spent; QR released. No floor reservation needed." };
  }
  if (input.bagStatus === "IN_USE") {
    if (!input.hasWorkflow) {
      return { category: "IN_USE_NO_WORKFLOW", label: "In use, no workflow — review", actionable: false, note: "IN_USE with no workflow — ambiguous; manual review." };
    }
    return input.workflowFinalized
      ? { category: "IN_USE_FINALIZED_QR_RELEASED", label: "Finalized — awaiting finished lot", actionable: false, note: "Workflow finalized; QR correctly released. Expected history — not re-reservable." }
      : { category: "IN_USE_ACTIVE_QR_IDLE", label: "Active production — QR desync (review)", actionable: false, note: "Active workflow but QR is idle — production-side desync; manual review, do NOT intake-repair." };
  }
  return { category: "OTHER_NEEDS_REVIEW", label: "Needs review", actionable: false, note: `Bag status ${input.bagStatus} — manual review.` };
}

export type QrProductionDesyncRow = {
  inventoryBagId: string;
  bagNumber: number | null;
  bagQrCode: string;
  bagStatus: string;
  receipt: string | null;
  receiveName: string | null;
  workflowBagId: string | null;
  workflowFinalized: boolean;
  category: QrIdlePointedCategory;
  label: string;
  actionable: boolean;
  note: string;
};

export type QrProductionDesyncReport = {
  total: number;
  byCategory: Array<{ category: QrIdlePointedCategory; count: number; actionable: boolean }>;
  rows: QrProductionDesyncRow[];
};

/** READ-ONLY. Classify every bag that points at an IDLE RAW_BAG card into
 *  intake vs production-side categories. */
export async function listQrProductionDesyncReport(): Promise<QrProductionDesyncReport> {
  const rows = await db
    .select({
      inventoryBagId: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      bagQrCode: inventoryBags.bagQrCode,
      bagStatus: inventoryBags.status,
      receipt: inventoryBags.internalReceiptNumber,
      receiveName: receives.receiveName,
      cardType: qrCards.cardType,
      cardStatus: qrCards.status,
      cardWorkflowId: qrCards.assignedWorkflowBagId,
      workflowBagId: workflowBags.id,
      finalizedAt: workflowBags.finalizedAt,
    })
    .from(inventoryBags)
    .innerJoin(qrCards, eq(qrCards.scanToken, inventoryBags.bagQrCode))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(workflowBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .where(
      and(
        eq(qrCards.cardType, "RAW_BAG"),
        eq(qrCards.status, "IDLE"),
        isNull(qrCards.assignedWorkflowBagId),
      ),
    );

  // Token-claim counts to feed the intake guard's conflict flag.
  const tokens = [...new Set(rows.map((r) => r.bagQrCode).filter((t): t is string => t != null))];
  const claimRows = tokens.length
    ? await db
        .select({ token: inventoryBags.bagQrCode, count: sql<number>`count(*)::int` })
        .from(inventoryBags)
        .where(inArray(inventoryBags.bagQrCode, tokens))
        .groupBy(inventoryBags.bagQrCode)
    : [];
  const claimsByToken = new Map<string, number>();
  for (const c of claimRows) if (c.token) claimsByToken.set(c.token, c.count);

  const classified: QrProductionDesyncRow[] = rows.map((r) => {
    const intakeGuard = canRepairQrReservation({
      bagStatus: r.bagStatus,
      bagQrCode: r.bagQrCode,
      card: { cardType: r.cardType, status: r.cardStatus, assignedWorkflowBagId: r.cardWorkflowId },
      otherBagClaimsToken: (claimsByToken.get(r.bagQrCode ?? "") ?? 0) > 1,
    });
    const c = classifyQrIdlePointedBag({
      bagStatus: r.bagStatus,
      hasWorkflow: r.workflowBagId != null,
      workflowFinalized: r.finalizedAt != null,
      intakeGuardOk: intakeGuard.ok,
    });
    return {
      inventoryBagId: r.inventoryBagId,
      bagNumber: r.bagNumber ?? null,
      bagQrCode: r.bagQrCode ?? "",
      bagStatus: r.bagStatus,
      receipt: r.receipt ?? null,
      receiveName: r.receiveName ?? null,
      workflowBagId: r.workflowBagId ?? null,
      workflowFinalized: r.finalizedAt != null,
      category: c.category,
      label: c.label,
      actionable: c.actionable,
      note: c.note,
    };
  });

  const byCategoryMap = new Map<QrIdlePointedCategory, { count: number; actionable: boolean }>();
  for (const row of classified) {
    const e = byCategoryMap.get(row.category) ?? { count: 0, actionable: row.actionable };
    e.count++;
    byCategoryMap.set(row.category, e);
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, v]) => ({ category, count: v.count, actionable: v.actionable }))
    .sort((a, b) => b.count - a.count);

  return { total: classified.length, byCategory, rows: classified };
}

export const BATCH_LOST_QR_RESERVATION_CAP = 100;

export type LostQrReservationBatchResult = {
  ok: true;
  candidatesScanned: number;
  repaired: number;
  skipped: number;
  capped: boolean;
  repairedTokens: string[];
  skippedReasons: Array<{ reason: string; count: number }>;
};

/** Guarded batch repair. Repairs only rows that pass canRepairQrReservation,
 *  re-checked inside each single-row repair transaction (idempotent + race-safe:
 *  each row conditionally flips IDLE→ASSIGNED only, writes a per-card
 *  qr_card.reservation_repaired audit). Then writes one batch audit. */
export async function repairLostQrReservationsBatch(
  actor: QrRepairActor,
  cap = BATCH_LOST_QR_RESERVATION_CAP,
): Promise<LostQrReservationBatchResult> {
  const scan = await listLostQrReservationCandidates();
  const safe = scan.candidates.filter((c) => c.safe).slice(0, cap);

  const repairedTokens: string[] = [];
  const skipped: Array<{ reason: string }> = [];

  for (const c of safe) {
    // repairQrReservation re-loads + re-guards + conditionally updates inside a
    // transaction, so a row that changed since the scan is skipped safely.
    const r = await repairQrReservation(c.inventoryBagId, actor);
    if (r.ok) repairedTokens.push(c.bagQrCode);
    else skipped.push({ reason: r.error });
  }

  const skippedReasons = Array.from(
    skipped.reduce((m, s) => m.set(s.reason, (m.get(s.reason) ?? 0) + 1), new Map<string, number>()),
  ).map(([reason, count]) => ({ reason, count }));

  await writeAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: "qr_card.reservation_repair_batch",
    targetType: "LostQrReservationBatch",
    targetId: "batch",
    after: {
      source: "BATCH_LOST_QR_RESERVATION_REPAIR",
      candidates_scanned: scan.total,
      safe_at_scan: scan.safeToRepair,
      repaired: repairedTokens.length,
      skipped: skipped.length,
      repaired_qr_tokens: repairedTokens,
      skipped_reasons: skippedReasons,
      note: "Restored lost intake reservations (IDLE→ASSIGNED). No workflow, allocation, finished-lot, or Zoho state touched.",
    },
  });

  return {
    ok: true,
    candidatesScanned: scan.total,
    repaired: repairedTokens.length,
    skipped: skipped.length,
    capped: scan.safeToRepair > cap,
    repairedTokens,
    skippedReasons,
  };
}
