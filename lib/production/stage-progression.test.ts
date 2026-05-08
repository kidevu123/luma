import { describe, it, expect } from "vitest";
import {
  EVENT_STAGE_PREREQ,
  checkStageProgression,
} from "./stage-progression";

describe("stage progression — duplicate BLISTER_COMPLETE prevention", () => {
  it("allows BLISTER_COMPLETE when bag is at STARTED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "STARTED",
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects a SECOND BLISTER_COMPLETE when bag is already BLISTERED (the bug we're fixing)", () => {
    const r = checkStageProgression({
      eventType: "BLISTER_COMPLETE",
      currentStage: "BLISTERED",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/BLISTERED/);
      expect(r.reason).toMatch(/BLISTER_COMPLETE/);
    }
  });

  it("rejects BLISTER_COMPLETE when bag is SEALED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "SEALED",
      }).allowed,
    ).toBe(false);
  });

  it("rejects BLISTER_COMPLETE when bag is PACKAGED", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: "PACKAGED",
      }).allowed,
    ).toBe(false);
  });

  it("rejects ANY stage event when bag is finalized", () => {
    for (const eventType of Object.keys(EVENT_STAGE_PREREQ)) {
      const r = checkStageProgression({
        eventType,
        currentStage: "FINALIZED",
        isFinalized: true,
      });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toMatch(/finalized/);
    }
  });

  it("rejects forward stage events when bag is paused", () => {
    const r = checkStageProgression({
      eventType: "BLISTER_COMPLETE",
      currentStage: "STARTED",
      isPaused: true,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/paused/);
  });
});

describe("stage progression — full forward pipeline", () => {
  const cases: Array<[string, string, boolean]> = [
    // [event, currentStage, allowed]
    ["BLISTER_COMPLETE", "STARTED", true],
    ["BLISTER_COMPLETE", "BLISTERED", false],
    ["BLISTER_COMPLETE", "SEALED", false],
    ["SEALING_COMPLETE", "BLISTERED", true],
    ["SEALING_COMPLETE", "STARTED", false],
    ["SEALING_COMPLETE", "SEALED", false],
    ["PACKAGING_SNAPSHOT", "SEALED", true],
    ["PACKAGING_SNAPSHOT", "BLISTERED", false],
    ["PACKAGING_SNAPSHOT", "PACKAGED", false],
    ["PACKAGING_COMPLETE", "SEALED", true],
    ["PACKAGING_COMPLETE", "PACKAGED", false],
    ["BOTTLE_HANDPACK_COMPLETE", "STARTED", true],
    ["BOTTLE_HANDPACK_COMPLETE", "BLISTERED", false],
    ["BOTTLE_CAP_SEAL_COMPLETE", "BLISTERED", true],
    ["BOTTLE_CAP_SEAL_COMPLETE", "STARTED", false],
    ["BOTTLE_STICKER_COMPLETE", "SEALED", true],
    ["BOTTLE_STICKER_COMPLETE", "PACKAGED", false],
  ];
  for (const [eventType, stage, allowed] of cases) {
    it(`${eventType} from ${stage} → ${allowed ? "allowed" : "rejected"}`, () => {
      expect(
        checkStageProgression({ eventType, currentStage: stage }).allowed,
      ).toBe(allowed);
    });
  }
});

describe("stage progression — read-model lag", () => {
  it("permits the event when currentStage is null (server re-reads)", () => {
    expect(
      checkStageProgression({
        eventType: "BLISTER_COMPLETE",
        currentStage: null,
      }).allowed,
    ).toBe(true);
  });
});

describe("stage progression — non-progression events", () => {
  it("does not gate CARD_ASSIGNED or pause/resume events", () => {
    for (const eventType of [
      "CARD_ASSIGNED",
      "BAG_PAUSED",
      "BAG_RESUMED",
      "OPERATOR_CHANGE",
      "BAG_FINALIZED",
    ]) {
      expect(
        checkStageProgression({ eventType, currentStage: "BLISTERED" }).allowed,
      ).toBe(true);
    }
  });
});
