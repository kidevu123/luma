import { describe, it, expect } from "vitest";
import { resolveCompletionInputs } from "./resolve-completion";
import type { RouteOperationView } from "@/lib/production/routes";

function op(over: Partial<RouteOperationView>): RouteOperationView {
  return {
    routeCode: "CARD_BLISTER",
    routeName: "Card blister",
    sequence: 2,
    operationCode: "BLISTER",
    operationName: "Blister",
    stageKey: "BLISTER_QUEUE",
    nextStageKey: "POST_BLISTER_STAGING",
    reworkStageKey: null,
    allowedStationKind: "BLISTER",
    allowedMachineKind: "BLISTER",
    requiresScan: true,
    requiresCounter: true,
    requiresTimer: true,
    outputUnit: "cards",
    ...over,
  };
}

describe("resolveCompletionInputs", () => {
  it("asks for a counter when the operation requires one", () => {
    const inputs = resolveCompletionInputs(op({ requiresCounter: true }));
    const counter = inputs.find((i) => i.key === "counter");
    expect(counter).toBeDefined();
    expect(counter?.required).toBe(true);
    expect(counter?.unit).toBe("cards");
  });

  it("asks for nothing countable when the operation requires no counter", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "POST_BLISTER_STAGING", requiresCounter: false, outputUnit: null }),
    );
    expect(inputs.find((i) => i.key === "counter")).toBeUndefined();
  });

  it("asks packaging for cases, displays and loose units", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "PACKAGING", allowedStationKind: "PACKAGING", outputUnit: "cases" }),
    );
    expect(inputs.map((i) => i.key)).toEqual(
      expect.arrayContaining(["cases", "displays", "loose"]),
    );
  });

  it("always offers an optional damaged count", () => {
    const damaged = resolveCompletionInputs(op({})).find((i) => i.key === "damaged");
    expect(damaged).toBeDefined();
    expect(damaged?.required).toBe(false);
  });

  it("labels inputs in plain language with no stage or event names", () => {
    for (const input of resolveCompletionInputs(op({}))) {
      expect(input.label).not.toMatch(/_COMPLETE|QUEUE|STAGE/);
    }
  });
});
