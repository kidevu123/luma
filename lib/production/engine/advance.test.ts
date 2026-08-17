import { describe, it, expect } from "vitest";
import {
  intentToEventType,
  buildRecordStageEventInput,
  buildRecordPackagingCompleteInput,
  shouldAssignProductFirst,
  isPackagingShapedComplete,
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

  it("maps COMPLETE at a handpack-blister station to its own event via its own operation (migration 0074)", () => {
    // Migration 0074: HANDPACK_BLISTER has its own route_operations row, so
    // resolve-operation returns operationCode 'HANDPACK_BLISTER' (not 'BLISTER').
    // COMPLETE_EVENT_FOR_OPERATION['HANDPACK_BLISTER'] maps directly to
    // HANDPACK_BLISTER_COMPLETE — no station-kind override table needed.
    expect(intentToEventType("COMPLETE", "HANDPACK_BLISTER", "HANDPACK_BLISTER")).toBe(
      "HANDPACK_BLISTER_COMPLETE",
    );
  });

  it("leaves a COMBINED station on the aliased blister event", () => {
    // COMBINED aliases to the BLISTER operation (STATION_KIND_ALIAS still
    // has COMBINED -> BLISTER). ALLOWED_EVENTS_BY_KIND.COMBINED permits
    // BLISTER_COMPLETE, so no station-kind override is needed here.
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

  it("carries the picked product through as the sealing product guard", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counterPresses: 4 },
      clientEventId: "cid-1",
      productId: "prod-1",
    });
    expect(out.pickedSealingProductId).toBe("prod-1");
  });

  it("nulls the sealing product guard rather than dropping the key", () => {
    // recordStageEvent destructures pickedSealingProductId and compares
    // it to the bag's saved product; the field is required, not optional,
    // so an absent pick must arrive as an explicit null.
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "BLISTER_COMPLETE",
      inputs: { counter: 12 },
      clientEventId: "cid-1",
    });
    expect("pickedSealingProductId" in out).toBe(true);
    expect(out.pickedSealingProductId).toBeNull();
  });

  it("carries sealingCloseMode, partialCloseReason, partialCloseReasonNote, and overrideEmployeeCode through when supplied", () => {
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_COMPLETE",
      inputs: {},
      clientEventId: "cid-1",
      sealingCloseMode: "partial",
      partialCloseReason: "END_OF_SHIFT",
      partialCloseReasonNote: "line stopped early",
      overrideEmployeeCode: "EMP-42",
    });
    expect(out.sealingCloseMode).toBe("partial");
    expect(out.partialCloseReason).toBe("END_OF_SHIFT");
    expect(out.partialCloseReasonNote).toBe("line stopped early");
    expect(out.overrideEmployeeCode).toBe("EMP-42");
  });

  it("omits sealingCloseMode, partialCloseReason, partialCloseReasonNote, and overrideEmployeeCode when absent", () => {
    // exactOptionalPropertyTypes discipline, per the counterPresses
    // precedent: the key must not materialize as present-and-undefined.
    const out = buildRecordStageEventInput({
      station: STATION,
      workflowBagId: "bag-1",
      eventType: "SEALING_SEGMENT_COMPLETE",
      inputs: { counter: 1 },
      clientEventId: "cid-1",
    });
    expect("sealingCloseMode" in out).toBe(false);
    expect("partialCloseReason" in out).toBe(false);
    expect("partialCloseReasonNote" in out).toBe(false);
    expect("overrideEmployeeCode" in out).toBe(false);
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

  it("defaults keepBagPartial to false and partialRemainingEstimate to null when absent", () => {
    // REPLACES the Task 2 pin "does not yet carry a partial-close request":
    // Task 3 threads AdvanceInput.keepBagPartial / partialRemainingEstimate
    // through this mapper, so the gap that test pinned no longer exists —
    // this test now pins the unchanged DEFAULT when the caller supplies
    // neither field, not an inability to carry them.
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-1",
    });
    expect(out.keepBagPartial).toBe(false);
    expect(out.partialRemainingEstimate).toBeNull();
  });

  it("carries keepBagPartial and partialRemainingEstimate through when supplied", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-1",
      keepBagPartial: true,
      partialRemainingEstimate: 25,
    });
    expect(out.keepBagPartial).toBe(true);
    expect(out.partialRemainingEstimate).toBe(25);
  });

  it("carries overrideEmployeeCode through as operatorCode when supplied", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-1",
      overrideEmployeeCode: "EMP-42",
    });
    expect(out.operatorCode).toBe("EMP-42");
  });

  it("omits operatorCode when overrideEmployeeCode is absent", () => {
    const out = buildRecordPackagingCompleteInput({
      station: PACKAGING_STATION,
      workflowBagId: "bag-1",
      inputs: { cases: 1 },
      clientEventId: "cid-1",
    });
    expect("operatorCode" in out).toBe(false);
  });
});

