// PO-CLOSEOUT-COMMAND-CENTER-1 — read-only loader that assembles one PO's
// closeout view by composing EXISTING services + pure classifiers. It never
// mutates. Heavy per-bag services (auto-issue backlog eval, rebase eligibility,
// release eligibility) are called only for the small subset of bags that reach
// those journey steps; most bags short-circuit earlier in classifyPoCloseoutRow.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { unstable_noStore as noStore } from "next/cache";
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
import { isProductionOutputPersistEnabled } from "@/lib/zoho/production-output-config";
import {
  classifyPoCloseoutRow,
  classifyPoCloseoutIndexBucket,
  derivePoOverallStatus,
  summarizeRowStatuses,
  type PoCloseoutRowInput,
  type PoCloseoutRowVerdict,
  type PoCloseoutZohoStatus,
  type PoCloseoutOverallStatus,
  type PoCloseoutIndexBucket,
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
    zohoReadyToQueue: number;
    zohoFailed: number;
  };
  /** True when production-output persistence is on (Zoho output is required). */
  zohoRequired: boolean;
  topBlockers: Array<{ reason: string; count: number }>;
  rows: PoCloseoutRow[];
  /** CLOSEOUT-FRESHNESS-1 — when this snapshot was computed from the live
   *  DB. Rendered as "Data as of …" so admins can see a refresh reloaded. */
  evaluatedAt: Date;
};

// PO-CLOSEOUT-ZOHO-DONE-1 — normalize a released lot's Zoho status. Exported for
// unit testing. `zohoRequired` is true when production-output persistence is
// enabled: then EVERY released lot is expected to have an op, so a MISSING op is
// "required but not queued yet" (READY_TO_QUEUE), NOT "not applicable". Only when
// persistence is disabled is a missing op genuinely NOT_APPLICABLE — with the
// explicit reason that the Zoho output feature is off.
export function normalizeZohoStatus(
  op: { status: string | null; committedAt: Date | null } | undefined,
  zohoRequired: boolean,
): PoCloseoutZohoStatus {
  if (!op) return zohoRequired ? "READY_TO_QUEUE" : "NOT_APPLICABLE";
  const s = (op.status ?? "").toUpperCase();
  if (op.committedAt != null || s === "COMMITTED") return "COMMITTED";
  if (s === "FAILED") return "FAILED";
  if (s === "QUEUED" || s === "COMMITTING") return "QUEUED";
  if (s === "READY" || s === "APPROVED") return "READY_TO_QUEUE";
  if (s === "DRAFT" || s === "PREVIEWED" || s === "NEEDS_MAPPING" || s === "HELD") {
    // Op exists but is not queue-ready (mid-preview, mapping-blocked, or held) —
    // the admin must resolve it in Zoho ops before it can be queued.
    return "NOT_READY";
  }
  return "UNCLEAR";
}

