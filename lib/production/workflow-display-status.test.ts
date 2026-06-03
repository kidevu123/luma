import { describe, expect, it } from "vitest";
import { deriveWorkflowDisplayStatus } from "./workflow-display-status";

const BAG_104_EVENTS = [
  {
    eventType: "SEALING_COMPLETE",
    payload: {
      partial_close: true,
      lane_close: false,
      sealed_partial_count: 1656,
    },
  },
  {
    eventType: "PACKAGING_COMPLETE",
    payload: { master_cases: 3, displays_made: 11, loose_cards: 14 },
  },
  {
    eventType: "BAG_FINALIZED",
    payload: {},
    id: "a807600a-53db-4852-9e2e-0dd8e78b01b7",
  },
  {
    eventType: "SUBMISSION_CORRECTED",
    payload: {
      correction_kind: "VOID_ERRONEOUS_BAG_FINALIZATION",
      corrected_event_id: "a807600a-53db-4852-9e2e-0dd8e78b01b7",
    },
  },
] as const;

describe("deriveWorkflowDisplayStatus", () => {
  it("shows PARTIAL for legacy voided partial at BLISTERED", () => {
    const status = deriveWorkflowDisplayStatus({
      readStage: "BLISTERED",
      isFinalized: false,
      isPaused: false,
      events: BAG_104_EVENTS,
    });
    expect(status.badgeLabel).toBe("PARTIAL");
    expect(status.badgeKey).toBe("PARTIAL");
    expect(status.helpText).toMatch(/Legacy partial/);
    expect(status.helpText).toMatch(/Inventory still needs review/);
  });

  it("shows BLISTERED for normal blistered workflow without partial packaging", () => {
    const status = deriveWorkflowDisplayStatus({
      readStage: "BLISTERED",
      isFinalized: false,
      isPaused: false,
      events: [{ eventType: "BLISTER_COMPLETE", payload: { count_total: 100 } }],
    });
    expect(status.badgeLabel).toBe("BLISTERED");
  });

  it("shows FINALIZED for finalized workflow", () => {
    const status = deriveWorkflowDisplayStatus({
      readStage: "FINALIZED",
      isFinalized: true,
      isPaused: false,
      events: [
        { eventType: "SEALING_COMPLETE", payload: { count_total: 100 } },
        { eventType: "BAG_FINALIZED", payload: {} },
      ],
    });
    expect(status.badgeLabel).toBe("FINALIZED");
  });

  it("shows PARTIAL for fresh partial-packaged resumable workflow", () => {
    const status = deriveWorkflowDisplayStatus({
      readStage: "BLISTERED",
      isFinalized: false,
      isPaused: false,
      events: [
        {
          eventType: "SEALING_COMPLETE",
          payload: { partial_close: true, lane_close: false, sealed_partial_count: 500 },
        },
        {
          eventType: "PACKAGING_COMPLETE",
          payload: { partial_packaging: true },
        },
      ],
    });
    expect(status.badgeLabel).toBe("PARTIAL");
    expect(status.helpText).toMatch(/Partial:/);
  });

  it("prefers PAUSED over PARTIAL", () => {
    const status = deriveWorkflowDisplayStatus({
      readStage: "BLISTERED",
      isFinalized: false,
      isPaused: true,
      events: BAG_104_EVENTS,
    });
    expect(status.badgeLabel).toBe("PAUSED");
  });
});
