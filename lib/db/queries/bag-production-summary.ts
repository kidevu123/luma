// BAG-PRODUCTION-SUMMARY-1 — READ-ONLY batch loader for per-bag production
// breakdowns. Composes canonical sources only: inventory bag counts,
// read_bag_state / read_bag_metrics (finalized output), stage outputs from
// workflow events (deepest FINISHED > PACKAGING > SEALING, same rule the
// partial-bag system derivation uses), non-voided allocation sessions,
// finished lots, and non-voided Zoho production output ops. Never mutates.

import { desc, eq, inArray, isNull, and } from "drizzle-orm";
import { unstable_noStore as noStore } from "next/cache";
import { db } from "@/lib/db";
import {
  batches,
  finishedLots,
  inventoryBags,
  products,
  purchaseOrders,
  rawBagAllocationSessions,
  readBagMetrics,
  readBagState,
  receives,
  smallBoxes,
  tabletTypes,
  workflowBags,
  zohoProductionOutputOps,
} from "@/lib/db/schema";
import { deriveStageOutputForBag } from "@/lib/production/output-reconciliation";
import { pickDeepestOutput } from "@/lib/production/system-derived-allocation";
import { normalizeZohoStatus } from "@/lib/db/queries/po-closeout";
import { isProductionOutputPersistEnabled } from "@/lib/zoho/production-output-config";
import {
  computeBagProductionSummary,
  type BagProductionSummary,
  type BagSummaryWorkflowInput,
  type BagSummaryZohoStatus,
} from "@/lib/production/bag-production-summary";

const MAX_BAGS = 200;

export type LoadBagProductionSummariesArgs = {
  inventoryBagIds?: string[];
  receiveId?: string;
  poId?: string;
  workflowBagIds?: string[];
};

async function resolveInventoryBagIds(
  args: LoadBagProductionSummariesArgs,
): Promise<string[]> {
  const ids = new Set<string>(args.inventoryBagIds ?? []);

  if (args.receiveId) {
    const rows = await db
      .select({ id: inventoryBags.id })
      .from(inventoryBags)
      .innerJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
      .where(eq(smallBoxes.receiveId, args.receiveId));
    for (const r of rows) ids.add(r.id);
  }

  if (args.poId) {
    const rows = await db
      .select({ id: inventoryBags.id })
      .from(inventoryBags)
      .innerJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
      .innerJoin(receives, eq(receives.id, smallBoxes.receiveId))
      .where(eq(receives.poId, args.poId));
    for (const r of rows) ids.add(r.id);
  }

  if (args.workflowBagIds && args.workflowBagIds.length > 0) {
    const rows = await db
      .select({ inventoryBagId: workflowBags.inventoryBagId })
      .from(workflowBags)
      .where(inArray(workflowBags.id, args.workflowBagIds));
    for (const r of rows) if (r.inventoryBagId) ids.add(r.inventoryBagId);
  }

  return [...ids].slice(0, MAX_BAGS);
}

