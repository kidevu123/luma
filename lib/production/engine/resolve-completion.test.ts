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
    orderIndependentGroup: null,
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

  it("asks packaging for cases, displays, loose units, and damaged packaging (2026-08-17)", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "PACKAGING", allowedStationKind: "PACKAGING", outputUnit: "cases" }),
    );
    const keys = inputs.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["cases", "displays", "loose", "damagedPackaging"]));
    const dp = inputs.find((i) => i.key === "damagedPackaging");
    expect(dp).toBeDefined();
    expect(dp?.required).toBe(false);
    expect(dp?.unit).toBe("units");
  });

  it("always offers an optional damaged count", () => {
    const damaged = resolveCompletionInputs(op({})).find((i) => i.key === "damaged");
    expect(damaged).toBeDefined();
    expect(damaged?.required).toBe(false);
  });

  it("labels inputs in plain language with no stage or event names", () => {
    const inputs = resolveCompletionInputs(op({}));
    // Guard: without this the loop below would pass vacuously if the
    // function ever regressed to returning an empty array.
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.label).not.toMatch(/_COMPLETE|QUEUE|STAGE/);
    }
  });

  it("labels the damaged count in units at packaging (2026-08-13 decision)", () => {
    // P4a Task 2: packaging counts cases, displays and loose units, but
    // damage is a single field always counted in loose units — replaces
    // the P1-era "deliberately unitless" placeholder now that the floor
    // decision is in.
    const inputs = resolveCompletionInputs(
      op({ operationCode: "PACKAGING", allowedStationKind: "PACKAGING", outputUnit: "cases" }),
    );
    expect(inputs.find((i) => i.key === "damaged")?.unit).toBe("units");
  });

  it("omits damaged entirely for an operation with no output", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "POST_BLISTER_STAGING", requiresCounter: false, outputUnit: null }),
    );
    expect(inputs).toEqual([]);
  });
});

describe("resolveCompletionInputs · the sealing machine counter (P4b Task 5)", () => {
  const sealOp = op({
    operationCode: "HEAT_SEAL",
    allowedStationKind: "SEALING",
    requiresCounter: true,
    outputUnit: "cards",
  });

  it("asks for counter PRESSES at a station that carries the sealing counter", () => {
    // recordStageEvent refuses a sealing segment whose counterPresses is
    // undefined (SEALING_COUNTER_PRESS_ERROR) and derives the card count
    // itself. Asking for `counter` here would make every sealing DONE a
    // refusal — the gap this closes.
    const inputs = resolveCompletionInputs(sealOp, { stationKind: "SEALING" });
    const keys = inputs.map((i) => i.key);
    expect(keys).toContain("counterPresses");
    expect(keys).not.toContain("counter");
    expect(inputs.find((i) => i.key === "counterPresses")?.required).toBe(true);
  });

  it("labels the presses field in presses, not in the operation's cards", () => {
    const inputs = resolveCompletionInputs(sealOp, { stationKind: "SEALING" });
    expect(inputs.find((i) => i.key === "counterPresses")?.unit).toBe("presses");
    // Damage is still counted in the operation's own output unit.
    expect(inputs.find((i) => i.key === "damaged")?.unit).toBe("cards");
  });

  it("covers COMBINED too — stationUsesSealingCounter is the rule, not a SEALING literal", () => {
    const inputs = resolveCompletionInputs(sealOp, { stationKind: "COMBINED" });
    expect(inputs.map((i) => i.key)).toContain("counterPresses");
  });

  it("keeps the plain counter where the machine counter does not apply", () => {
    // No station kind supplied (a caller that has not been rewired) and
    // a station kind that does not carry the counter both fall back to
    // the generic field rather than silently demanding presses.
    expect(resolveCompletionInputs(sealOp).map((i) => i.key)).toContain("counter");
    expect(
      resolveCompletionInputs(sealOp, { stationKind: "HANDPACK_BLISTER" }).map(
        (i) => i.key,
      ),
    ).toContain("counter");
  });

  it("never asks for presses at a non-sealing operation", () => {
    const inputs = resolveCompletionInputs(
      op({ operationCode: "BLISTER", allowedStationKind: "BLISTER", outputUnit: "cards" }),
      { stationKind: "COMBINED" },
    );
    expect(inputs.map((i) => i.key)).not.toContain("counterPresses");
  });
});
