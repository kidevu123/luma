import { describe, expect, it } from "vitest";
import {
  deriveComponentBatchOutQuantity,
  rejectWorkflowBagAsSourceBagId,
  validateComponentBatchOutQuantity,
  validateComponentBatchPayloadAgainstBom,
  validateSourceAllocationQuantity,
} from "@/lib/zoho/component-batch-quantity";
import {
  CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
  CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
  deriveChocoDriftPackagingQuantity,
  deriveChocoDriftRawTabletQuantity,
} from "@/lib/zoho/v1206-choco-drift-pilot-contract";

const TEST_INVENTORY_BAG_ID = "00000000-0000-4000-8000-000000000099";

describe("component quantity derivation", () => {
  it("derives quantity = BOM per unit × unit_assembly_quantity", () => {
    expect(deriveComponentBatchOutQuantity(1, 1)).toBe(1);
    expect(deriveComponentBatchOutQuantity(4, 1)).toBe(4);
    expect(deriveComponentBatchOutQuantity(4, 900)).toBe(3600);
    expect(deriveChocoDriftRawTabletQuantity(900)).toBe(3600);
    expect(deriveChocoDriftPackagingQuantity(900)).toBe(900);
  });

  it("rejects out_quantity != BOM × unit_assembly_quantity", () => {
    const result = validateComponentBatchOutQuantity({
      outQuantity: 900,
      bomQuantityPerUnit: 4,
      unitAssemblyQuantity: 900,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BOM_QUANTITY_MISMATCH");
  });

  it("rejects source allocation quantity mismatch for Choco Drift raw tablets", () => {
    const result = validateSourceAllocationQuantity({
      allocatedQuantity: 900,
      bomQuantityPerUnit: CHOCO_DRIFT_RAW_TABLET_BOM_QUANTITY_PER_UNIT,
      unitAssemblyQuantity: 900,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects workflow bag id used as source_bag_id", () => {
    const workflowBagId = "9a84d52a-0e18-4f91-907d-947a81280ec8";
    expect(
      rejectWorkflowBagAsSourceBagId(workflowBagId, workflowBagId).ok,
    ).toBe(false);
    expect(
      rejectWorkflowBagAsSourceBagId(TEST_INVENTORY_BAG_ID, workflowBagId).ok,
    ).toBe(true);
  });

  it("validates batch-tracked payload slices when present", () => {
    const check = validateComponentBatchPayloadAgainstBom({
      unitAssemblyQuantity: 900,
      bomQuantityPerUnitByItemId: { [CHOCO_DRIFT_RAW_TABLET_ITEM_ID]: 4 },
      componentBatches: [
        {
          item_id: CHOCO_DRIFT_RAW_TABLET_ITEM_ID,
          source_bag_id: TEST_INVENTORY_BAG_ID,
          batches: [{ batch_id: "batch-1", out_quantity: 3600 }],
        },
      ],
    });
    expect(check.ok).toBe(true);
  });
});
