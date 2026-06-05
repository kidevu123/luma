import { describe, expect, it } from "vitest";
import {
  batchProductionBlockReason,
  isBatchAvailableForProduction,
  noteIndicatesQaBlock,
} from "./batch-production-guard";

describe("batchProductionBlockReason", () => {
  it("allows RELEASED", () => {
    expect(isBatchAvailableForProduction("RELEASED")).toBe(true);
    expect(batchProductionBlockReason("RELEASED")).toBe("");
  });

  it("blocks quarantine with review copy", () => {
    expect(isBatchAvailableForProduction("QUARANTINE")).toBe(false);
    expect(batchProductionBlockReason("QUARANTINE", "B-100")).toContain(
      "blocked for review",
    );
  });

  it("blocks hold, recall, expired, depleted with specific copy", () => {
    expect(batchProductionBlockReason("ON_HOLD")).toContain("on hold");
    expect(batchProductionBlockReason("RECALLED")).toContain("recalled");
    expect(batchProductionBlockReason("EXPIRED")).toContain("expired");
    expect(batchProductionBlockReason("DEPLETED")).toContain(
      "no quantity on hand",
    );
  });
});

describe("noteIndicatesQaBlock", () => {
  it("returns false for empty notes", () => {
    expect(noteIndicatesQaBlock(null)).toBe(false);
    expect(noteIndicatesQaBlock("")).toBe(false);
  });

  it("detects QA block phrases", () => {
    expect(noteIndicatesQaBlock("Pending QA investigation")).toBe(true);
    expect(noteIndicatesQaBlock("Received from vendor")).toBe(false);
  });
});
