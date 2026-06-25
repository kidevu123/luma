import { describe, expect, it } from "vitest";
import { parseZohoPurchaseReceiveId } from "./zoho-purchase-receive-id";

const ZOHO_ENTITY_ID = "5254962000001234567";

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
