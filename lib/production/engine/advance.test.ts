import { describe, it, expect } from "vitest";
import { intentToEventType, buildRecordStageEventInput } from "./advance";
import type { StationRow } from "./record-stage-event";

describe("intentToEventType", () => {
  it("maps COMPLETE at blister to BLISTER_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BLISTER")).toBe("BLISTER_COMPLETE");
  });

  it("maps COMPLETE at heat seal to a segment, not a bag close", () => {
    expect(intentToEventType("COMPLETE", "HEAT_SEAL")).toBe("SEALING_SEGMENT_COMPLETE");
  });

  it("maps CONFIRM_BAG_EMPTY at heat seal to the bag-level close", () => {
    expect(intentToEventType("CONFIRM_BAG_EMPTY", "HEAT_SEAL")).toBe("SEALING_COMPLETE");
  });

  it("maps COMPLETE at packaging to PACKAGING_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "PACKAGING")).toBe("PACKAGING_COMPLETE");
  });

  it("maps COMPLETE at bottle fill to BOTTLE_HANDPACK_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BOTTLE_FILL")).toBe("BOTTLE_HANDPACK_COMPLETE");
  });

  it("maps CLAIM to BAG_PICKED_UP regardless of operation", () => {
    expect(intentToEventType("CLAIM", "HEAT_SEAL")).toBe("BAG_PICKED_UP");
    expect(intentToEventType("CLAIM", "PACKAGING")).toBe("BAG_PICKED_UP");
  });

  it("returns null for an operation with no event mapping", () => {
    expect(intentToEventType("COMPLETE", "POST_BLISTER_STAGING")).toBeNull();
  });
});

const STATION = { id: "s1", label: "Sealing 2", kind: "SEALING" } as StationRow;

describe("buildRecordStageEventInput", () => {
  it("routes a counter reading to countTotal", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 52 },
      clientEventId: "cid-1",
    });
    expect(out.countTotal).toBe(52);
  });

  it("falls back to the packaging case count when there is no counter", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "PACKAGING_COMPLETE",
      inputs: { cases: 7 },
      clientEventId: "cid-1",
    });
    expect(out.countTotal).toBe(7);
  });

  it("prefers the counter over cases when both are present", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 52, cases: 7 },
      clientEventId: "cid-1",
    });
    expect(out.countTotal).toBe(52);
  });

  it("sends zero rather than undefined when no count is supplied", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "BAG_PICKED_UP",
      inputs: {},
      clientEventId: "cid-1",
    });
    expect(out.countTotal).toBe(0);
  });

  it("carries the clientEventId through so the DB can dedupe a retry", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 1 },
      clientEventId: "cid-abc",
    });
    expect(out.clientEventId).toBe("cid-abc");
  });

  it("does not silently invent a sealing product", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 1 },
      clientEventId: "cid-1",
    });
    expect(out.pickedSealingProductId).toBeNull();
  });
});
