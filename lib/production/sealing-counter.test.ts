import { describe, it, expect } from "vitest";
import {
  SEALING_COUNTER_CONFIG_ERROR,
  computeSealedCountFromCounter,
  resolveSealingCardsPerPress,
  stationUsesSealingCounter,
} from "./sealing-counter";

describe("SEALING-COUNTER-1 · sealing counter helper", () => {
  it("stationUsesSealingCounter is true for SEALING and COMBINED only", () => {
    expect(stationUsesSealingCounter("SEALING")).toBe(true);
    expect(stationUsesSealingCounter("COMBINED")).toBe(true);
    expect(stationUsesSealingCounter("BLISTER")).toBe(false);
    expect(stationUsesSealingCounter("HANDPACK_BLISTER")).toBe(false);
  });

  it("resolveSealingCardsPerPress returns null when station has no machine", () => {
    expect(resolveSealingCardsPerPress({ cardsPerTurn: 4 }, null)).toBeNull();
    expect(resolveSealingCardsPerPress({ cardsPerTurn: 4 }, undefined)).toBeNull();
    expect(resolveSealingCardsPerPress(null, "machine-id")).toBeNull();
  });

  it("resolveSealingCardsPerPress rejects non-positive cardsPerTurn", () => {
    expect(resolveSealingCardsPerPress({ cardsPerTurn: 0 }, "machine-id")).toBeNull();
    expect(resolveSealingCardsPerPress({ cardsPerTurn: -1 }, "machine-id")).toBeNull();
  });

  it("resolveSealingCardsPerPress returns positive integer when configured", () => {
    expect(resolveSealingCardsPerPress({ cardsPerTurn: 4 }, "machine-id")).toBe(4);
  });

  it("computeSealedCountFromCounter multiplies counter × cards per press", () => {
    expect(computeSealedCountFromCounter(25, 4)).toBe(100);
    expect(computeSealedCountFromCounter(0, 6)).toBe(0);
  });

  it("config error message is operator-facing", () => {
    expect(SEALING_COUNTER_CONFIG_ERROR).toMatch(/cards per press/i);
  });
});
