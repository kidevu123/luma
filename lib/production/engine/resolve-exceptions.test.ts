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

  // The three inverted checks each pass when their fact is FALSE. Setting
  // them one at a time is what catches a cross-wired inversion — e.g. the
  // paused check reading bagOnHold. A test that leaves all three at the
  // same default cannot distinguish them.
  it.each([
    ["bagOnHold", "hold", "BAG_ON_HOLD"],
    ["bagPaused", "paused", "BAG_PAUSED"],
    ["bagFinalized", "finalized", "BAG_FINALIZED"],
  ] as const)(
    "fails only the %s check when that fact alone is true",
    (factKey, checkId, code) => {
      const checks = evaluateChecks(facts({ [factKey]: true }));
      const failed = checks.filter((c) => !c.passed);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.id).toBe(checkId);
      expect(failed[0]?.blocker?.code).toBe(code);
    },
  );
});
