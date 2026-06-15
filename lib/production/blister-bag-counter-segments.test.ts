import { describe, it, expect } from "vitest";
import {
  labelBlisterCounterSegmentReason,
  sumBlisterBagCounterSegments,
  type BlisterBagCounterSegment,
} from "./blister-bag-counter-segments-contract";

describe("blister bag counter segments helpers", () => {
  it("labels known segment reasons for operators", () => {
    expect(labelBlisterCounterSegmentReason("ROLL_CHANGE")).toBe("Roll change");
    expect(labelBlisterCounterSegmentReason("BAG_COMPLETE")).toBe("Bag complete");
  });

  it("sums PVC segments into full bag blister total", () => {
    const segments: BlisterBagCounterSegment[] = [
      {
        occurredAt: new Date("2026-06-10T12:11:30Z"),
        segmentCount: 1630,
        segmentReason: "ROLL_CHANGE",
        segmentLabel: "Roll change",
        rollNumber: "PVC-16",
        bagSegmentSequence: 1,
      },
      {
        occurredAt: new Date("2026-06-10T13:12:00Z"),
        segmentCount: 856,
        segmentReason: "BAG_COMPLETE",
        segmentLabel: "Bag complete",
        rollNumber: "PVC-17",
        bagSegmentSequence: 2,
      },
    ];
    expect(sumBlisterBagCounterSegments(segments)).toBe(2486);
  });
});