/** READ-ONLY. Build the full closeout view for one PO. */
export async function loadPoCloseout(poId: string): Promise<PoCloseoutSummary | null> {
  // CLOSEOUT-FRESHNESS-1 — operational closeout data must never be served
  // from any framework cache; every request recomputes from the live DB.
  noStore();
  const [po] = await db
    .select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, vendorName: purchaseOrders.vendorName })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  if (!po) return null;

  // When production-output persistence is enabled, every released lot is expected
  // to have a Zoho op — so a missing op is "required but not queued", not
  // "not applicable". When disabled, Zoho output is genuinely not required.
  const zohoRequired = isProductionOutputPersistEnabled();

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
        zohoCommitted: 0, zohoQueued: 0, zohoReadyToQueue: 0, zohoFailed: 0,
      },
      zohoRequired,
      topBlockers: [],
      rows: [],
      evaluatedAt: new Date(),
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
            recoveryStatus: readBagState.recoveryStatus,
          })
          .from(readBagState)
          .where(inArray(readBagState.workflowBagId, workflowBagIds))
      : Promise.resolve(
          [] as Array<{
            workflowBagId: string;
            excludedFromOutput: boolean | null;
            recoveryStatus: string | null;
          }>,
        ),
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
  const recoveryByWorkflow = new Map<string, string | null>();
  for (const s of stateRows) {
    excludedByWorkflow.set(s.workflowBagId, s.excludedFromOutput ?? false);
    recoveryByWorkflow.set(s.workflowBagId, s.recoveryStatus ?? null);
  }
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
    const zohoStatus = normalizeZohoStatus(lot ? zohoByLot.get(lot.id) : undefined, zohoRequired);
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
      recoveryStatus: wf ? (recoveryByWorkflow.get(wf.id) ?? null) : null,
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
      zohoReadyToQueue: rows.filter((r) => r.zoho === "READY_TO_QUEUE").length,
      zohoFailed: rows.filter((r) => r.zoho === "FAILED").length,
    },
    zohoRequired,
    topBlockers: [...blockerTally.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    rows,
    evaluatedAt: new Date(),
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

// ── BAG-PRODUCTION-SUMMARY-1 · index rollups (READ-ONLY, cheap SQL) ─────────

export type CloseoutPoIndexRow = {
  id: string;
  poNumber: string;
  vendorName: string | null;
  status: string;
  receiveCount: number;
  bagCount: number;
  doneBagCount: number;
  openBagCount: number;
  zohoBlockerCount: number;
  bucket: PoCloseoutIndexBucket;
};

/** READ-ONLY. One cheap aggregate per tablet PO for the Active/Closed index.
 *
 *  "Done bag" here is a CONSERVATIVE approximation of the full per-row
 *  command-center verdict (which is too heavy to run for every PO on the
 *  index): a bag counts as done only when every workflow/lot row attached to
 *  it is resolved — excluded-without-recovery, or a RELEASED/SHIPPED lot
 *  whose Zoho output is queued/committed (or Zoho output is disabled) — and
 *  it has no open allocation session. Anything else keeps the PO ACTIVE, so
 *  this can hide nothing that the detail page would surface. */
export async function listCloseoutPoIndexRollups(): Promise<CloseoutPoIndexRow[]> {
  // CLOSEOUT-FRESHNESS-1 — never cache the Active/Closed rollup.
  noStore();
  const zohoRequired = isProductionOutputPersistEnabled();
  type Row = {
    id: string;
    po_number: string;
    vendor_name: string | null;
    status: string;
    receive_count: number;
    bag_count: number;
    done_bag_count: number;
    zoho_blocker_count: number;
  };
  const rows = (await db.execute<Row>(sql`
    WITH bag_state AS (
      SELECT
        po.id AS po_id,
        ib.id AS bag_id,
        BOOL_AND(
          -- Every row for this bag must be resolved for the bag to be done.
          (rbs.excluded_from_output = true AND rbs.recovery_status IS NULL)
          OR (
            fl.status IN ('RELEASED', 'SHIPPED')
            AND (
              ${!zohoRequired}
              OR op.status IN ('QUEUED', 'COMMITTING', 'COMMITTED')
              OR op.committed_at IS NOT NULL
            )
          )
        ) AS bag_done,
        BOOL_OR(ras.allocation_status = 'OPEN') AS has_open_allocation
      FROM purchase_orders po
      JOIN receives r ON r.po_id = po.id
      JOIN small_boxes sb ON sb.receive_id = r.id
      JOIN inventory_bags ib ON ib.small_box_id = sb.id
      LEFT JOIN workflow_bags wb ON wb.inventory_bag_id = ib.id
      LEFT JOIN read_bag_state rbs ON rbs.workflow_bag_id = wb.id
      LEFT JOIN finished_lots fl ON fl.workflow_bag_id = wb.id
      LEFT JOIN zoho_production_output_ops op
        ON op.finished_lot_id = fl.id AND op.voided_at IS NULL
      LEFT JOIN raw_bag_allocation_sessions ras
        ON ras.inventory_bag_id = ib.id AND ras.allocation_status = 'OPEN'
      WHERE po.is_tablet_po = true
      GROUP BY po.id, ib.id
    ),
    zoho_blockers AS (
      SELECT po.id AS po_id, COUNT(DISTINCT op.id)::int AS blocker_count
      FROM purchase_orders po
      JOIN receives r ON r.po_id = po.id
      JOIN small_boxes sb ON sb.receive_id = r.id
      JOIN inventory_bags ib ON ib.small_box_id = sb.id
      JOIN workflow_bags wb ON wb.inventory_bag_id = ib.id
      JOIN finished_lots fl ON fl.workflow_bag_id = wb.id
      JOIN zoho_production_output_ops op
        ON op.finished_lot_id = fl.id AND op.voided_at IS NULL
      WHERE po.is_tablet_po = true
        AND op.status IN ('NEEDS_MAPPING', 'FAILED', 'DRAFT', 'PREVIEWED', 'HELD', 'NEEDS_REVIEW')
      GROUP BY po.id
    )
    SELECT
      po.id,
      po.po_number,
      po.vendor_name,
      po.status,
      (SELECT COUNT(*)::int FROM receives r WHERE r.po_id = po.id) AS receive_count,
      COALESCE((SELECT COUNT(*)::int FROM bag_state bs WHERE bs.po_id = po.id), 0) AS bag_count,
      COALESCE((
        SELECT COUNT(*)::int FROM bag_state bs
        WHERE bs.po_id = po.id AND bs.bag_done AND NOT COALESCE(bs.has_open_allocation, false)
      ), 0) AS done_bag_count,
      COALESCE((SELECT zb.blocker_count FROM zoho_blockers zb WHERE zb.po_id = po.id), 0) AS zoho_blocker_count
    FROM purchase_orders po
    WHERE po.is_tablet_po = true
    ORDER BY po.opened_at DESC
  `)) as unknown as Row[];

  return rows.map((r) => ({
    id: r.id,
    poNumber: r.po_number,
    vendorName: r.vendor_name,
    status: r.status,
    receiveCount: Number(r.receive_count ?? 0),
    bagCount: Number(r.bag_count ?? 0),
    doneBagCount: Number(r.done_bag_count ?? 0),
    openBagCount: Math.max(0, Number(r.bag_count ?? 0) - Number(r.done_bag_count ?? 0)),
    zohoBlockerCount: Number(r.zoho_blocker_count ?? 0),
    bucket: classifyPoCloseoutIndexBucket({
      poStatus: r.status,
      receivedBagCount: Number(r.bag_count ?? 0),
      doneBagCount: Number(r.done_bag_count ?? 0),
      zohoBlockerCount: Number(r.zoho_blocker_count ?? 0),
    }),
  }));
}
