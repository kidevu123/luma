// ZOHO-PRODUCTION-OUTPUT-V1206 — build + persist source allocations and component_batches.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  batches,
  inventoryBags,
  poLines,
  rawBagAllocationSessions,
  tabletTypes,
  varietyRuns,
  zohoProductionOutputSourceAllocations,
} from "@/lib/db/schema";
import { fetchAllocationLedgerRows } from "@/lib/zoho/assembly-planner";
import {
  resolveZohoComponentBatch,
  type BatchResolutionStatus,
} from "@/lib/zoho/component-batch-resolution";
import {
  resolveProductFamily,
  validateProductFamilyConsistency,
  type ProductFamilyCode,
} from "@/lib/zoho/product-family";
import {
  deriveComponentBatchOutQuantity,
  validateComponentBatchOutQuantity,
} from "@/lib/zoho/component-batch-quantity";

export type ComponentBatchPayloadEntry = {
  item_id: string;
  source_bag_id: string;
  human_lot_number: string;
  batches: Array<{
    batch_id: string;
    out_quantity: number;
  }>;
};

export type SourceAllocationRow = {
  zohoComponentItemId: string;
  lumaInventoryBagId: string;
  humanLotNumber: string;
  componentRole: string | null;
  quantityAllocated: number;
  allocationSessionId: string | null;
  workflowBagId: string | null;
  varietyRunId: string | null;
  parentScanToken: string | null;
  manufactureDate: string | null;
  expiryDate: string | null;
  zohoBatchId: string | null;
  batchResolutionStatus: BatchResolutionStatus;
  outQuantity: number | null;
};

export type BuildSourceAllocationsResult =
  | {
      ok: true;
      rows: SourceAllocationRow[];
      componentBatches: ComponentBatchPayloadEntry[];
      productFamily: ProductFamilyCode;
    }
  | {
      ok: false;
      blockers: Array<{ code: string; message: string }>;
    };

type LedgerContext = {
  finishedLotId: string;
  workflowBagId: string | null;
  outputProductFamily: ProductFamilyCode;
  outputPoLineItemId: string | null;
  unitsPerFinishedUnit: number;
};

async function loadBagBatchMeta(bagIds: string[]) {
  if (bagIds.length === 0) {
    return new Map<
      string,
      {
        humanLotNumber: string;
        manufactureDate: string | null;
        expiryDate: string | null;
        tabletZohoItemId: string | null;
        tabletName: string | null;
        sourceTabletFamily: ProductFamilyCode;
      }
    >();
  }

  const rows = await db
    .select({
      bagId: inventoryBags.id,
      batchNumber: batches.batchNumber,
      vendorLotNumber: batches.vendorLotNumber,
      manufacturedAt: batches.manufacturedAt,
      expiryDate: batches.expiryDate,
      tabletZohoItemId: tabletTypes.zohoItemId,
      tabletName: tabletTypes.name,
      tabletFamily: tabletTypes.productFamily,
    })
    .from(inventoryBags)
    .innerJoin(batches, eq(inventoryBags.batchId, batches.id))
    .innerJoin(tabletTypes, eq(inventoryBags.tabletTypeId, tabletTypes.id))
    .where(inArray(inventoryBags.id, bagIds));

  const map = new Map<
    string,
    {
      humanLotNumber: string;
      manufactureDate: string | null;
      expiryDate: string | null;
      tabletZohoItemId: string | null;
      tabletName: string | null;
      sourceTabletFamily: ProductFamilyCode;
    }
  >();

  for (const row of rows) {
    const humanLot =
      row.vendorLotNumber?.trim() ||
      row.batchNumber?.trim() ||
      "";
    map.set(row.bagId, {
      humanLotNumber: humanLot,
      manufactureDate: row.manufacturedAt
        ? String(row.manufacturedAt).slice(0, 10)
        : null,
      expiryDate: row.expiryDate ? String(row.expiryDate).slice(0, 10) : null,
      tabletZohoItemId: row.tabletZohoItemId,
      tabletName: row.tabletName,
      sourceTabletFamily: resolveProductFamily({
        persistedFamily: row.tabletFamily,
        name: row.tabletName ?? "",
      }),
    });
  }
  return map;
}

