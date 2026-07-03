// BATCH-LOST-QR-RESERVATION-REPAIR-1 — detector + guarded batch repair for
// receive/intake bags whose bag_qr_code points at a RAW_BAG card that drifted
// to IDLE (lost intake reservation). Read-only detector; batch repair reuses
// the exact same guard + single-row repair as v1.19.2, so it can never touch a
// card active in production, a retired/wrong-type card, a conflicting token, or
// a non-AVAILABLE bag. It never touches allocation sessions or workflow bags.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inventoryBags, qrCards, smallBoxes, receives } from "@/lib/db/schema";
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
