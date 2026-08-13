import { describe, it, expect } from "vitest";
import {
  assembleCompletionInputs,
  autoProductSubmission,
  completionFieldLabel,
  helpChecklistForView,
  helpIdleNote,
  helpNotifyDetail,
  EXCEPTION_DETAIL_MAX_LENGTH,
  operatorMaterialLinks,
  operatorPauseModel,
  partialScreenFor,
  pauseNeedsCounterSnapshot,
  primaryBlockerSentence,
  progressPercent,
  REPORT_PROBLEM_CATEGORY_LAYOUT,
  reportProblemCategoryDisabled,
  reportProblemRouteFor,
  shouldSubmitAutoProduct,
  upNextSummary,
} from "./operator-screen-model";
import { blockerFor } from "./resolve-exceptions";
import type { CompletionInput, NextAction, StationView } from "./types";

function view(over: Partial<StationView> = {}): StationView {
  return {
    station: { id: "s1", label: "SEALING 2", kind: "SEALING", machineName: null },
    operator: { sessionId: "sess1", name: "Ana" },
    supervisor: null,
    current: {
      workflowBagId: "bag1",
      bagLabel: "PO 1234 - Chocolate Brown - Bag 12",
      bagSubLabel: "bag-card-117",
      productName: "Chocolate Brown Card",
      statusLine: "Ready to seal",
      progress: null,
    },
    upNext: [],
    nextAction: { kind: "COMPLETE", label: "Seal complete", inputs: [] },
    capabilities: { canPause: true, canReportProblem: true },
    ...over,
  };
}

describe("autoProductSubmission / shouldSubmitAutoProduct", () => {
  it("submits nothing when the operator has a real choice", () => {
    const action: NextAction = {
      kind: "PICK_PRODUCT",
      options: [
        { productId: "p1", name: "A", sku: "A-1" },
        { productId: "p2", name: "B", sku: "B-1" },
      ],
    };
    expect(autoProductSubmission(view({ nextAction: action }))).toBeNull();
  });

  it("submits the only option without asking", () => {
    const action: NextAction = {
      kind: "PICK_PRODUCT",
      options: [{ productId: "p1", name: "A", sku: "A-1" }],
    };
    const auto = autoProductSubmission(view({ nextAction: action }));
    expect(auto).toEqual({ productId: "p1", key: "bag1:p1" });
  });

  it("returns null for every other next action", () => {
    expect(autoProductSubmission(view())).toBeNull();
    expect(
      autoProductSubmission(view({ nextAction: { kind: "OPEN_SHIFT" } })),
    ).toBeNull();
  });

  it("keys the attempt by bag AND product so a new bag gets a fresh attempt", () => {
    const action: NextAction = {
      kind: "PICK_PRODUCT",
      options: [{ productId: "p1", name: "A", sku: "A-1" }],
    };
    const first = autoProductSubmission(view({ nextAction: action }));
    const second = autoProductSubmission(
      view({
        nextAction: action,
        current: { ...view().current!, workflowBagId: "bag2" },
      }),
    );
    expect(first?.key).not.toEqual(second?.key);
  });

  it("submits once and refuses to retry the same key (the loop guard)", () => {
    const auto = { productId: "p1", key: "bag1:p1" };
    expect(shouldSubmitAutoProduct(auto, null)).toBe(true);
    expect(shouldSubmitAutoProduct(auto, "bag1:p1")).toBe(false);
    // A different bag with the same product is a new gesture, not a retry.
    expect(shouldSubmitAutoProduct({ productId: "p1", key: "bag2:p1" }, "bag1:p1")).toBe(
      true,
    );
    expect(shouldSubmitAutoProduct(null, null)).toBe(false);
  });
});

describe("assembleCompletionInputs", () => {
  const counter: CompletionInput = {
    key: "counter",
    label: "Counter",
    unit: "cards",
    required: true,
  };
  const damaged: CompletionInput = {
    key: "damaged",
    label: "Damaged",
    unit: "cards",
    required: false,
  };

  it("parses the fields the engine asked for", () => {
    const r = assembleCompletionInputs([counter, damaged], {
      counter: "52",
      damaged: "2",
    });
    expect(r).toEqual({ ok: true, inputs: { counter: 52, damaged: 2 } });
  });

  it("keeps an explicit zero", () => {
    const r = assembleCompletionInputs([counter], { counter: "0" });
    expect(r).toEqual({ ok: true, inputs: { counter: 0 } });
  });

  it("leaves an unfilled optional key ABSENT, not undefined", () => {
    const r = assembleCompletionInputs([counter, damaged], { counter: "5" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.inputs)).toEqual(["counter"]);
  });

  it("refuses a missing required field with an operator sentence", () => {
    const r = assembleCompletionInputs([counter], { counter: "  " });
    expect(r).toEqual({
      ok: false,
      message: "Enter counter before finishing.",
    });
  });

  it("refuses a non-integer", () => {
    const r = assembleCompletionInputs([counter], { counter: "12.5" });
    expect(r).toEqual({ ok: false, message: "Counter must be a whole number." });
  });

  it("drops values for fields this operation did not ask for", () => {
    // Stale `cases` would re-route a COMBINED station's gesture to
    // PACKAGING via isPackagingShapedComplete.
    const r = assembleCompletionInputs([counter], { counter: "5", cases: "9" });
    expect(r).toEqual({ ok: true, inputs: { counter: 5 } });
  });

  it("assembles the three packaging counts", () => {
    const packaging: CompletionInput[] = [
      { key: "cases", label: "Cases", unit: "cases", required: true },
      { key: "displays", label: "Displays", unit: "displays", required: false },
      { key: "loose", label: "Loose units", unit: "units", required: false },
    ];
    const r = assembleCompletionInputs(packaging, {
      cases: "10",
      displays: "3",
      loose: "7",
    });
    expect(r).toEqual({ ok: true, inputs: { cases: 10, displays: 3, loose: 7 } });
  });
});