async function loadSessionMeta(finishedLotId: string, bagIds: string[]) {
  if (bagIds.length === 0) {
    return new Map<
      string,
      {
        sessionId: string;
        componentRole: string | null;
        workflowBagId: string | null;
        varietyRunId: string | null;
        parentScanToken: string | null;
      }
    >();
  }

  const sessions = await db
    .select({
      id: rawBagAllocationSessions.id,
      inventoryBagId: rawBagAllocationSessions.inventoryBagId,
      componentRole: rawBagAllocationSessions.componentRole,
      workflowBagId: rawBagAllocationSessions.workflowBagId,
      varietyRunId: rawBagAllocationSessions.varietyRunId,
    })
    .from(rawBagAllocationSessions)
    .where(
      and(
        eq(rawBagAllocationSessions.finishedLotId, finishedLotId),
        inArray(rawBagAllocationSessions.inventoryBagId, bagIds),
        inArray(rawBagAllocationSessions.allocationStatus, [
          "CLOSED",
          "DEPLETED",
        ]),
      ),
    );

  const varietyRunIds = [
    ...new Set(
      sessions
        .map((s) => s.varietyRunId)
        .filter((id): id is string => id != null),
    ),
  ];
  const tokenByRun = new Map<string, string | null>();
  if (varietyRunIds.length > 0) {
    const runs = await db
      .select({
        id: varietyRuns.id,
        parentScanToken: varietyRuns.parentScanToken,
      })
      .from(varietyRuns)
      .where(inArray(varietyRuns.id, varietyRunIds));
    for (const run of runs) {
      tokenByRun.set(run.id, run.parentScanToken);
    }
  }

  const map = new Map<
    string,
    {
      sessionId: string;
      componentRole: string | null;
      workflowBagId: string | null;
      varietyRunId: string | null;
      parentScanToken: string | null;
    }
  >();
  for (const s of sessions) {
    map.set(s.inventoryBagId, {
      sessionId: s.id,
      componentRole: s.componentRole,
      workflowBagId: s.workflowBagId,
      varietyRunId: s.varietyRunId,
      parentScanToken: s.varietyRunId
        ? (tokenByRun.get(s.varietyRunId) ?? null)
        : null,
    });
  }
  return map;
}

