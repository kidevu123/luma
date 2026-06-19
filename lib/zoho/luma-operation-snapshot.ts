// ZOHO-V1206 — persisted operation snapshot for Zoho preview/commit verification.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finishedLots,
  products,
  workflowBags,
  zohoProductionOutputOps,
  zohoProductionOutputSourceAllocations,
} from "@/lib/db/schema";
import { resolveProductFamily } from "@/lib/zoho/product-family";
import type { LumaProductionOutputPayload } from "@/lib/zoho/luma-production-output-payload";

// ASSEMBLY-LEVEL-SCOPING-v1.4.18 — Zoho gateway v1.28.0 validates each
// source allocation row against the BOM of a SINGLE assembly level
// (per-row scoped, not broadcast). Luma stamps the level so the
// gateway routes each row to the right BOM. Raw tablet bags feed
// unit_assembly; re-work flows that consume intermediates should
// stamp the level whose BOM contains the consumed item.
export type LumaSnapshotAssemblyLevel =
  | "unit_assembly"
  | "display_assembly"
  | "case_assembly";

/**
 * Derive the assembly_level for a source allocation from its
 * componentRole. Today every Luma source allocation comes from a
 * raw_bag_allocation_sessions row (raw tablet → unit assembly), so
 * this returns "unit_assembly" for every value. componentRole here
 * is the variety-flavor identifier ("PRIMARY", "FLAVOR_A", …) — it
 * does NOT name a BOM level by itself. Keep the switch greppable
 * for when re-work paths begin to emit non-raw rows.
 */
export function deriveSourceAllocationAssemblyLevel(
  componentRole: string | null,
): LumaSnapshotAssemblyLevel {
  void componentRole;
  return "unit_assembly";
}

export type LumaOperationSnapshotSourceAllocation = {
  source_bag_id: string;
  item_id: string;
  human_lot_number: string;
  quantity: number;
  assembly_level: LumaSnapshotAssemblyLevel;
};

export type LumaOperationSnapshot = {
  luma_operation_id: string;
  status: "finalized";
  finalized_at: string;
  /** Luma internal products.id UUID — not a Zoho item ID. */
  product_id: string;
  product_family: string;
  finished_sku: string;
  /** Zoho finished-good unit composite item ID (products.zoho_item_id_unit). */
  unit_composite_item_id: string;
  workflow_bag_id: string;
  finished_lot_id: string;
  source_allocations: LumaOperationSnapshotSourceAllocation[];
};

export type SnapshotBuildResult =
  | { ok: true; snapshot: LumaOperationSnapshot }
  | { ok: false; blockers: Array<{ code: string; message: string }> };

export type SnapshotVerificationResult =
  | { ok: true }
  | { ok: false; code: "SNAPSHOT_BODY_MISMATCH"; message: string };

/** Pure builder when allocation rows are already loaded (e.g. inside a transaction). */
export function buildLumaOperationSnapshotFromOpRow(
  op: {
    lumaOperationId: string;
    finalizedAt: Date | null;
    productId: string | null;
    productFamily: string | null;
    finishedSku: string | null;
    unitCompositeItemId: string | null;
    workflowBagId: string | null;
    finishedLotId: string;
  },
  allocations: Array<{
    lumaInventoryBagId: string;
    zohoComponentItemId: string;
    humanLotNumber: string;
    quantityAllocated: string | number;
    /** Variety-flavor identifier; used to derive assembly_level. */
    componentRole?: string | null;
  }>,
): SnapshotBuildResult {
  const blockers: Array<{ code: string; message: string }> = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  if (!op.finalizedAt) add("FINALIZED_AT_MISSING", "Operation finalized_at is not set.");
  if (!op.productId) add("PRODUCT_ID_MISSING", "Operation product_id is not set.");
  if (!op.productFamily) add("PRODUCT_FAMILY_MISSING", "Operation product_family is not set.");
  if (!op.finishedSku) add("FINISHED_SKU_MISSING", "Operation finished_sku is not set.");
  if (!op.unitCompositeItemId) {
    add("UNIT_COMPOSITE_ITEM_ID_MISSING", "Operation unit_composite_item_id is not set.");
  }
  if (!op.workflowBagId) add("WORKFLOW_BAG_MISSING", "Operation has no workflow bag linkage.");
  if (allocations.length === 0) {
    add("MISSING_SOURCE_ALLOCATIONS", "No source allocation rows provided.");
  }
  if (blockers.length > 0) return { ok: false, blockers };

  return {
    ok: true,
    snapshot: {
      luma_operation_id: op.lumaOperationId,
      status: "finalized",
      finalized_at: op.finalizedAt!.toISOString(),
      product_id: op.productId!,
      product_family: op.productFamily!,
      finished_sku: op.finishedSku!,
      unit_composite_item_id: op.unitCompositeItemId!,
      workflow_bag_id: op.workflowBagId!,
      finished_lot_id: op.finishedLotId,
      source_allocations: allocations.map((row) => ({
        source_bag_id: row.lumaInventoryBagId,
        item_id: row.zohoComponentItemId,
        human_lot_number: row.humanLotNumber,
        quantity: Number(row.quantityAllocated),
        assembly_level: deriveSourceAllocationAssemblyLevel(
          row.componentRole ?? null,
        ),
      })),
    },
  };
}