describe("completionFieldLabel", () => {
  it("appends the unit when there is one", () => {
    expect(
      completionFieldLabel({ key: "cases", label: "Cases", unit: "cases", required: true }),
    ).toBe("Cases (cases)");
  });
  it("renders bare when the engine gives no unit", () => {
    expect(
      completionFieldLabel({ key: "counter", label: "Counter", unit: null, required: true }),
    ).toBe("Counter");
  });
});

describe("partialScreenFor", () => {
  it("offers [ Use bag ] on a confident estimate", () => {
    expect(
      partialScreenFor({ kind: "RESOLVE_PARTIAL", estimate: 1240, needsEntry: false }),
    ).toEqual({ mode: "USE_ESTIMATE", estimate: 1240 });
  });

  it("asks for a physical count when the engine says entry is needed", () => {
    expect(
      partialScreenFor({ kind: "RESOLVE_PARTIAL", estimate: 1240, needsEntry: true }),
    ).toEqual({ mode: "ENTER_QUANTITY" });
  });

  it("asks rather than offering a number Luma does not have", () => {
    expect(
      partialScreenFor({ kind: "RESOLVE_PARTIAL", estimate: null, needsEntry: false }),
    ).toEqual({ mode: "ENTER_QUANTITY" });
  });

  it("is null for any other action", () => {
    expect(partialScreenFor({ kind: "OPEN_SHIFT" })).toBeNull();
  });
});