/** Build source allocation rows + component_batches from closed allocation ledger. */
export async function buildSourceAllocationsForFinishedLot(
  ctx: LedgerContext,
  opts?: {
    resolveBatches?: boolean;
    operatorBatchSelections?: Record<string, string>;
    fetchImpl?: typeof fetch;
    /** Zoho-normalized BOM raw-component quantity per finished unit, keyed by Zoho item ID. */
    normalizedBomQuantities?: Record<string, number>;
    /** When set, batch resolve runs only for these Zoho item IDs. Empty set skips all. */
    batchTrackedItemIds?: Set<string>;
  },
): Promise<BuildSourceAllocationsResult> {
  const blockers: Array<{ code: string; message: string }> = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  const ledger = await fetchAllocationLedgerRows(
    ctx.finishedLotId,
    ctx.workflowBagId,
  );
  if (ledger.length === 0) {
    add(
      "MISSING_ALLOCATION_LEDGER",
      "No closed allocation sessions exist for this finished lot.",
    );
    return { ok: false, blockers };
  }

  if (ctx.outputPoLineItemId) {
    const poFamily = await loadPoLineFamily(ctx.outputPoLineItemId);
    const poCheck = validateProductFamilyConsistency({
      outputProductFamily: ctx.outputProductFamily,
      poLineProductFamily: poFamily,
      outputCompositeItemId: null,
      poLineZohoItemId: ctx.outputPoLineItemId,
    });
    if (!poCheck.ok) {
      add(poCheck.code, poCheck.message);
    }
  }

  const bagIds = [...new Set(ledger.map((r) => r.inventoryBagId))];
  const [bagMeta, sessionMeta] = await Promise.all([
    loadBagBatchMeta(bagIds),
    loadSessionMeta(ctx.finishedLotId, bagIds),
  ]);

  const rows: SourceAllocationRow[] = [];
  const componentBatches: ComponentBatchPayloadEntry[] = [];

  for (const entry of ledger) {
    const qty = entry.consumedQty ?? 0;
    if (qty <= 0) continue;

    const meta = bagMeta.get(entry.inventoryBagId);
    if (!meta?.humanLotNumber) {
      add(
        "MISSING_HUMAN_LOT_NUMBER",
        `Source bag ${entry.inventoryBagId} is missing batch lot number.`,
      );
      continue;
    }
    if (!entry.tabletZohoItemId) {
      add(
        "MISSING_COMPONENT_ITEM_ID",
        `Tablet type ${entry.tabletName ?? entry.inventoryBagId} is missing Zoho item ID.`,
      );
      continue;
    }

    const session = sessionMeta.get(entry.inventoryBagId);
    let batchResolutionStatus: BatchResolutionStatus = "UNRESOLVED";
    let zohoBatchId: string | null = null;

    const shouldResolveBatch =
      opts?.batchTrackedItemIds != null
        ? opts.batchTrackedItemIds.has(entry.tabletZohoItemId)
        : opts?.resolveBatches === true;

    if (shouldResolveBatch) {
      const operatorPick =
        opts?.operatorBatchSelections?.[
          `${entry.tabletZohoItemId}:${meta.humanLotNumber}`
        ];
      if (operatorPick) {
        batchResolutionStatus = "OPERATOR_SELECTED";
        zohoBatchId = operatorPick;
      } else {
        const lookup = await resolveZohoComponentBatch({
          itemId: entry.tabletZohoItemId,
          humanLotNumber: meta.humanLotNumber,
          ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        if (!lookup.ok) {
          add("BATCH_LOOKUP_FAILED", lookup.message);
        } else if (lookup.result.status === "UNIQUE") {
          batchResolutionStatus = "UNIQUE";
          zohoBatchId = lookup.result.batchId;
        } else if (lookup.result.status === "MISSING") {
          batchResolutionStatus = "MISSING";
          add(
            "ZOHO_BATCH_MISSING",
            `No Zoho batch found for ${entry.tabletName} lot ${meta.humanLotNumber}.`,
          );
        } else if (lookup.result.status === "AMBIGUOUS") {
          batchResolutionStatus = "AMBIGUOUS";
          add(
            "ZOHO_BATCH_AMBIGUOUS",
            `Multiple Zoho batches match ${entry.tabletName} lot ${meta.humanLotNumber}. Operator selection required.`,
          );
        }
      }
    } else {
      batchResolutionStatus = "NOT_BATCH_TRACKED";
    }

    const unitAssemblyQuantity = ctx.unitsPerFinishedUnit;
    const bomQuantityPerUnit =
      entry.tabletZohoItemId != null
        ? opts?.normalizedBomQuantities?.[entry.tabletZohoItemId]
        : undefined;

    let outQty: number;
    if (bomQuantityPerUnit != null && bomQuantityPerUnit > 0) {
      outQty = deriveComponentBatchOutQuantity(bomQuantityPerUnit, unitAssemblyQuantity);
      const ledgerQty = Math.round(qty);
      const bomCheck = validateComponentBatchOutQuantity({
        outQuantity: ledgerQty,
        bomQuantityPerUnit,
        unitAssemblyQuantity,
      });
      if (!bomCheck.ok) {
        add(bomCheck.code, bomCheck.message);
      }
    } else {
      add(
        "BOM_QUANTITY_PENDING",
        `Normalized BOM quantity is required for component ${entry.tabletName ?? entry.tabletZohoItemId} before production-output preview/commit.`,
      );
      outQty = Math.round(qty);
    }

    rows.push({
      zohoComponentItemId: entry.tabletZohoItemId,
      lumaInventoryBagId: entry.inventoryBagId,
      humanLotNumber: meta.humanLotNumber,
      componentRole: session?.componentRole ?? entry.componentRole,
      quantityAllocated: qty,
      allocationSessionId: session?.sessionId ?? null,
      workflowBagId: session?.workflowBagId ?? ctx.workflowBagId,
      varietyRunId: session?.varietyRunId ?? null,
      parentScanToken: session?.parentScanToken ?? null,
      manufactureDate: meta.manufactureDate,
      expiryDate: meta.expiryDate,
      zohoBatchId,
      batchResolutionStatus,
      outQuantity: outQty,
    });

    if (zohoBatchId) {
      componentBatches.push({
        item_id: entry.tabletZohoItemId,
        source_bag_id: entry.inventoryBagId,
        human_lot_number: meta.humanLotNumber,
        batches: [{ batch_id: zohoBatchId, out_quantity: outQty }],
      });
    }
  }

  if (rows.length === 0) {
    add(
      "MISSING_SOURCE_ALLOCATIONS",
      "Allocation sessions exist but no positive consumed quantity was recorded.",
    );
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  return {
    ok: true,
    rows,
    componentBatches,
    productFamily: ctx.outputProductFamily,
  };
}

export async function persistSourceAllocationsForOp(
  opId: string,
  rows: SourceAllocationRow[],
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<void> {
  await tx
    .delete(zohoProductionOutputSourceAllocations)
    .where(eq(zohoProductionOutputSourceAllocations.zohoProductionOutputOpId, opId));

  if (rows.length === 0) return;

  await tx.insert(zohoProductionOutputSourceAllocations).values(
    rows.map((row) => ({
      zohoProductionOutputOpId: opId,
      zohoComponentItemId: row.zohoComponentItemId,
      lumaInventoryBagId: row.lumaInventoryBagId,
      humanLotNumber: row.humanLotNumber,
      componentRole: row.componentRole,
      quantityAllocated: String(row.quantityAllocated),
      allocationSessionId: row.allocationSessionId,
      workflowBagId: row.workflowBagId,
      varietyRunId: row.varietyRunId,
      parentScanToken: row.parentScanToken,
      manufactureDate: row.manufactureDate,
      expiryDate: row.expiryDate,
      zohoBatchId: row.zohoBatchId,
      batchResolutionStatus: row.batchResolutionStatus,
      outQuantity: row.outQuantity,
    })),
  );
}

export function parseZohoCommitResponseIds(body: unknown): {
  receiveId: string | null;
  bundleIds: string[];
  partialFailure: boolean;
  humanReviewRequired: boolean;
} {
  const dig = (obj: unknown, ...keys: string[]): unknown => {
    let cur: unknown = obj;
    for (const k of keys) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  };

  const receiveId =
    dig(body, "receive_id") ??
    dig(body, "results", "receive", "receive_id") ??
    dig(body, "steps", "receive", "receive_id");

  const bundleRaw =
    dig(body, "bundle_id") ??
    dig(body, "bundle_ids") ??
    dig(body, "results", "unit_assembly", "bundle_id");

  const bundleIds: string[] = [];
  if (typeof bundleRaw === "string" && bundleRaw.trim()) {
    bundleIds.push(bundleRaw.trim());
  } else if (Array.isArray(bundleRaw)) {
    for (const b of bundleRaw) {
      if (typeof b === "string" && b.trim()) bundleIds.push(b.trim());
    }
  }

  const partialFailure = Boolean(
    dig(body, "partial_failure") ?? dig(body, "partialFailure"),
  );
  const humanReviewRequired = Boolean(
    dig(body, "human_review_required") ?? dig(body, "humanReviewRequired"),
  );

  return {
    receiveId: typeof receiveId === "string" ? receiveId : null,
    bundleIds,
    partialFailure,
    humanReviewRequired,
  };
}

/** Load PO line family for primary output PO mapping validation. */
export async function loadPoLineFamily(
  zohoPoLineItemId: string | null,
): Promise<ProductFamilyCode> {
  if (!zohoPoLineItemId?.trim()) return "UNKNOWN";
  const [row] = await db
    .select({
      tabletFamily: tabletTypes.productFamily,
      tabletName: tabletTypes.name,
    })
    .from(poLines)
    .leftJoin(tabletTypes, eq(poLines.tabletTypeId, tabletTypes.id))
    .where(eq(poLines.zohoLineItemId, zohoPoLineItemId))
    .limit(1);

  if (!row) return "UNKNOWN";
  return resolveProductFamily({
    persistedFamily: row.tabletFamily,
    name: row.tabletName ?? "",
  });
}