describe("ASSIGN-PRODUCT-EXTRACT-1 · shouldAssignProductFirst", () => {
  it("assigns when an unmapped bag's gesture carries a pick at a sealing segment", () => {
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: "prod-1",
        eventType: "SEALING_SEGMENT_COMPLETE",
      }),
    ).toBe(true);
  });

  it("assigns at the bag-level sealing close too", () => {
    // recordStageEvent refuses an unmapped bag for SEALING_COMPLETE just as
    // it does for the segment, so both must be covered or the close is
    // rejected with SEALING_SAVE_PRODUCT_FIRST_ERROR.
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: "prod-1",
        eventType: "SEALING_COMPLETE",
      }),
    ).toBe(true);
  });

  it("never re-maps a bag that already carries a product", () => {
    // A disagreeing pick must reach recordStageEvent's guard and be
    // rejected (SEALING_PRODUCT_ALREADY_SAVED_ERROR) — silently re-mapping
    // would break the one-way product identity lock.
    expect(
      shouldAssignProductFirst({
        bagProductId: "prod-1",
        inputProductId: "prod-2",
        eventType: "SEALING_SEGMENT_COMPLETE",
      }),
    ).toBe(false);
  });

  it("does not assign when the gesture carries no pick", () => {
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: null,
        eventType: "SEALING_SEGMENT_COMPLETE",
      }),
    ).toBe(false);
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: undefined,
        eventType: "SEALING_SEGMENT_COMPLETE",
      }),
    ).toBe(false);
  });

  it("does not assign at a non-sealing event", () => {
    // Blister/handpack/bottle bags get their product at the first-op scan,
    // and packaging routes to recordPackagingComplete — neither is this
    // step's business.
    for (const eventType of [
      "BLISTER_COMPLETE",
      "HANDPACK_BLISTER_COMPLETE",
      "BOTTLE_HANDPACK_COMPLETE",
      "BOTTLE_STICKER_COMPLETE",
      "BOTTLE_CAP_SEAL_COMPLETE",
      "PACKAGING_COMPLETE",
      "BAG_PICKED_UP",
    ]) {
      expect(
        shouldAssignProductFirst({
          bagProductId: null,
          inputProductId: "prod-1",
          eventType,
        }),
      ).toBe(false);
    }
  });

  it("agrees with intentToEventType on which gestures reach it", () => {
    // Reachability, not source order: the events shouldAssignProductFirst
    // accepts must be events intentToEventType actually produces at a
    // sealing station, or the branch is dead code.
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: "prod-1",
        eventType: intentToEventType("COMPLETE", "HEAT_SEAL", "SEALING") ?? "",
      }),
    ).toBe(true);
    expect(
      shouldAssignProductFirst({
        bagProductId: null,
        inputProductId: "prod-1",
        eventType:
          intentToEventType("CONFIRM_BAG_EMPTY", "HEAT_SEAL", "SEALING") ?? "",
      }),
    ).toBe(true);
  });
});

describe("COMBINED-AT-PACKAGING-1 · isPackagingShapedComplete", () => {
  it("is true when a COMPLETE carries cases", () => {
    expect(isPackagingShapedComplete("COMPLETE", { cases: 5 })).toBe(true);
  });

  it("is true when a COMPLETE carries displays", () => {
    expect(isPackagingShapedComplete("COMPLETE", { displays: 2 })).toBe(true);
  });

  it("is true when a COMPLETE carries loose", () => {
    expect(isPackagingShapedComplete("COMPLETE", { loose: 1 })).toBe(true);
  });

  it("is true on an explicit 0 — presence, not truthiness", () => {
    // Mirrors buildRecordStageEventInput's counterPresses discipline: a
    // real reading of 0 (e.g. zero cases, all loose) must still mark the
    // gesture's shape, not be treated as "field absent".
    expect(isPackagingShapedComplete("COMPLETE", { cases: 0 })).toBe(true);
  });

  it("is false for a COMPLETE carrying only a blister/sealing counter", () => {
    expect(isPackagingShapedComplete("COMPLETE", { counter: 40 })).toBe(false);
    expect(
      isPackagingShapedComplete("COMPLETE", { counterPresses: 10 }),
    ).toBe(false);
  });

  it("is false for a COMPLETE with no inputs at all", () => {
    expect(isPackagingShapedComplete("COMPLETE", {})).toBe(false);
  });

  it("is false for every other intent even if inputs look packaging-shaped", () => {
    for (const intent of [
      "CLAIM",
      "CONFIRM_BAG_EMPTY",
      "RESOLVE_PARTIAL",
    ] as const) {
      expect(isPackagingShapedComplete(intent, { cases: 5 })).toBe(false);
    }
  });
});
