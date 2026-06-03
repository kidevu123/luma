import { describe, expect, it } from "vitest";
import {
  buildPartialPackagingCompletePayload,
  buildPartialSealingClosePayload,
  deriveSealedPartialCountFromSegments,
  hasFullSealingLaneClose,
  hasPartialPackagingComplete,
  hasPartialSealingCloseout,
  isPartialPackagingPayload,
  isPartialSealingClosePayload,
  isWorkflowBagResumableAtSealingAfterPartialPackaging,
  shouldEmitPartialPackagingComplete,
  validateSealingPartialCloseInput,
} from "./sealing-partial-closeout";

describe("sealing partial close-out helpers", () => {
  it("detects partial_close payload", () => {
    expect(isPartialSealingClosePayload({ partial_close: true })).toBe(true);
    expect(isPartialSealingClosePayload({ lane_close: true })).toBe(false);
  });

  it("sums segment counts for sealed partial count", () => {
    const n = deriveSealedPartialCountFromSegments([
      { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 12 } },
      { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 8 } },
    ]);
    expect(n).toBe(20);
  });

  it("rejects partial close with zero segments", () => {
    const r = validateSealingPartialCloseInput({
      events: [],
      reason: "END_OF_SHIFT",
      reasonNote: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one sealing segment before submitting a partial bag/i);
  });

  it("requires reason and note for OTHER", () => {
    const r = validateSealingPartialCloseInput({
      events: [
        { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 5 } },
      ],
      reason: "OTHER",
      reasonNote: "  ",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/note/i);
  });

  it("accepts valid partial close input", () => {
    const r = validateSealingPartialCloseInput({
      events: [
        { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 15 } },
      ],
      reason: "HANDOFF",
      reasonNote: null,
    });
    expect(r).toEqual({ ok: true, sealedPartialCount: 15, reason: "HANDOFF" });
  });

  it("buildPartialSealingClosePayload is durable and queryable", () => {
    const p = buildPartialSealingClosePayload({
      sealedPartialCount: 40,
      reason: "OTHER",
      reasonNote: "Foil jam",
    });
    expect(p.partial_close).toBe(true);
    expect(p.lane_close).toBe(false);
    expect(p.sealed_partial_count).toBe(40);
    expect(p.partial_close_reason).toBe("OTHER");
    expect(p.partial_close_reason_note).toBe("Foil jam");
  });

  it("hasPartialSealingCloseout finds prior partial close event", () => {
    expect(
      hasPartialSealingCloseout([
        { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 1 } },
        {
          eventType: "SEALING_COMPLETE",
          payload: buildPartialSealingClosePayload({
            sealedPartialCount: 1,
            reason: "TIME_LIMIT",
          }),
        },
      ]),
    ).toBe(true);
  });

  const partialPathEvents = [
    { eventType: "SEALING_SEGMENT_COMPLETE", payload: { count_total: 12 } },
    {
      eventType: "SEALING_COMPLETE",
      payload: buildPartialSealingClosePayload({
        sealedPartialCount: 12,
        reason: "END_OF_SHIFT",
      }),
    },
    {
      eventType: "PACKAGING_COMPLETE",
      payload: buildPartialPackagingCompletePayload({
        masterCases: 0,
        displaysMade: 1,
        looseCards: 0,
        damagedPackaging: 0,
        rippedCards: 0,
        sealedPartialCount: 12,
      }),
    },
  ] as const;

  it("shouldEmitPartialPackagingComplete when partial close without whole lane close", () => {
    expect(shouldEmitPartialPackagingComplete(partialPathEvents)).toBe(true);
    expect(
      shouldEmitPartialPackagingComplete([
        ...partialPathEvents,
        { eventType: "SEALING_COMPLETE", payload: { lane_close: true } },
      ]),
    ).toBe(false);
  });

  it("buildPartialPackagingCompletePayload is durable and queryable", () => {
    const p = buildPartialPackagingCompletePayload({
      masterCases: 0,
      displaysMade: 2,
      looseCards: 3,
      damagedPackaging: 0,
      rippedCards: 0,
      sealedPartialCount: 40,
    });
    expect(p.partial_packaging).toBe(true);
    expect(p.packaged_partial_count).toBe(5);
    expect(p.sealed_partial_count_at_pack).toBe(40);
  });

  it("isWorkflowBagResumableAtSealingAfterPartialPackaging for partial path only", () => {
    expect(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(partialPathEvents, {
        stage: "BLISTERED",
        isFinalized: false,
      }),
    ).toBe(true);
    expect(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(partialPathEvents, {
        stage: "PACKAGED",
        isFinalized: false,
      }),
    ).toBe(true);
    expect(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(
        [{ eventType: "PACKAGING_COMPLETE", payload: { partial_packaging: false } }],
        { stage: "PACKAGED", isFinalized: false },
      ),
    ).toBe(false);
    expect(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(partialPathEvents, {
        stage: "BLISTERED",
        isFinalized: true,
      }),
    ).toBe(false);
  });

  it("whole-bag terminal packaging is not resumable at sealing", () => {
    const wholeBagEvents = [
      { eventType: "SEALING_COMPLETE", payload: { lane_close: true } },
      { eventType: "PACKAGING_COMPLETE", payload: { master_cases: 1 } },
    ];
    expect(hasFullSealingLaneClose(wholeBagEvents)).toBe(true);
    expect(hasPartialPackagingComplete(wholeBagEvents)).toBe(false);
    expect(
      isWorkflowBagResumableAtSealingAfterPartialPackaging(wholeBagEvents, {
        stage: "PACKAGED",
        isFinalized: false,
      }),
    ).toBe(false);
  });

  it("isPartialPackagingPayload detects partial_packaging flag", () => {
    expect(isPartialPackagingPayload({ partial_packaging: true })).toBe(true);
    expect(isPartialPackagingPayload({ master_cases: 1 })).toBe(false);
  });
});
