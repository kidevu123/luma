import { describe, it, expect } from "vitest";
import {
  intentToEventType,
  buildRecordStageEventInput,
  buildRecordPackagingCompleteInput,
} from "./advance";
import type { StationRow } from "./record-stage-event";

describe("intentToEventType", () => {
  it("maps COMPLETE at blister to BLISTER_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BLISTER", "BLISTER")).toBe("BLISTER_COMPLETE");
  });

  it("maps COMPLETE at heat seal to a segment, not a bag close", () => {
    expect(intentToEventType("COMPLETE", "HEAT_SEAL", "SEALING")).toBe(
      "SEALING_SEGMENT_COMPLETE",
    );
  });

  it("maps CONFIRM_BAG_EMPTY at heat seal to the bag-level close", () => {
    expect(intentToEventType("CONFIRM_BAG_EMPTY", "HEAT_SEAL", "SEALING")).toBe(
      "SEALING_COMPLETE",
    );
  });

  it("maps COMPLETE at packaging to PACKAGING_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "PACKAGING", "PACKAGING")).toBe(
      "PACKAGING_COMPLETE",
    );
  });

  it("maps COMPLETE at bottle fill to BOTTLE_HANDPACK_COMPLETE", () => {
    expect(intentToEventType("COMPLETE", "BOTTLE_FILL", "BOTTLE_HANDPACK")).toBe(
      "BOTTLE_HANDPACK_COMPLETE",
    );
  });

  it("maps CLAIM to BAG_PICKED_UP regardless of operation", () => {
    expect(intentToEventType("CLAIM", "HEAT_SEAL", "SEALING")).toBe("BAG_PICKED_UP");
    expect(intentToEventType("CLAIM", "PACKAGING", "PACKAGING")).toBe("BAG_PICKED_UP");
  });

  it("returns null for an operation with no event mapping", () => {
    expect(intentToEventType("COMPLETE", "POST_BLISTER_STAGING", "BLISTER")).toBeNull();
  });

  it("maps COMPLETE at a handpack-blister station to its own event, not the alias's", () => {
    expect(intentToEventType("COMPLETE", "BLISTER", "HANDPACK_BLISTER")).toBe(
      "HANDPACK_BLISTER_COMPLETE",
    );
  });

  it("leaves a COMBINED station on the aliased blister event", () => {
    // COMBINED also aliases to the BLISTER operation, but
    // ALLOWED_EVENTS_BY_KIND.COMBINED permits BLISTER_COMPLETE — only
    // HANDPACK_BLISTER needed the station-kind override.
    expect(intentToEventType("COMPLETE", "BLISTER", "COMBINED")).toBe("BLISTER_COMPLETE");
  });

  it("does not let the handpack override hijack a non-blister operation", () => {
    // A HANDPACK_BLISTER station can only resolve to the blister
    // operation today, but the override must not fabricate a blister
    // event for some other operation if that ever changes.
    expect(intentToEventType("COMPLETE", "PACKAGING", "HANDPACK_BLISTER")).toBe(
      "PACKAGING_COMPLETE",
    );
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

  it("carries counterPresses through to the record input", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counterPresses: 8 },
      clientEventId: "cid-1",
    });
    expect(out.counterPresses).toBe(8);
  });

  it("omits counterPresses entirely when the operator supplied none", () => {
    // recordStageEvent distinguishes `undefined` (refuse the seal) from a
    // number. Under exactOptionalPropertyTypes the key must be absent,
    // not present-and-undefined, so a non-sealing event never carries it.
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "PACKAGING_COMPLETE",
      inputs: { cases: 3 },
      clientEventId: "cid-1",
    });
    expect("counterPresses" in out).toBe(false);
  });

  it("keeps a zero press count rather than dropping it as falsy", () => {
    // Zero presses is a real reading (nothing sealed this segment); a
    // truthiness check here would turn it into "no counter supplied" and
    // the seal would be refused.
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counterPresses: 0 },
      clientEventId: "cid-1",
    });
    expect(out.counterPresses).toBe(0);
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

const PACKAGING_STATION = { id: "s2", label: "Packaging 1", kind: "PACKAGING" } as StationRow;

describe("buildRecordPackagingCompleteInput", () => {
  it("routes cases to masterCases", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 4 },
      clientEventId: "cid-1",
    });
    expect(out.masterCases).toBe(4);
  });

  it("routes displays to displaysMade", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { displays: 9 },
      clientEventId: "cid-1",
    });
    expect(out.displaysMade).toBe(9);
  });

  it("routes loose to looseCards", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { loose: 12 },
      clientEventId: "cid-1",
    });
    expect(out.looseCards).toBe(12);
  });

  it("routes the operator's damaged count to rippedCards, not damagedPackaging", () => {
    // 2026-08-13 decision: operator-counted damage is loose units (ripped
    // cards). Packaging-material damage is a separate exception-flow
    // concern this mapping never populates.
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { damaged: 3 },
      clientEventId: "cid-1",
    });
    expect(out.rippedCards).toBe(3);
  });

  it("always sends damagedPackaging as zero regardless of input", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { damaged: 3, cases: 1, displays: 2, loose: 5 },
      clientEventId: "cid-1",
    });
    expect(out.damagedPackaging).toBe(0);
  });

  it("zero-defaults every count when the operator supplied none", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: {},
      clientEventId: "cid-1",
    });
    expect(out.masterCases).toBe(0);
    expect(out.displaysMade).toBe(0);
    expect(out.looseCards).toBe(0);
    expect(out.rippedCards).toBe(0);
    expect(out.damagedPackaging).toBe(0);
  });

  it("carries the clientEventId through so the DB can dedupe a retry", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-pkg-1",
    });
    expect(out.clientEventId).toBe("cid-pkg-1");
  });

  it("does not yet carry a partial-close request (Task 3)", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-1",
    });
    expect(out.keepBagPartial).toBe(false);
    expect(out.partialRemainingEstimate).toBeNull();
  });
});