/** Build snapshot strictly from persisted op + linked allocation rows. */
export async function buildLumaOperationSnapshotFromPersistedOp(
  opId: string,
): Promise<SnapshotBuildResult> {
  const blockers: Array<{ code: string; message: string }> = [];
  const add = (code: string, message: string) => blockers.push({ code, message });

  const [op] = await db
    .select()
    .from(zohoProductionOutputOps)
    .where(eq(zohoProductionOutputOps.id, opId))
    .limit(1);

  if (!op) {
    add("OP_NOT_FOUND", "Persisted operation not found.");
    return { ok: false, blockers };
  }

  if (op.voidedAt != null) {
    add("OP_VOIDED", "Operation is voided.");
  }

  const [lot] = await db
    .select({
      id: finishedLots.id,
      productId: finishedLots.productId,
      workflowBagId: finishedLots.workflowBagId,
    })
    .from(finishedLots)
    .where(eq(finishedLots.id, op.finishedLotId))
    .limit(1);

  if (!lot) {
    add("FINISHED_LOT_MISSING", "Finished lot not found for operation.");
  }

  if (!op.workflowBagId) {
    add("WORKFLOW_BAG_MISSING", "Operation has no workflow bag linkage.");
  }

  const allocations = await db
    .select()
    .from(zohoProductionOutputSourceAllocations)
    .where(eq(zohoProductionOutputSourceAllocations.zohoProductionOutputOpId, opId));

  if (allocations.length === 0) {
    add(
      "MISSING_SOURCE_ALLOCATIONS",
      "No persisted source allocation rows linked to this operation.",
    );
  }

  const finalizedAt = op.finalizedAt ?? null;
  if (!finalizedAt) {
    add("FINALIZED_AT_MISSING", "Operation finalized_at is not set.");
  }

  const productId = op.productId ?? lot?.productId ?? null;
  if (!productId) {
    add("PRODUCT_ID_MISSING", "Operation product_id is not set.");
  }

  let productFamily = op.productFamily;
  let finishedSku = op.finishedSku;
  let unitCompositeItemId: string | null = op.zohoCompositeItemId ?? null;
  if (productId && (!productFamily || !finishedSku || !unitCompositeItemId)) {
    const [product] = await db
      .select({
        sku: products.sku,
        name: products.name,
        productFamily: products.productFamily,
        zohoItemIdUnit: products.zohoItemIdUnit,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (product) {
      finishedSku = finishedSku ?? product.sku;
      unitCompositeItemId = unitCompositeItemId ?? product.zohoItemIdUnit;
      productFamily =
        productFamily ??
        resolveProductFamily({
          persistedFamily: product.productFamily,
          name: product.name,
        });
    }
  }

  if (!finishedSku) {
    add("FINISHED_SKU_MISSING", "Operation finished_sku is not set.");
  }
  if (!productFamily) {
    add("PRODUCT_FAMILY_MISSING", "Operation product_family is not set.");
  }
  if (!unitCompositeItemId) {
    add(
      "UNIT_COMPOSITE_ITEM_ID_MISSING",
      "Operation unit_composite_item_id is not set.",
    );
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const snapshot: LumaOperationSnapshot = {
    luma_operation_id: op.lumaOperationId,
    status: "finalized",
    finalized_at: finalizedAt!.toISOString(),
    product_id: productId!,
    product_family: productFamily!,
    finished_sku: finishedSku!,
    unit_composite_item_id: unitCompositeItemId!,
    workflow_bag_id: op.workflowBagId!,
    finished_lot_id: op.finishedLotId,
    source_allocations: allocations.map((row) => ({
      source_bag_id: row.lumaInventoryBagId,
      item_id: row.zohoComponentItemId,
      human_lot_number: row.humanLotNumber,
      quantity: Number(row.quantityAllocated),
      assembly_level: deriveSourceAllocationAssemblyLevel(row.componentRole),
    })),
  };

  return { ok: true, snapshot };
}

/** Reject outbound bodies whose snapshot does not match persisted operation. */
export function verifySnapshotMatchesPersistedOperation(
  persisted: LumaOperationSnapshot,
  bodySnapshot: unknown,
): SnapshotVerificationResult {
  if (bodySnapshot == null || typeof bodySnapshot !== "object") {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Request body is missing luma_operation_snapshot.",
    };
  }

  const incoming = bodySnapshot as LumaOperationSnapshot;
  if (incoming.luma_operation_id !== persisted.luma_operation_id) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot luma_operation_id does not match persisted operation.",
    };
  }
  if (incoming.finished_lot_id !== persisted.finished_lot_id) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot finished_lot_id does not match persisted operation.",
    };
  }
  if (incoming.product_id !== persisted.product_id) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot product_id does not match persisted operation.",
    };
  }
  if (incoming.unit_composite_item_id !== persisted.unit_composite_item_id) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot unit_composite_item_id does not match persisted operation.",
    };
  }
  if (incoming.workflow_bag_id !== persisted.workflow_bag_id) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot workflow_bag_id does not match persisted operation.",
    };
  }
  if (incoming.source_allocations.length !== persisted.source_allocations.length) {
    return {
      ok: false,
      code: "SNAPSHOT_BODY_MISMATCH",
      message: "Snapshot source_allocations count does not match persisted rows.",
    };
  }

  for (const expected of persisted.source_allocations) {
    const match = incoming.source_allocations.find(
      (a) =>
        a.source_bag_id === expected.source_bag_id &&
        a.item_id === expected.item_id &&
        a.human_lot_number === expected.human_lot_number,
    );
    if (!match || match.quantity !== expected.quantity) {
      return {
        ok: false,
        code: "SNAPSHOT_BODY_MISMATCH",
        message: `Snapshot source allocation mismatch for bag ${expected.source_bag_id}.`,
      };
    }
  }

  return { ok: true };
}

export function attachSnapshotToPayload<T extends Record<string, unknown>>(
  payload: T,
  snapshot: LumaOperationSnapshot,
): T & { luma_operation_snapshot: LumaOperationSnapshot } {
  return {
    ...payload,
    luma_operation_snapshot: snapshot,
  };
}

export function parsePreviewWritesAllowed(previewResponse: unknown): boolean {
  if (previewResponse == null || typeof previewResponse !== "object") return false;
  const obj = previewResponse as Record<string, unknown>;
  if (typeof obj.writes_allowed === "boolean") return obj.writes_allowed;
  const verification = obj.verification;
  if (verification != null && typeof verification === "object") {
    const mode = (verification as Record<string, unknown>).mode;
    const writes = (verification as Record<string, unknown>).writes_allowed;
    if (mode === "snapshot" && typeof writes === "boolean") return writes;
  }
  return false;
}

export function snapshotFromPayloadIfValid(
  payload: LumaProductionOutputPayload,
): LumaOperationSnapshot | null {
  const snap = (payload as LumaProductionOutputPayload & {
    luma_operation_snapshot?: LumaOperationSnapshot;
  }).luma_operation_snapshot;
  return snap ?? null;
}
