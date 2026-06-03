import { describe, expect, it } from "vitest";
import {
  buildPartialSealingClosePayload,
  deriveSealedPartialCountFromSegments,
  hasPartialSealingCloseout,
  isPartialSealingClosePayload,
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
});
