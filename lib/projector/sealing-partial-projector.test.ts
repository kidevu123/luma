import { describe, expect, it } from "vitest";
import { resolveStageForWorkflowEvent } from "./index";

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
});
