import { describe, it, expect } from "vitest";
import { sortQrRows, matchesQrSearch, numericSuffix } from "./qr-sort";

const mkCard = (label: string, cardType: string) => ({
  card: { label, cardType, scanToken: label.replace(/ /g, "-") },
  intakeBag: null,
  intakeBatchNumber: null,
  productName: null,
  workflowState: null,
});

describe("numericSuffix", () => {
  it("extracts trailing number from hyphenated label", () => {
    expect(numericSuffix("bag-card-42")).toBe(42);
  });

  it("extracts trailing number from spaced title-case label", () => {
    expect(numericSuffix("Bag Card 42")).toBe(42);
  });

  it("extracts trailing number when zero-padded", () => {
    expect(numericSuffix("Bag Card 042")).toBe(42);
  });

  it("returns 0 for labels with no digits", () => {
    expect(numericSuffix("old-legacy")).toBe(0);
  });

  it("handles large numbers correctly", () => {
    expect(numericSuffix("bag-card-200")).toBe(200);
  });
});

describe("sortQrRows", () => {
  it("returns empty array unchanged", () => {
    expect(sortQrRows([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const rows = [mkCard("bag-card-2", "RAW_BAG"), mkCard("bag-card-1", "RAW_BAG")];
    const original0 = rows[0];
    sortQrRows(rows);
    expect(rows[0]).toBe(original0);
  });

  it("sorts RAW_BAG before VARIETY_PACK", () => {
    const vp = mkCard("variety-pack-1", "VARIETY_PACK");
    const rb = mkCard("bag-card-1", "RAW_BAG");
    const result = sortQrRows([vp, rb]);
    expect(result[0]).toBe(rb);
    expect(result[1]).toBe(vp);
  });

  it("sorts VARIETY_PACK before WORKFLOW_TRAVELER", () => {
    const wt = mkCard("traveler-1", "WORKFLOW_TRAVELER");
    const vp = mkCard("variety-pack-1", "VARIETY_PACK");
    const result = sortQrRows([wt, vp]);
    expect(result[0]).toBe(vp);
    expect(result[1]).toBe(wt);
  });

  it("sorts UNKNOWN after RAW_BAG and VARIETY_PACK", () => {
    const unk = mkCard("old-card", "UNKNOWN");
    const rb = mkCard("bag-card-1", "RAW_BAG");
    const vp = mkCard("variety-pack-1", "VARIETY_PACK");
    const result = sortQrRows([unk, vp, rb]);
    expect(result[0]).toBe(rb);
    expect(result[1]).toBe(vp);
    expect(result[2]).toBe(unk);
  });

  it("numerically sorts bag-card-1 < bag-card-2 < bag-card-49 < bag-card-200", () => {
    const r1 = mkCard("bag-card-1", "RAW_BAG");
    const r2 = mkCard("bag-card-2", "RAW_BAG");
    const r49 = mkCard("bag-card-49", "RAW_BAG");
    const r200 = mkCard("bag-card-200", "RAW_BAG");
    const result = sortQrRows([r200, r49, r2, r1]);
    expect(result.map((r) => r.card.label)).toEqual([
      "bag-card-1",
      "bag-card-2",
      "bag-card-49",
      "bag-card-200",
    ]);
  });

  it("numerically sorts variety-pack-1 < variety-pack-5", () => {
    const vp1 = mkCard("variety-pack-1", "VARIETY_PACK");
    const vp5 = mkCard("variety-pack-5", "VARIETY_PACK");
    const result = sortQrRows([vp5, vp1]);
    expect(result[0]).toBe(vp1);
    expect(result[1]).toBe(vp5);
  });

  it("does NOT sort lexicographically (bag-card-10 must come after bag-card-9)", () => {
    const r9 = mkCard("bag-card-9", "RAW_BAG");
    const r10 = mkCard("bag-card-10", "RAW_BAG");
    const result = sortQrRows([r10, r9]);
    expect(result[0]).toBe(r9);
    expect(result[1]).toBe(r10);
  });

  it("sorts bag-card-101 after bag-card-100", () => {
    const r100 = mkCard("bag-card-100", "RAW_BAG");
    const r101 = mkCard("bag-card-101", "RAW_BAG");
    const result = sortQrRows([r101, r100]);
    expect(result[0]).toBe(r100);
    expect(result[1]).toBe(r101);
  });

  it("sorts 'Bag Card N' title-case spaced labels numerically", () => {
    const r1 = mkCard("Bag Card 1", "RAW_BAG");
    const r2 = mkCard("Bag Card 2", "RAW_BAG");
    const r10 = mkCard("Bag Card 10", "RAW_BAG");
    const r200 = mkCard("Bag Card 200", "RAW_BAG");
    const result = sortQrRows([r200, r10, r2, r1]);
    expect(result.map((r) => r.card.label)).toEqual([
      "Bag Card 1",
      "Bag Card 2",
      "Bag Card 10",
      "Bag Card 200",
    ]);
  });

  it("sorts mixed hyphenated and spaced labels by numeric suffix", () => {
    const r1 = mkCard("bag-card-1", "RAW_BAG");
    const r2 = mkCard("Bag Card 2", "RAW_BAG");
    const r9 = mkCard("bag-card-9", "RAW_BAG");
    const r10 = mkCard("Bag Card 10", "RAW_BAG");
    const result = sortQrRows([r10, r9, r2, r1]);
    const nums = result.map((r) => numericSuffix(r.card.label));
    expect(nums).toEqual([1, 2, 9, 10]);
  });

  it("Bag Card 2 sorts before Bag Card 10", () => {
    const r2 = mkCard("Bag Card 2", "RAW_BAG");
    const r10 = mkCard("Bag Card 10", "RAW_BAG");
    const result = sortQrRows([r10, r2]);
    expect(result[0]).toBe(r2);
    expect(result[1]).toBe(r10);
  });

  it("bag-card-9 sorts before bag-card-10 (task requirement)", () => {
    const r9 = mkCard("bag-card-9", "RAW_BAG");
    const r10 = mkCard("bag-card-10", "RAW_BAG");
    const result = sortQrRows([r10, r9]);
    expect(result[0]).toBe(r9);
    expect(result[1]).toBe(r10);
  });
});

describe("matchesQrSearch", () => {
  it("matches active workflow PO, tablet, product, and stage context", () => {
    const row = {
      card: { label: "Card #81", cardType: "RAW_BAG", scanToken: "bag-card-81" },
      intakeBag: {
        internalReceiptNumber: "352195",
        receiveName: "PO-00248-R1",
        poNumber: "PO-00248",
        tabletTypeName: "12ct FIX Relax",
      },
      intakeBatchNumber: null,
      productName: "Hyroxi MIT A - BlueRaz",
      workflowState: { stage: "STARTED" },
    };

    expect(matchesQrSearch(row, "00248")).toBe(true);
    expect(matchesQrSearch(row, "fix relax")).toBe(true);
    expect(matchesQrSearch(row, "blueraz")).toBe(true);
    expect(matchesQrSearch(row, "started")).toBe(true);
  });
});

describe("matchesQrSearch", () => {
  const row = {
    card: { label: "bag-card-49", cardType: "RAW_BAG", scanToken: "bag-card-49" },
    intakeBag: { internalReceiptNumber: "RB-20260514-049" },
    intakeBatchNumber: "LOT-ACME-001",
    productName: "Choco Drift 4ct Card",
  };

  it("empty query matches everything", () => {
    expect(matchesQrSearch(row, "")).toBe(true);
  });

  it("matches by label", () => {
    expect(matchesQrSearch(row, "bag-card-49")).toBe(true);
  });

  it("matches by scan token", () => {
    expect(matchesQrSearch(row, "bag-card-49")).toBe(true);
  });

  it("matches numeric portion of label (searching '49' finds bag-card-49)", () => {
    expect(matchesQrSearch(row, "49")).toBe(true);
  });

  it("matches receipt number", () => {
    expect(matchesQrSearch(row, "RB-20260514-049")).toBe(true);
  });

  it("matches partial receipt number", () => {
    expect(matchesQrSearch(row, "20260514")).toBe(true);
  });

  it("matches supplier lot", () => {
    expect(matchesQrSearch(row, "LOT-ACME-001")).toBe(true);
  });

  it("matches product name", () => {
    expect(matchesQrSearch(row, "Choco")).toBe(true);
  });

  it("returns false for unrelated query", () => {
    expect(matchesQrSearch(row, "xyz-not-found-999")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesQrSearch(row, "BAG-CARD")).toBe(true);
  });

  it("handles null intakeBag without throwing", () => {
    const noIntake = { ...row, intakeBag: null };
    expect(matchesQrSearch(noIntake, "49")).toBe(true);
  });

  it("handles null intakeBatchNumber without throwing", () => {
    const noLot = { ...row, intakeBatchNumber: null };
    expect(matchesQrSearch(noLot, "49")).toBe(true);
  });

  it("matches receive name", () => {
    const withReceive = {
      ...row,
      intakeBag: { internalReceiptNumber: "RB-20260514-049", receiveName: "PO-00238-R1" },
    };
    expect(matchesQrSearch(withReceive, "PO-00238")).toBe(true);
  });

  it("returns false when only receive name does not match query", () => {
    const withReceive = {
      ...row,
      intakeBag: { internalReceiptNumber: "RB-20260514-049", receiveName: "PO-00238-R1" },
    };
    expect(matchesQrSearch(withReceive, "PO-99999")).toBe(false);
  });

  it("handles null receiveName without throwing", () => {
    const noReceive = {
      ...row,
      intakeBag: { internalReceiptNumber: "RB-20260514-049", receiveName: null },
    };
    expect(matchesQrSearch(noReceive, "49")).toBe(true);
  });
});
