// PO-CLOSEOUT-COMMAND-CENTER-1 — read-only loader that assembles one PO's
// closeout view by composing EXISTING services + pure classifiers. It never
// mutates. Heavy per-bag services (auto-issue backlog eval, rebase eligibility,
// release eligibility) are called only for the small subset of bags that reach
// those journey steps; most bags short-circuit earlier in classifyPoCloseoutRow.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  purchaseOrders,
  receives,
  smallBoxes,
  inventoryBags,
  tabletTypes,
  qrCards,
  workflowBags,
  finishedLots,
  readBagState,
  rawBagAllocationSessions,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import { evaluateInventoryBagReadiness } from "@/lib/production/floor-readiness";
import { canRepairQrReservation } from "@/lib/db/queries/bag-edits";
import { getProductionOutputBacklogRow } from "@/lib/db/queries/production-output-backlog";
import { evaluateFinishedLotReleaseEligibility } from "@/lib/production/finished-lot-release-eligibility";
import { computeOpenSessionRebaseEligibility } from "@/lib/production/open-session-rebase";
import {
  classifyPoCloseoutRow,
  derivePoOverallStatus,
  summarizeRowStatuses,
  type PoCloseoutRowInput,
  type PoCloseoutRowVerdict,
  type PoCloseoutZohoStatus,
  type PoCloseoutOverallStatus,
} from "@/lib/production/po-closeout";

export type PoCloseoutRow = PoCloseoutRowVerdict & {
  inventoryBagId: string;
  bagNumber: number | null;
  receiptNumber: string | null;
  tabletName: string | null;
  bagQrCode: string | null;
  bagStatus: string;
  receiveId: string | null;
  workflowBagId: string | null;
  finishedLotId: string | null;
  finishedLotNumber: string | null;
  lotStatus: string | null;
  zoho: PoCloseoutZohoStatus;
};

export type PoCloseoutSummary = {
  poId: string;
  poNumber: string;
  vendorName: string | null;
  overallStatus: PoCloseoutOverallStatus;
  counts: {
    total: number;
    done: number;
    readyForAction: number;
    needsReview: number;
    blocked: number;
    finalized: number;
    awaitingLot: number;
    lotsIssued: number;
    released: number;
    zohoCommitted: number;
    zohoQueued: number;
    zohoFailed: number;
  };
  topBlockers: Array<{ reason: string; count: number }>;
  rows: PoCloseoutRow[];
};

function normalizeZohoStatus(op: {
  status: string | null;
  committedAt: Date | null;
} | undefined): PoCloseoutZohoStatus {
  if (!op) return "NOT_APPLICABLE"; // Zoho output is separate/optional; no op yet.
  const s = (op.status ?? "").toUpperCase();
  if (op.committedAt != null || s === "COMMITTED") return "COMMITTED";
  if (s === "FAILED") return "FAILED";
  if (s === "QUEUED" || s === "COMMITTING") return "QUEUED";
  if (s === "READY") return "READY_TO_QUEUE";
  if (s === "DRAFT" || s === "PREVIEWED" || s === "APPROVED" || s === "NEEDS_MAPPING" || s === "HELD") {
    return "NOT_READY";
  }
  return "UNCLEAR";
}

