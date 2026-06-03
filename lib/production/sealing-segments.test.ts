import { describe, expect, it } from "vitest";
import {
  deriveSealingSegmentProgress,
  readSealingSegmentCount,
  SEALING_SEGMENT_EVENT,
  needsSealingLaneClose,
} from "./sealing-segments";
import {
  checkStageProgression,
  EVENT_STAGE_PREREQ,
} from "./stage-progression";

describe("SEALING_SEGMENT_EVENT", () => {
  it("is registered in EVENT_STAGE_PREREQ", () => {
    expect(EVENT_STAGE_PREREQ[SEALING_SEGMENT_EVENT]).toEqual(["BLISTERED"]);
  });

  it("allows segment from BLISTERED", () => {
    expect(
      checkStageProgression({
        eventType: SEALING_SEGMENT_EVENT,
        currentStage: "BLISTERED",
      }).allowed,
    ).toBe(true);
  });

  it("rejects segment from SEALED", () => {
    const r = checkStageProgression({
      eventType: SEALING_SEGMENT_EVENT,
      currentStage: "SEALED",
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toContain("SEALING_SEGMENT_COMPLETE");
    }
  });

  it("SEALING_COMPLETE still rejects SEALED", () => {
    expect(
      checkStageProgression({
        eventType: "SEALING_COMPLETE",
        currentStage: "SEALED",
      }).allowed,
    ).toBe(false);
  });
});

describe("needsSealingLaneClose", () => {
  it("is true for BLISTERED bags with at least one segment", () => {
    expect(
      needsSealingLaneClose({ stage: "BLISTERED", segmentCount: 1 }),
    ).toBe(true);
  });

  it("is false when lane-close already advanced stage", () => {
    expect(
      needsSealingLaneClose({ stage: "SEALED", segmentCount: 2 }),
    ).toBe(false);
  });

  it("is false before any segment exists", () => {
    expect(
      needsSealingLaneClose({ stage: "BLISTERED", segmentCount: 0 }),
    ).toBe(false);
  });

  it("is false after partial sealing close-out", () => {
    expect(
      needsSealingLaneClose({
        stage: "BLISTERED",
        segmentCount: 2,
        hasPartialSealingCloseout: true,
      }),
    ).toBe(false);
  });
});

describe("deriveSealingSegmentProgress", () => {
  it("sums segment counts across stations", () => {
    const progress = deriveSealingSegmentProgress([
      {
        eventType: SEALING_SEGMENT_EVENT,
        stationId: "a",
        payload: { count_total: 120 },
      },
      {
        eventType: SEALING_SEGMENT_EVENT,
        stationId: "b",
        payload: { count_total: 80 },
      },
      { eventType: "SEALING_COMPLETE", payload: { lane_close: true } },
    ]);
    expect(progress.segmentCount).toBe(2);
    expect(progress.stationCount).toBe(2);
    expect(progress.cardsTotal).toBe(200);
  });
});

describe("readSealingSegmentCount", () => {
  it("reads count_total from payload", () => {
    expect(readSealingSegmentCount({ count_total: 58 })).toBe(58);
  });
});

describe("migration 0048", () => {
  it("SQL adds SEALING_SEGMENT_COMPLETE enum value", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sql = await fs.readFile(
      path.resolve(import.meta.dirname, "../../drizzle/0048_sealing_segment_complete_event.sql"),
      "utf-8",
    );
    expect(sql).toContain("SEALING_SEGMENT_COMPLETE");
    expect(sql).not.toContain("CREATE TABLE");
  });
});
