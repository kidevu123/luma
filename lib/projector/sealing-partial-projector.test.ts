import { describe, expect, it } from "vitest";
import { resolveStageForWorkflowEvent } from "./index";
import { buildPartialPackagingCompletePayload } from "@/lib/production/sealing-partial-closeout";

describe("resolveStageForWorkflowEvent — partial sealing close-out", () => {
  it("does not advance stage for partial SEALING_COMPLETE", () => {
    expect(
      resolveStageForWorkflowEvent("SEALING_COMPLETE", {
        partial_close: true,
        lane_close: false,
        sealed_partial_count: 12,
      }),
    ).toBeUndefined();
  });

  it("advances to SEALED for whole-bag lane close", () => {
    expect(
      resolveStageForWorkflowEvent("SEALING_COMPLETE", { lane_close: true }),
    ).toBe("SEALED");
  });

  it("does not advance stage for partial PACKAGING_COMPLETE", () => {
    expect(
      resolveStageForWorkflowEvent(
        "PACKAGING_COMPLETE",
        buildPartialPackagingCompletePayload({
          masterCases: 0,
          displaysMade: 1,
          looseCards: 0,
          damagedPackaging: 0,
          rippedCards: 0,
          sealedPartialCount: 12,
        }),
      ),
    ).toBeUndefined();
  });

  it("advances to PACKAGED for whole-bag PACKAGING_COMPLETE", () => {
    expect(
      resolveStageForWorkflowEvent("PACKAGING_COMPLETE", { master_cases: 1 }),
    ).toBe("PACKAGED");
  });
});
