import { describe, it, expect } from "vitest";
import {
  bagStageToQueueStageKey,
  queueStageKeyToBagStage,
} from "./stage-lexicon";

describe("bagStageToQueueStageKey", () => {
  it("maps a card bag at STARTED to the blister queue", () => {
    expect(bagStageToQueueStageKey("STARTED", "CARD_BLISTER")).toBe("BLISTER_QUEUE");
  });

  it("maps a card bag at BLISTERED to the sealing queue", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "CARD_BLISTER")).toBe("SEALING_QUEUE");
  });

  it("maps a card bag at SEALED to the packaging queue", () => {
    expect(bagStageToQueueStageKey("SEALED", "CARD_BLISTER")).toBe("PACKAGING_QUEUE");
  });

  it("maps a bottle bag at BLISTERED to the sticker queue", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "BOTTLE")).toBe("BOTTLE_STICKER_QUEUE");
  });

  it("returns null for an unknown route code rather than guessing", () => {
    expect(bagStageToQueueStageKey("BLISTERED", "NOT_A_ROUTE")).toBeNull();
  });

  it("returns null for a finalized bag — it is in no queue", () => {
    expect(bagStageToQueueStageKey("FINALIZED", "CARD_BLISTER")).toBeNull();
  });
});

describe("queueStageKeyToBagStage", () => {
  it("maps the sealing queue back to the bag stage that enters it", () => {
    expect(queueStageKeyToBagStage("SEALING_QUEUE", "CARD_BLISTER")).toBe("BLISTERED");
  });

  it("maps the finished-goods queue to FINALIZED", () => {
    expect(queueStageKeyToBagStage("FINISHED_GOODS_QUEUE", "CARD_BLISTER")).toBe(
      "FINALIZED",
    );
  });

  it("returns null for staging keys that have no bag-stage equivalent", () => {
    expect(queueStageKeyToBagStage("POST_BLISTER_STAGING", "CARD_BLISTER")).toBeNull();
  });

  it("resolves the sticker queue differently per route", () => {
    // Fill happens first on BOTTLE, so a bag reaching the sticker queue
    // is already BLISTERED. On STICKER_ONLY stickering IS the first
    // operation, so the same queue is entered at STARTED. A flat
    // (non-route-parameterized) table cannot express both.
    expect(queueStageKeyToBagStage("BOTTLE_STICKER_QUEUE", "BOTTLE")).toBe("BLISTERED");
    expect(queueStageKeyToBagStage("BOTTLE_STICKER_QUEUE", "STICKER_ONLY")).toBe(
      "STARTED",
    );
  });

  it("returns null without a route rather than guessing", () => {
    expect(queueStageKeyToBagStage("SEALING_QUEUE", null)).toBeNull();
  });

  it("is the inverse of bagStageToQueueStageKey for every mid-route stage", () => {
    for (const [routeCode, stages] of [
      ["CARD_BLISTER", ["STARTED", "BLISTERED", "SEALED"]],
      ["BOTTLE", ["STARTED", "BLISTERED", "SEALED"]],
      ["STICKER_ONLY", ["STARTED", "SEALED"]],
    ] as const) {
      for (const stage of stages) {
        const queue = bagStageToQueueStageKey(stage, routeCode);
        expect(queue).not.toBeNull();
        expect(queueStageKeyToBagStage(queue, routeCode)).toBe(stage);
      }
    }
  });
});
