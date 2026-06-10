import { describe, expect, it } from "vitest";
import {
  buildRawBagIntakeReceivePayload,
  parseZohoPurchaseReceiveId,
} from "./raw-bag-intake-receive";

const ZOHO_ENTITY_ID = "5254962000001234567";

describe("buildRawBagIntakeReceivePayload", () => {
  it("uses full declared physical quantity for receive — not production output", () => {
    const payload = buildRawBagIntakeReceivePayload(
      {
        inventoryBagId: "4a02fc5b-27e4-412e-888a-bf24f84b7d38",
        lumaReceiveId: "recv-1",
        internalReceiptNumber: "352176",
        declaredPillCount: 7219,
        zohoPoId: "po-1",
        zohoLineItemId: "line-1",
        zohoTabletItemId: "tablet-1",
        receiveDate: "2026-05-22",
      },
      { dryRun: true },
    );
    const lineItems = payload.line_items as Array<{ quantity: number }>;
    expect(lineItems[0]?.quantity).toBe(7219);
    expect(payload.dry_run).toBe(true);
    expect(payload.luma_operation_id).toBe(
      "luma-bag-finish-receive:4a02fc5b-27e4-412e-888a-bf24f84b7d38",
    );
  });

  it("never uses quantity_good or unit assembly quantity", () => {
    const payload = buildRawBagIntakeReceivePayload(
      {
        inventoryBagId: "bag-1",
        lumaReceiveId: "recv-1",
        internalReceiptNumber: "352176",
        declaredPillCount: 7219,
        zohoPoId: "po-1",
        zohoLineItemId: "line-1",
        zohoTabletItemId: "tablet-1",
        receiveDate: "2026-05-22",
      },
      { dryRun: true },
    );
    expect(payload).not.toHaveProperty("quantity_good");
    expect(payload).not.toHaveProperty("unit_assembly_quantity");
    expect(payload).not.toHaveProperty("loose_cards");
  });
});

describe("parseZohoPurchaseReceiveId", () => {
  it("extracts purchase_receive_id from nested response", () => {
    expect(
      parseZohoPurchaseReceiveId({
        receive: { receive_id: ZOHO_ENTITY_ID },
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts zoho_purchase_receive_id from bag-receive commit response", () => {
    expect(
      parseZohoPurchaseReceiveId({
        committed: true,
        zoho_purchase_receive_id: ZOHO_ENTITY_ID,
        receive_number: "PR-00600",
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });
});
