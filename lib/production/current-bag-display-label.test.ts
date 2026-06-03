import { describe, expect, it } from "vitest";
import { buildCurrentBagDisplayLabel } from "./current-bag-display-label";

describe("FLOOR-CURRENT-BAG-CONTEXT-1 · current bag label", () => {
  it("uses PO, tablet, and received bag number when available", () => {
    expect(
      buildCurrentBagDisplayLabel({
        cardLabel: "Card #63",
        poNumber: "206",
        tabletTypeName: "MIT A Pineapple",
        productName: "Finished Product",
        inventoryBagNumber: 2,
        workflowBagNumber: 63,
      }),
    ).toEqual({
      primary: "PO 206 - MIT A Pineapple - Bag 2",
      secondary: "Card #63",
      hasReceivedContext: true,
    });
  });

  it("does not duplicate an existing PO prefix", () => {
    expect(
      buildCurrentBagDisplayLabel({
        cardLabel: "Bag Card 107",
        poNumber: "PO-00238",
        tabletTypeName: "MIT B Green Apple",
        productName: null,
        inventoryBagNumber: 1,
        workflowBagNumber: 107,
      }),
    ).toMatchObject({
      primary: "PO-00238 - MIT B Green Apple - Bag 1",
      secondary: "Bag Card 107",
      hasReceivedContext: true,
    });
  });

  it("falls back to product and workflow bag number when tablet/inventory bag context is partial", () => {
    expect(
      buildCurrentBagDisplayLabel({
        cardLabel: "Card #63",
        poNumber: null,
        tabletTypeName: null,
        productName: "Hyroxi MIT B - Sun Drip",
        inventoryBagNumber: null,
        workflowBagNumber: 7,
      }),
    ).toMatchObject({
      primary: "Hyroxi MIT B - Sun Drip - Bag 7",
      secondary: "Card #63",
      hasReceivedContext: true,
    });
  });

  it("falls back honestly to card label when no reliable context exists", () => {
    expect(
      buildCurrentBagDisplayLabel({
        cardLabel: "Card #63",
        poNumber: null,
        tabletTypeName: null,
        productName: null,
        inventoryBagNumber: null,
        workflowBagNumber: null,
      }),
    ).toEqual({
      primary: "Card #63",
      secondary: null,
      hasReceivedContext: false,
    });
  });

  it("does not infer from UUIDs or row order", () => {
    const src = buildCurrentBagDisplayLabel.toString();
    expect(src).not.toMatch(/uuid|slice|row|order/i);
  });
});