describe("helpChecklistForView", () => {
  it("shows every row passing when nothing blocks the work", () => {
    const checks = helpChecklistForView(view());
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checks.map((c) => c.id)).toEqual([
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

  it("fails exactly the rows the view's blockers name", () => {
    const checks = helpChecklistForView(
      view({
        nextAction: { kind: "BLOCKED", blockers: [blockerFor("BAG_PAUSED")] },
      }),
    );
    const failed = checks.filter((c) => !c.passed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe("paused");
    expect(failed[0]?.blocker?.operatorSentence).toBe(
      blockerFor("BAG_PAUSED").operatorSentence,
    );
  });

  it("cannot disagree with the button: the same sentence appears in both", () => {
    const blocker = blockerFor("BAG_ON_HOLD");
    const v = view({ nextAction: { kind: "BLOCKED", blockers: [blocker] } });
    const failed = helpChecklistForView(v).filter((c) => !c.passed);
    expect(failed.map((c) => c.blocker?.operatorSentence)).toContain(
      primaryBlockerSentence(v.nextAction),
    );
  });

  it("still shows the product row as open on a PICK_PRODUCT view", () => {
    const checks = helpChecklistForView(
      view({
        nextAction: {
          kind: "PICK_PRODUCT",
          options: [
            { productId: "p1", name: "A", sku: "A-1" },
            { productId: "p2", name: "B", sku: "B-1" },
          ],
        },
      }),
    );
    expect(checks.find((c) => c.id === "product")?.passed).toBe(false);
  });

  it("claims nothing is wrong on a healthy idle station", () => {
    const idle = view({
      current: null,
      nextAction: { kind: "SCAN_TO_CLAIM", expected: null },
    });
    const checks = helpChecklistForView(idle);
    // The three bag-in-hand rows are dropped, not shown failing.
    expect(checks.map((c) => c.id)).toEqual([
      "materials",
      "upstream",
      "hold",
      "paused",
      "finalized",
    ]);
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(helpIdleNote(idle)).toBe("No bag at this station yet.");
  });

  it("has no idle note once a bag is in hand", () => {
    expect(helpIdleNote(view())).toBeNull();
  });
});

describe("helpNotifyDetail", () => {
  it("falls back to a plain request when nothing is failing", () => {
    expect(helpNotifyDetail(helpChecklistForView(view()))).toBe(
      "Operator asked for help from the station screen.",
    );
  });

  it("sends the engine's own sentences for the open items", () => {
    const detail = helpNotifyDetail(
      helpChecklistForView(
        view({ nextAction: { kind: "BLOCKED", blockers: [blockerFor("BAG_ON_HOLD")] } }),
      ),
    );
    expect(detail).toBe(blockerFor("BAG_ON_HOLD").operatorSentence);
  });

  it("caps the detail at what the action will accept", () => {
    const long: Parameters<typeof helpNotifyDetail>[0] = Array.from(
      { length: 40 },
      (_unused, i) => ({
        id: `row-${i}`,
        label: `Row ${i}`,
        passed: false,
        blocker: {
          code: `CODE_${i}`,
          operatorSentence: "This bag is on hold. Ask a supervisor.",
          supervisorDetail: "",
          suggestedAction: "NOTIFY_SUPERVISOR" as const,
        },
      }),
    );
    const detail = helpNotifyDetail(long);
    expect(detail.length).toBeLessThanOrEqual(EXCEPTION_DETAIL_MAX_LENGTH);
  });
});

describe("primaryBlockerSentence", () => {
  it("is null when nothing is blocking", () => {
    expect(primaryBlockerSentence({ kind: "OPEN_SHIFT" })).toBeNull();
  });
  it("is the first blocker's operator sentence", () => {
    expect(
      primaryBlockerSentence({
        kind: "BLOCKED",
        blockers: [blockerFor("BAG_FINALIZED"), blockerFor("BAG_PAUSED")],
      }),
    ).toBe(blockerFor("BAG_FINALIZED").operatorSentence);
  });
});

describe("chrome helpers", () => {
  it("offers a rolls link only where rolls mount", () => {
    expect(operatorMaterialLinks("tok", "BLISTER")).toEqual([
      { id: "rolls", href: "/floor/tok/rolls", label: "Rolls" },
    ]);
    expect(operatorMaterialLinks("tok", "SEALING")).toEqual([]);
  });

  it("defaults the pause reason to the station's first", () => {
    const model = operatorPauseModel("BLISTER");
    expect(model.reasons.length).toBeGreaterThan(0);
    expect(model.defaultReason).toBe(model.reasons[0]?.value);
  });

  it("asks for a counter snapshot only where the blister rule applies", () => {
    expect(pauseNeedsCounterSnapshot("BLISTER", "shift_end")).toBe(true);
    expect(pauseNeedsCounterSnapshot("SEALING", "shift_end")).toBe(false);
  });
});

describe("display helpers", () => {
  it("draws no bar without honest progress", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ done: 5, expected: 0, unit: "cards" })).toBeNull();
  });

  it("clamps the bar to 0-100", () => {
    expect(progressPercent({ done: 52, expected: 52, unit: "cards" })).toBe(100);
    expect(progressPercent({ done: 60, expected: 52, unit: "cards" })).toBe(100);
    expect(progressPercent({ done: 13, expected: 52, unit: "cards" })).toBe(25);
  });

  it("summarizes an up-next bag, and says so when it is still upstream", () => {
    expect(
      upNextSummary({
        workflowBagId: "b",
        bagLabel: "1042",
        productName: "Chocolate Brown",
        readyState: "READY",
        etaMinutes: null,
      }),
    ).toBe("1042 · Chocolate Brown");
    expect(
      upNextSummary({
        workflowBagId: "b",
        bagLabel: "1042",
        productName: null,
        readyState: "UPSTREAM_RUNNING",
        etaMinutes: 4,
      }),
    ).toBe("1042 · ready in ~4 min");
    expect(
      upNextSummary({
        workflowBagId: "b",
        bagLabel: "1042",
        productName: "Chocolate Brown",
        readyState: "UPSTREAM_RUNNING",
        etaMinutes: null,
      }),
    ).toBe("1042 · Chocolate Brown · still upstream");
  });
});

describe("report problem (P4b Task 4)", () => {
  it("lists all six categories, in the spec's layout order", () => {
    expect(REPORT_PROBLEM_CATEGORY_LAYOUT).toEqual([
      "MATERIAL",
      "MACHINE",
      "PRODUCT",
      "BAG",
      "QUALITY",
      "OTHER",
    ]);
  });

  it("routes each category per raise-production-exception.ts's mapping table", () => {
    expect(reportProblemRouteFor("MACHINE")).toBe("PAUSE_AND_DOWNTIME");
    expect(reportProblemRouteFor("QUALITY")).toBe("QA_HOLD");
    expect(reportProblemRouteFor("BAG")).toBe("PAUSE");
    expect(reportProblemRouteFor("MATERIAL")).toBe("EXCEPTION");
    expect(reportProblemRouteFor("PRODUCT")).toBe("EXCEPTION");
    expect(reportProblemRouteFor("OTHER")).toBe("EXCEPTION");
  });

  it("never disables a category once a bag is pinned", () => {
    for (const route of ["PAUSE_AND_DOWNTIME", "QA_HOLD", "PAUSE", "EXCEPTION"] as const) {
      expect(reportProblemCategoryDisabled(route, true)).toBe(false);
    }
  });

  it("disables every route without a bag (fix round 1, MED 4) — no route has a bagless recording path yet", () => {
    for (const route of ["PAUSE_AND_DOWNTIME", "QA_HOLD", "PAUSE", "EXCEPTION"] as const) {
      expect(reportProblemCategoryDisabled(route, false)).toBe(true);
    }
  });
});
