import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "blister-roll-segments.ts"), "utf8");

describe("BLISTER-PAUSE-COUNT-SNAPSHOT-1 · roll segment recorder contract", () => {
  it("emits ROLL_COUNTER_SEGMENT_RECORDED for active PVC/Foil rolls", () => {
    expect(src).toMatch(/ROLL_COUNTER_SEGMENT_RECORDED/);
    expect(src).toMatch(/PVC_ROLL/);
    expect(src).toMatch(/FOIL_ROLL/);
    expect(src).toMatch(/BLISTER_FOIL/);
  });

  it("skips roll segment emission for zero counts", () => {
    expect(src).toMatch(/counterSegment <= 0/);
    expect(src).toMatch(/segmentsRecorded: 0/);
  });

  it("records pause and shift-end segment reasons without touching commit paths", () => {
    expect(src).toMatch(/PAUSE_SNAPSHOT/);
    expect(src).toMatch(/SHIFT_END_SNAPSHOT/);
    expect(src).not.toMatch(/commit|apply|send/i);
  });

  it("uses one segment group and leaves client-event id in payload metadata", () => {
    expect(src).toMatch(/segment_group_id: segmentGroupId/);
    expect(src).toMatch(/form_client_event_id/);
    expect(src).toMatch(/withAccountabilityPayload/);
  });
});
