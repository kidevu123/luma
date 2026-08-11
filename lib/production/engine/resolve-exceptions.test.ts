import { describe, it, expect } from "vitest";
import {
  evaluateChecks,
  blockersFromChecks,
  type EngineFacts,
} from "./resolve-exceptions";

function facts(over: Partial<EngineFacts> = {}): EngineFacts {
  return {
    bagRecognized: true,
    productResolved: true,
    operationResolved: true,
    materialsAvailable: true,
    upstreamStageComplete: true,
    bagPaused: false,
    bagFinalized: false,
    bagOnHold: false,
    waitingForLabel: null,
    ...over,
  };
}

describe("evaluateChecks", () => {
  it("passes every check when nothing is wrong", () => {
    const checks = evaluateChecks(facts());
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(blockersFromChecks(checks)).toEqual([]);
  });

  it("reports the checks in a stable diagnostic order", () => {
    expect(evaluateChecks(facts()).map((c) => c.id)).toEqual([
      "bag",
      "product",
      "operation",
      "materials",
      "upstream",
      "hold",
      "paused",
      "finalized",
    ]);
  });

  it("fails the upstream check and names where the bag is waiting", () => {
    const checks = evaluateChecks(
      facts({ upstreamStageComplete: false, waitingForLabel: "Sealing at Station 3" }),
    );
    const upstream = checks.find((c) => c.id === "upstream");
    expect(upstream?.passed).toBe(false);
    expect(upstream?.blocker?.operatorSentence).toContain("Sealing at Station 3");
    expect(upstream?.blocker?.suggestedAction).toBe("WAIT_UPSTREAM");
  });

  it("tells the operator to ask a supervisor when product mapping is missing", () => {
    const blockers = blockersFromChecks(evaluateChecks(facts({ productResolved: false })));
    expect(blockers[0]?.code).toBe("PRODUCT_UNRESOLVED");
    expect(blockers[0]?.suggestedAction).toBe("NOTIFY_SUPERVISOR");
  });

  it("keeps stage names and event names out of operator sentences", () => {
    const blockers = blockersFromChecks(
      evaluateChecks(
        facts({
          productResolved: false,
          materialsAvailable: false,
          upstreamStageComplete: false,
          waitingForLabel: "Sealing at Station 3",
        }),
      ),
    );
    expect(blockers.length).toBeGreaterThan(0);
    for (const b of blockers) {
      expect(b.operatorSentence).not.toMatch(/BLISTERED|SEALED|_COMPLETE|QUEUE/);
    }
  });

  it("still exposes the real reason to supervisors", () => {
    const blockers = blockersFromChecks(evaluateChecks(facts({ operationResolved: false })));
    expect(blockers[0]?.supervisorDetail).toContain("route");
  });
});
