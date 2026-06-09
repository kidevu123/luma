// ZOHO-V1206 — component batch out_quantity derived from live/normalized BOM.

export type ComponentBatchQuantityValidationResult =
  | { ok: true; expectedOutQuantity: number }
  | { ok: false; code: "BOM_QUANTITY_MISMATCH" | "INVALID_BOM_QUANTITY" | "INVALID_UNIT_ASSEMBLY"; message: string };

/**
 * Raw component inventory consumed for a production-output commit.
 *
 * out_quantity = bomQuantityPerUnit × unitAssemblyQuantity
 *
 * unitAssemblyQuantity is the number of finished composite units to build
 * (same as unit_assembly_quantity / finished_lots.units_produced).
 */
export function deriveComponentBatchOutQuantity(
  bomQuantityPerUnit: number,
  unitAssemblyQuantity: number,
): number {
  if (!Number.isFinite(bomQuantityPerUnit) || bomQuantityPerUnit <= 0) {
    throw new Error("bomQuantityPerUnit must be a positive finite number.");
  }
  if (!Number.isFinite(unitAssemblyQuantity) || unitAssemblyQuantity <= 0) {
    throw new Error("unitAssemblyQuantity must be a positive finite number.");
  }
  return Math.round(bomQuantityPerUnit * unitAssemblyQuantity);
}

/** Reject payloads where out_quantity was not derived from BOM × unit assembly. */
export function validateComponentBatchOutQuantity(input: {
  outQuantity: number;
  bomQuantityPerUnit: number;
  unitAssemblyQuantity: number;
}): ComponentBatchQuantityValidationResult {
  if (!Number.isFinite(input.bomQuantityPerUnit) || input.bomQuantityPerUnit <= 0) {
    return {
      ok: false,
      code: "INVALID_BOM_QUANTITY",
      message: "Normalized BOM quantity per unit must be a positive number.",
    };
  }
  if (!Number.isFinite(input.unitAssemblyQuantity) || input.unitAssemblyQuantity <= 0) {
    return {
      ok: false,
      code: "INVALID_UNIT_ASSEMBLY",
      message: "unit_assembly_quantity must be a positive number.",
    };
  }

  const expectedOutQuantity = deriveComponentBatchOutQuantity(
    input.bomQuantityPerUnit,
    input.unitAssemblyQuantity,
  );

  if (input.outQuantity !== expectedOutQuantity) {
    return {
      ok: false,
      code: "BOM_QUANTITY_MISMATCH",
      message:
        `component_batches out_quantity (${input.outQuantity}) must equal ` +
        `BOM quantity per unit (${input.bomQuantityPerUnit}) × ` +
        `unit_assembly_quantity (${input.unitAssemblyQuantity}) = ${expectedOutQuantity}.`,
    };
  }

  return { ok: true, expectedOutQuantity };
}

export type ComponentBatchPayloadSlice = {
  item_id: string;
  source_bag_id: string;
  batches: Array<{ batch_id: string; out_quantity: number }>;
};

/** Validate every component_batches entry against normalized BOM quantities. */
export function validateComponentBatchPayloadAgainstBom(input: {
  componentBatches: ComponentBatchPayloadSlice[];
  unitAssemblyQuantity: number;
  bomQuantityPerUnitByItemId: Record<string, number>;
}): ComponentBatchQuantityValidationResult {
  for (const entry of input.componentBatches) {
    const bomQty = input.bomQuantityPerUnitByItemId[entry.item_id];
    if (bomQty == null) {
      return {
        ok: false,
        code: "INVALID_BOM_QUANTITY",
        message: `Missing normalized BOM quantity for component item ${entry.item_id}.`,
      };
    }
    for (const batch of entry.batches) {
      const check = validateComponentBatchOutQuantity({
        outQuantity: batch.out_quantity,
        bomQuantityPerUnit: bomQty,
        unitAssemblyQuantity: input.unitAssemblyQuantity,
      });
      if (!check.ok) return check;
    }
  }
  return {
    ok: true,
    expectedOutQuantity: deriveComponentBatchOutQuantity(
      input.bomQuantityPerUnitByItemId[input.componentBatches[0]?.item_id ?? ""] ?? 1,
      input.unitAssemblyQuantity,
    ),
  };
}

/** Reject persisted source allocation quantity that does not match BOM × units. */
export function validateSourceAllocationQuantity(input: {
  allocatedQuantity: number;
  bomQuantityPerUnit: number;
  unitAssemblyQuantity: number;
}): ComponentBatchQuantityValidationResult {
  const expected = deriveComponentBatchOutQuantity(
    input.bomQuantityPerUnit,
    input.unitAssemblyQuantity,
  );
  if (input.allocatedQuantity !== expected) {
    return {
      ok: false,
      code: "BOM_QUANTITY_MISMATCH",
      message:
        `Source allocation quantity (${input.allocatedQuantity}) must equal ` +
        `BOM quantity per unit (${input.bomQuantityPerUnit}) × ` +
        `unit_assembly_quantity (${input.unitAssemblyQuantity}) = ${expected}.`,
    };
  }
  return { ok: true, expectedOutQuantity: expected };
}

/**
 * source_bag_id must be inventory_bags.id from a closed allocation session —
 * never workflow_bags.id, receipt labels, or fixture placeholders.
 */
export function sourceBagIdFromClosedAllocationSession(session: {
  inventoryBagId: string;
}): string {
  return session.inventoryBagId;
}

/** Workflow bags must never be used as source_bag_id. */
export function rejectWorkflowBagAsSourceBagId(
  sourceBagId: string,
  workflowBagId: string | null,
): ComponentBatchQuantityValidationResult | { ok: true; expectedOutQuantity: number } {
  if (workflowBagId != null && sourceBagId === workflowBagId) {
    return {
      ok: false,
      code: "BOM_QUANTITY_MISMATCH",
      message: "source_bag_id must be inventory_bags.id, not workflow_bags.id.",
    };
  }
  return { ok: true, expectedOutQuantity: 0 };
}