/** READ-ONLY. Returns summaries keyed by inventory bag id. */
export async function loadBagProductionSummaries(
  args: LoadBagProductionSummariesArgs,
): Promise<Map<string, BagProductionSummary>> {
  // CLOSEOUT-FRESHNESS-1 — per-bag production numbers must always come
  // from the live DB, never a framework cache.
  noStore();
  const bagIds = await resolveInventoryBagIds(args);
  const out = new Map<string, BagProductionSummary>();
  if (bagIds.length === 0) return out;

  const zohoRequired = isProductionOutputPersistEnabled();

  // ── Bags + receive/PO/tablet/batch context ────────────────────────────
  const bagRows = await db
    .select({
      id: inventoryBags.id,
      bagNumber: inventoryBags.bagNumber,
      status: inventoryBags.status,
      pillCount: inventoryBags.pillCount,
      declaredPillCount: inventoryBags.declaredPillCount,
      receiptNumber: inventoryBags.internalReceiptNumber,
      qrToken: inventoryBags.bagQrCode,
      tabletName: tabletTypes.name,
      supplierLot: batches.batchNumber,
      receiveId: smallBoxes.receiveId,
      poId: receives.poId,
      poNumber: purchaseOrders.poNumber,
    })
    .from(inventoryBags)
    .leftJoin(tabletTypes, eq(tabletTypes.id, inventoryBags.tabletTypeId))
    .leftJoin(batches, eq(batches.id, inventoryBags.batchId))
    .leftJoin(smallBoxes, eq(smallBoxes.id, inventoryBags.smallBoxId))
    .leftJoin(receives, eq(receives.id, smallBoxes.receiveId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, receives.poId))
    .where(inArray(inventoryBags.id, bagIds));

  // ── Workflows (all runs per bag, oldest → newest) ─────────────────────
  const wfRows = await db
    .select({
      id: workflowBags.id,
      inventoryBagId: workflowBags.inventoryBagId,
      startedAt: workflowBags.startedAt,
      finalizedAt: workflowBags.finalizedAt,
      productId: workflowBags.productId,
      productName: products.name,
      productKind: products.kind,
      tabletsPerUnit: products.tabletsPerUnit,
      unitsPerDisplay: products.unitsPerDisplay,
      displaysPerCase: products.displaysPerCase,
      stage: readBagState.stage,
      isFinalized: readBagState.isFinalized,
      excludedFromOutput: readBagState.excludedFromOutput,
      recoveryStatus: readBagState.recoveryStatus,
      masterCases: readBagMetrics.masterCases,
      displaysMade: readBagMetrics.displaysMade,
      looseCards: readBagMetrics.looseCards,
      damagedPackaging: readBagMetrics.damagedPackaging,
      rippedCards: readBagMetrics.rippedCards,
      unitsYielded: readBagMetrics.unitsYielded,
    })
    .from(workflowBags)
    .leftJoin(products, eq(products.id, workflowBags.productId))
    .leftJoin(readBagState, eq(readBagState.workflowBagId, workflowBags.id))
    .leftJoin(readBagMetrics, eq(readBagMetrics.workflowBagId, workflowBags.id))
    .where(inArray(workflowBags.inventoryBagId, bagIds))
    .orderBy(workflowBags.startedAt);

  // Stage-output fallback only for workflows without a metrics snapshot.
  const workflowsByBag = new Map<string, BagSummaryWorkflowInput[]>();
  for (const wf of wfRows) {
    if (!wf.inventoryBagId) continue;
    let deepestOutput: BagSummaryWorkflowInput["deepestOutput"] = null;
    const hasMetrics = wf.unitsYielded != null;
    if (!hasMetrics) {
      const stageOutput = await deriveStageOutputForBag(wf.id);
      deepestOutput = pickDeepestOutput({
        finishedOutput: stageOutput.finishedOutput,
        packagedOutput: stageOutput.packagedOutput,
        sealedOutput: stageOutput.sealedOutput,
      });
    }
    const list = workflowsByBag.get(wf.inventoryBagId) ?? [];
    list.push({
      workflowBagId: wf.id,
      productId: wf.productId,
      productName: wf.productName,
      productKind: wf.productKind,
      tabletsPerUnit: wf.tabletsPerUnit,
      unitsPerDisplay: wf.unitsPerDisplay,
      displaysPerCase: wf.displaysPerCase,
      stage: wf.stage ?? null,
      isFinalized: Boolean(wf.isFinalized || wf.finalizedAt),
      finalizedAt: wf.finalizedAt,
      excludedFromOutput: Boolean(wf.excludedFromOutput),
      recoveryStatus: wf.recoveryStatus ?? null,
      metrics: hasMetrics
        ? {
            masterCases: wf.masterCases ?? 0,
            displaysMade: wf.displaysMade ?? 0,
            looseCards: wf.looseCards ?? 0,
            damagedPackaging: wf.damagedPackaging ?? 0,
            rippedCards: wf.rippedCards ?? 0,
            unitsYielded: wf.unitsYielded ?? 0,
          }
        : null,
      deepestOutput,
    });
    workflowsByBag.set(wf.inventoryBagId, list);
  }

  // ── Allocation sessions (non-voided) ──────────────────────────────────
  const sessionRows = await db
    .select({
      id: rawBagAllocationSessions.id,
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      status: rawBagAllocationSessions.allocationStatus,
      startingBalanceQty: rawBagAllocationSessions.startingBalanceQty,
      endingBalanceQty: rawBagAllocationSessions.endingBalanceQty,
      endingBalanceSource: rawBagAllocationSessions.endingBalanceSource,
      consumedQty: rawBagAllocationSessions.consumedQty,
      openedAt: rawBagAllocationSessions.openedAt,
    })
    .from(rawBagAllocationSessions)
    .where(inArray(rawBagAllocationSessions.inventoryBagId, bagIds));
  const sessionsByBag = new Map<string, typeof sessionRows>();
  for (const s of sessionRows) {
    if (s.status === "VOIDED") continue;
    const list = sessionsByBag.get(s.inventoryBagId) ?? [];
    list.push(s);
    sessionsByBag.set(s.inventoryBagId, list);
  }

  // ── Finished lots + Zoho ops ──────────────────────────────────────────
  const allWorkflowIds = wfRows.map((w) => w.id);
  const lotRows = allWorkflowIds.length
    ? await db
        .select({
          id: finishedLots.id,
          lotNumber: finishedLots.finishedLotNumber,
          status: finishedLots.status,
          workflowBagId: finishedLots.workflowBagId,
        })
        .from(finishedLots)
        .where(inArray(finishedLots.workflowBagId, allWorkflowIds))
    : [];
  const lotIds = lotRows.map((l) => l.id);
  const opRows = lotIds.length
    ? await db
        .select({
          id: zohoProductionOutputOps.id,
          finishedLotId: zohoProductionOutputOps.finishedLotId,
          status: zohoProductionOutputOps.status,
          committedAt: zohoProductionOutputOps.committedAt,
        })
        .from(zohoProductionOutputOps)
        .where(
          and(
            inArray(zohoProductionOutputOps.finishedLotId, lotIds),
            isNull(zohoProductionOutputOps.voidedAt),
          ),
        )
        .orderBy(desc(zohoProductionOutputOps.updatedAt))
    : [];
  const opByLot = new Map<string, (typeof opRows)[number]>();
  for (const op of opRows) {
    if (op.finishedLotId && !opByLot.has(op.finishedLotId)) {
      opByLot.set(op.finishedLotId, op);
    }
  }
  const wfToBag = new Map(
    wfRows.filter((w) => w.inventoryBagId).map((w) => [w.id, w.inventoryBagId as string]),
  );
  const lotsByBag = new Map<string, typeof lotRows>();
  for (const lot of lotRows) {
    const bagId = lot.workflowBagId ? wfToBag.get(lot.workflowBagId) : undefined;
    if (!bagId) continue;
    const list = lotsByBag.get(bagId) ?? [];
    list.push(lot);
    lotsByBag.set(bagId, list);
  }

  // ── Compose ───────────────────────────────────────────────────────────
  for (const bag of bagRows) {
    const lots = lotsByBag.get(bag.id) ?? [];
    const latestLot = lots[lots.length - 1] ?? null;
    let zoho: { opId: string | null; status: BagSummaryZohoStatus; reason: string | null } | null =
      null;
    if (latestLot) {
      const op = opByLot.get(latestLot.id);
      // NEEDS_MAPPING is surfaced distinctly (actionable copy) before the
      // generic v1.22.1 normalization.
      if (op && (op.status ?? "").toUpperCase() === "NEEDS_MAPPING") {
        zoho = { opId: op.id, status: "NEEDS_MAPPING", reason: "Zoho needs mapping" };
      } else {
        const normalized = normalizeZohoStatus(
          op ? { status: op.status, committedAt: op.committedAt } : undefined,
          zohoRequired,
        );
        const status: BagSummaryZohoStatus =
          normalized === "NOT_APPLICABLE"
            ? "NOT_REQUIRED"
            : normalized === "UNCLEAR"
              ? "NOT_READY"
              : normalized;
        zoho = { opId: op?.id ?? null, status, reason: null };
      }
    }

    out.set(
      bag.id,
      computeBagProductionSummary({
        inventoryBagId: bag.id,
        receiveId: bag.receiveId ?? null,
        receiptNumber: bag.receiptNumber,
        poId: bag.poId ?? null,
        poNumber: bag.poNumber ?? null,
        tabletName: bag.tabletName,
        supplierLot: bag.supplierLot,
        qrToken: bag.qrToken,
        bagStatus: bag.status,
        pillCount: bag.pillCount,
        declaredPillCount: bag.declaredPillCount,
        workflows: workflowsByBag.get(bag.id) ?? [],
        allocationSessions: (sessionsByBag.get(bag.id) ?? []).map((s) => ({
          sessionId: s.id,
          status: s.status,
          startingBalanceQty: s.startingBalanceQty,
          endingBalanceQty: s.endingBalanceQty,
          endingBalanceSource: s.endingBalanceSource,
          consumedQty: s.consumedQty,
          openedAt: s.openedAt,
        })),
        finishedLots: lots.map((l) => ({
          id: l.id,
          lotNumber: l.lotNumber,
          status: l.status,
          workflowBagId: l.workflowBagId,
        })),
        zoho,
      }),
    );
  }
  return out;
}

/** READ-ONLY. Summaries keyed by workflow bag id (for pages whose rows are
 *  workflow-centric, e.g. Production Output). */
export async function loadBagProductionSummariesByWorkflowBag(
  workflowBagIds: string[],
): Promise<Map<string, BagProductionSummary>> {
  if (workflowBagIds.length === 0) return new Map();
  const wfRows = await db
    .select({ id: workflowBags.id, inventoryBagId: workflowBags.inventoryBagId })
    .from(workflowBags)
    .where(inArray(workflowBags.id, workflowBagIds));
  const byBag = await loadBagProductionSummaries({
    inventoryBagIds: wfRows
      .map((w) => w.inventoryBagId)
      .filter((v): v is string => v != null),
  });
  const out = new Map<string, BagProductionSummary>();
  for (const wf of wfRows) {
    if (!wf.inventoryBagId) continue;
    const summary = byBag.get(wf.inventoryBagId);
    if (summary) out.set(wf.id, summary);
  }
  return out;
}
