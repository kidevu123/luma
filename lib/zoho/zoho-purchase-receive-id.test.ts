import { describe, expect, it } from "vitest";
import {
  parseZohoPurchaseReceiveId,
  parseZohoReceiveNumber,
} from "./zoho-purchase-receive-id";

const ZOHO_ENTITY_ID = "5254962000006698069";
const RECEIVE_NUMBER = "PR-00568";

describe("parseZohoPurchaseReceiveId", () => {
  it("extracts top-level zoho_purchase_receive_id (Bag A commit shape)", () => {
    expect(
      parseZohoPurchaseReceiveId({
        committed: true,
        zoho_purchase_receive_id: ZOHO_ENTITY_ID,
        receive_number: RECEIVE_NUMBER,
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts top-level receive_id", () => {
    expect(parseZohoPurchaseReceiveId({ receive_id: ZOHO_ENTITY_ID })).toBe(
      ZOHO_ENTITY_ID,
    );
  });

  it("extracts top-level purchase_receive_id", () => {
    expect(
      parseZohoPurchaseReceiveId({ purchase_receive_id: ZOHO_ENTITY_ID }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts nested receive.receive_id", () => {
    expect(
      parseZohoPurchaseReceiveId({
        receive: { receive_id: ZOHO_ENTITY_ID },
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts wrapped data.purchase_receive_id", () => {
    expect(
      parseZohoPurchaseReceiveId({
        data: { purchase_receive_id: ZOHO_ENTITY_ID },
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts wrapped data.zoho_purchase_receive_id", () => {
    expect(
      parseZohoPurchaseReceiveId({
        data: { zoho_purchase_receive_id: ZOHO_ENTITY_ID },
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });

  it("extracts idempotent replay response with replay marker", () => {
    expect(
      parseZohoPurchaseReceiveId({
        idempotent_replay: true,
        zoho_purchase_receive_id: ZOHO_ENTITY_ID,
        receive_number: RECEIVE_NUMBER,
        status: "received",
      }),
    ).toBe(ZOHO_ENTITY_ID);
  });
});

describe("parseZohoReceiveNumber", () => {
  it("extracts top-level receive_number", () => {
    expect(
      parseZohoReceiveNumber({
        zoho_purchase_receive_id: ZOHO_ENTITY_ID,
        receive_number: RECEIVE_NUMBER,
      }),
    ).toBe(RECEIVE_NUMBER);
  });

  it("extracts top-level purchase_receive_number", () => {
    expect(
      parseZohoReceiveNumber({ purchase_receive_number: RECEIVE_NUMBER }),
    ).toBe(RECEIVE_NUMBER);
  });

  it("extracts wrapped data.receive_number", () => {
    expect(
      parseZohoReceiveNumber({
        data: {
          purchase_receive_id: ZOHO_ENTITY_ID,
          receive_number: RECEIVE_NUMBER,
        },
      }),
    ).toBe(RECEIVE_NUMBER);
  });

  it("extracts idempotent replay receive_number", () => {
    expect(
      parseZohoReceiveNumber({
        idempotent_replay: true,
        zoho_purchase_receive_id: ZOHO_ENTITY_ID,
        receive_number: RECEIVE_NUMBER,
      }),
    ).toBe(RECEIVE_NUMBER);
  });
});