/** READ-ONLY. Build the full closeout view for one PO. */
export async function loadPoCloseout(poId: string): Promise<PoCloseoutSummary | null> {
  const [po] = await db
    .select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, vendorName: purchaseOrders.vendorName })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) return null;

  // All inventory bags for this PO (chain: inventory_bags → small_boxes → receives).
  const bagRows = await db
    .select({
      inventoryBagId: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      receiptNumber: inventoryBags.internalReceiptNumber,
      bagQrCode: inventoryBags.bagQrCode,
      bagStatus: inventoryBags.status,
      tabletTypeId: inventoryBags.tabletTypeId,
      tabletName: tabletTypes.name,
      receiveId: receives.id,
      qrCardType: qrCards.cardType,
      qrCardStatus: qrCards.status,
      qrAssignedWorkflowBagId: qrCards.assignedWorkflowBagId,
      qrScanToken: qrCards.scanToken,
    })
    .from(inventoryBags)
    .innerJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .innerJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(qrCards, eq(qrCards.scanToken, inventoryBags.bagQrCode))
    .where(eq(receives.poId, poId));

  if (bagRows.length === 0) {
    return {
      poId: po.id,
      poNumber: po.poNumber,
      vendorName: po.vendorName ?? null,
      overallStatus: "DONE",
      counts: {
        total: 0, done: 0, readyForAction: 0, needsReview: 0, blocked: 0,
        finalized: 0, awaitingLot: 0, lotsIssued: 0, released: 0,
        zohoCommitted: 0, zohoQueued: 0, zohoFailed: 0,
      },
      topBlockers: [],
      rows: [],
    };
  }

  const inventoryBagIds = bagRows.map((b) => b.inventoryBagId);

  // Batched context loads.
  const [wfRows, tokenClaimRows] = await Promise.all([
    db
      .select({
        id: workflowBags.id,
        inventoryBagId: workflowBags.inventoryBagId,
        finalizedAt: workflowBags.finalizedAt,
        productId: workflowBags.productId,
        startedAt: workflowBags.startedAt,
      })
      .from(workflowBags)
      .where(inArray(workflowBags.inventoryBagId, inventoryBagIds)),
    db
      .select({ token: inventoryBags.bagQrCode })
      .from(inventoryBags)
      .where(
        inArray(
          inventoryBags.bagQrCode,
          bagRows.map((b) => b.bagQrCode).filter((t): t is string => !!t),
        ),
      ),
  ]);

  // Latest workflow bag per inventory bag (reuse handles 1:many via latest start).
  const wfByInventory = new Map<string, (typeof wfRows)[number]>();
  for (const w of wfRows) {
    if (!w.inventoryBagId) continue;
    const prev = wfByInventory.get(w.inventoryBagId);
    if (!prev || (w.startedAt?.getTime() ?? 0) >= (prev.startedAt?.getTime() ?? 0)) {
      wfByInventory.set(w.inventoryBagId, w);
    }
  }
  const workflowBagIds = [...wfByInventory.values()].map((w) => w.id);

  const tokenClaimCounts = new Map<string, number>();
  for (const r of tokenClaimRows) if (r.token) tokenClaimCounts.set(r.token, (tokenClaimCounts.get(r.token) ?? 0) + 1);

  const [lotRows, stateRows, openAllocRows] = await Promise.all([
    workflowBagIds.length
      ? db
          .select({
            id: finishedLots.id,
            finishedLotNumber: finishedLots.finishedLotNumber,
            status: finishedLots.status,
            workflowBagId: finishedLots.workflowBagId,
          })
          .from(finishedLots)
          .where(inArray(finishedLots.workflowBagId, workflowBagIds))
      : Promise.resolve([] as Array<{ id: string; finishedLotNumber: string | null; status: string; workflowBagId: string | null }>),
    workflowBagIds.length
      ? db
          .select({
            workflowBagId: readBagState.workflowBagId,
            excludedFromOutput: readBagState.excludedFromOutput,
          })
          .from(readBagState)
          .where(inArray(readBagState.workflowBagId, workflowBagIds))
      : Promise.resolve([] as Array<{ workflowBagId: string; excludedFromOutput: boolean | null }>),
    db
      .select({ inventoryBagId: rawBagAllocationSessions.inventoryBagId })
      .from(rawBagAllocationSessions)
      .where(
        and(
          inArray(rawBagAllocationSessions.inventoryBagId, inventoryBagIds),
          eq(rawBagAllocationSessions.allocationStatus, "OPEN"),
        ),
      ),
  ]);

  const lotByWorkflow = new Map<string, (typeof lotRows)[number]>();
  for (const l of lotRows) if (l.workflowBagId) lotByWorkflow.set(l.workflowBagId, l);
  const excludedByWorkflow = new Map<string, boolean>();
  for (const s of stateRows) excludedByWorkflow.set(s.workflowBagId, s.excludedFromOutput ?? false);
  const hasOpenAlloc = new Set(openAllocRows.map((r) => r.inventoryBagId));

  const lotIds = lotRows.map((l) => l.id);
  const zohoRows = lotIds.length
    ? await db
        .select({
          finishedLotId: zohoProductionOutputOps.finishedLotId,
          status: zohoProductionOutputOps.status,
          committedAt: zohoProductionOutputOps.committedAt,
        })
        .from(zohoProductionOutputOps)
        .where(and(inArray(zohoProductionOutputOps.finishedLotId, lotIds), isNull(zohoProductionOutputOps.voidedAt)))
    : [];
  const zohoByLot = new Map<string, (typeof zohoRows)[number]>();
  for (const z of zohoRows) if (z.finishedLotId) zohoByLot.set(z.finishedLotId, z);

  // Compose each row (fail closed per row — never throw the whole page).
  const rows: PoCloseoutRow[] = [];
  for (const b of bagRows) {
    const wf = wfByInventory.get(b.inventoryBagId);
    const lot = wf ? lotByWorkflow.get(wf.id) : undefined;
    const zohoStatus = normalizeZohoStatus(lot ? zohoByLot.get(lot.id) : undefined);
    const excludedFromOutput = wf ? (excludedByWorkflow.get(wf.id) ?? false) : false;

    // Floor-readiness codes (pure — reuse the classifier with loaded data).
    const qrCard =
      b.qrScanToken != null
        ? {
            cardType: b.qrCardType ?? "UNKNOWN",
            status: b.qrCardStatus ?? "IDLE",
            assignedWorkflowBagId: b.qrAssignedWorkflowBagId,
            scanToken: b.qrScanToken,
          }
        : null;
    let floorReadinessCodes: string[] = [];
    try {
      floorReadinessCodes = evaluateInventoryBagReadiness({
        internalReceiptNumber: b.receiptNumber,
        tabletTypeId: b.tabletTypeId,
        bagQrCode: b.bagQrCode,
        hasReceiveContext: b.receiveId != null,
        receivePoId: poId,
        qrCard,
        bagStatus: b.bagStatus,
      }).codes;
    } catch {
      floorReadinessCodes = [];
    }

    // QR intake repair safety (pure guard).
    const qrRepairSafe =
      b.bagStatus === "AVAILABLE" &&
      canRepairQrReservation({
        bagStatus: b.bagStatus,
        bagQrCode: b.bagQrCode,
        card: qrCard ? { cardType: qrCard.cardType, status: qrCard.status, assignedWorkflowBagId: qrCard.assignedWorkflowBagId ?? null } : null,
        otherBagClaimsToken: (tokenClaimCounts.get(b.bagQrCode ?? "") ?? 0) > 1,
      }).ok;
    const qrIdleUnsafe =
      !qrRepairSafe &&
      b.bagStatus === "AVAILABLE" &&
      qrCard?.cardType === "RAW_BAG" &&
      qrCard.status === "IDLE" &&
      (qrCard.assignedWorkflowBagId ?? null) === null;

    const hasWorkflow = !!wf;
    const workflowFinalized = !!wf?.finalizedAt;
    const hasFinishedLot = !!lot;
    const lotStatus = lot?.status ?? null;

    // Heavy per-bag reuse — only when the row reaches that journey step.
    let autoIssue: PoCloseoutRowInput["autoIssue"] = null;
    let rebaseAvailable = false;
    if (hasWorkflow && workflowFinalized && !hasFinishedLot && !excludedFromOutput && wf) {
      try {
        const backlog = await getProductionOutputBacklogRow(wf.id);
        if (backlog) {
          autoIssue = {
            autoIssuable: backlog.evaluation.autoIssuable,
            action: backlog.evaluation.action,
            label: backlog.evaluation.label,
            nextStep: backlog.evaluation.nextStep,
          };
          if (backlog.evaluation.action === "REPAIR_ALLOCATION" && hasOpenAlloc.has(b.inventoryBagId)) {
            rebaseAvailable = (await computeOpenSessionRebaseEligibility(b.inventoryBagId)).available;
          }
        }
      } catch {
        autoIssue = null; // fail closed → row becomes NEEDS_REVIEW
      }
    }

    let releaseStatus: PoCloseoutRowInput["releaseStatus"] = null;
    let releaseMessage: string | null = null;
    if (lot && lotStatus === "PENDING_QC") {
      try {
        const ev = await evaluateFinishedLotReleaseEligibility(lot.id);
        releaseStatus = ev.status;
        releaseMessage = ev.message;
      } catch {
        releaseStatus = null;
      }
    }

    const input: PoCloseoutRowInput = {
      inventoryBagId: b.inventoryBagId,
      bagNumber: b.bagNumber ?? null,
      receiptNumber: b.receiptNumber,
      tabletName: b.tabletName ?? null,
      bagQrCode: b.bagQrCode,
      workflowBagId: wf?.id ?? null,
      finishedLotId: lot?.id ?? null,
      finishedLotNumber: lot?.finishedLotNumber ?? null,
      receiveId: b.receiveId,
      bagStatus: b.bagStatus,
      hasReceiveContext: b.receiveId != null,
      tabletTypeId: b.tabletTypeId,
      hasWorkflow,
      workflowFinalized,
      excludedFromOutput,
      hasFinishedLot,
      lotStatus,
      floorReadinessCodes,
      qrRepairSafe,
      qrIdleUnsafe: !!qrIdleUnsafe,
      autoIssue,
      rebaseAvailable,
      releaseStatus,
      releaseMessage,
      zoho: zohoStatus,
    };

    const verdict = classifyPoCloseoutRow(input);
    rows.push({
      ...verdict,
      inventoryBagId: b.inventoryBagId,
      bagNumber: b.bagNumber ?? null,
      receiptNumber: b.receiptNumber,
      tabletName: b.tabletName ?? null,
      bagQrCode: b.bagQrCode,
      bagStatus: b.bagStatus,
      receiveId: b.receiveId,
      workflowBagId: wf?.id ?? null,
      finishedLotId: lot?.id ?? null,
      finishedLotNumber: lot?.finishedLotNumber ?? null,
      lotStatus,
      zoho: zohoStatus,
    });
  }

  const statusCounts = summarizeRowStatuses(rows.map((r) => r.status));
  const blockerTally = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "BLOCKED" || r.status === "NEEDS_REVIEW") {
      blockerTally.set(r.reason, (blockerTally.get(r.reason) ?? 0) + 1);
    }
  }

  return {
    poId: po.id,
    poNumber: po.poNumber,
    vendorName: po.vendorName ?? null,
    overallStatus: derivePoOverallStatus(rows.map((r) => r.status)),
    counts: {
      ...statusCounts,
      finalized: rows.filter((r) => r.checklist.floorFinalizedOrExcluded).length,
      awaitingLot: rows.filter((r) => r.workflowBagId && !r.finishedLotId && r.checklist.floorFinalizedOrExcluded).length,
      lotsIssued: rows.filter((r) => r.finishedLotId).length,
      released: rows.filter((r) => r.lotStatus === "RELEASED").length,
      zohoCommitted: rows.filter((r) => r.zoho === "COMMITTED").length,
      zohoQueued: rows.filter((r) => r.zoho === "QUEUED").length,
      zohoFailed: rows.filter((r) => r.zoho === "FAILED").length,
    },
    topBlockers: [...blockerTally.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    rows,
  };
}

/** READ-ONLY. Tablet POs for the picker (reuses the reconciliation list shape). */
export async function listCloseoutPoOptions(): Promise<
  Array<{ id: string; poNumber: string; vendorName: string | null; status: string }>
> {
  return db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      vendorName: purchaseOrders.vendorName,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.isTabletPo, true))
    .orderBy(desc(purchaseOrders.openedAt));
}
