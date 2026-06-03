import { describe, expect, it } from "vitest";
import { assessRebuildSafety } from "./bag-finalization-void";

describe("assessRebuildSafety", () => {
  it("requires void correction when BAG_FINALIZED exists", () => {
    const r = assessRebuildSafety({
      events: [{ id: "f1", eventType: "BAG_FINALIZED", payload: {} }],
      bagFinalizedEventId: "f1",
      hasVoidCorrection: false,
      synthesizerSupportsVoid: true,
    });
    expect(r.requiresVoidCorrectionEvent).toBe(true);
    expect(r.survivesReadModelRebuild).toBe(false);
  });

  it("survives rebuild when void correction and synthesizer support exist", () => {
    const r = assessRebuildSafety({
      events: [
        { id: "f1", eventType: "BAG_FINALIZED", payload: {} },
        {
          eventType: "SUBMISSION_CORRECTED",
          payload: {
            correction_kind: "VOID_ERRONEOUS_BAG_FINALIZATION",
            corrected_event_id: "f1",
          },
        },
      ],
      bagFinalizedEventId: "f1",
      hasVoidCorrection: true,
      synthesizerSupportsVoid: true,
    });
    expect(r.survivesReadModelRebuild).toBe(true);
  });
});
