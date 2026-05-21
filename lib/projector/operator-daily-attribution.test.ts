// OP-1E — attribution helper tests.
//
// These tests pin down the rules that prevent double-counting and
// keep similarly-named operators distinct:
//   - employee_id wins over payload operator_code on the same event
//   - a code attached to an employee on the same bag never produces a
//     second legacy row
//   - two different employees with similar codes stay in two rows
//   - free-text codes that travel WITHOUT any employee_id roll up as
//     legacy code-only rows

import { describe, expect, it } from "vitest";

import {
  attributeFinalizedBag,
  type AttributionEvent,
} from "./operator-daily-attribution";

const EMP_A = "11111111-1111-4111-8111-111111111111";
const EMP_B = "22222222-2222-4222-8222-222222222222";

describe("attributeFinalizedBag", () => {
  it("returns empty maps for an empty event list", () => {
    const r = attributeFinalizedBag([]);
    expect(r.employees.size).toBe(0);
    expect(r.codeOnly.size).toBe(0);
  });

  it("returns one employee row when events all carry the same employee_id", () => {
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: null },
      { employeeId: EMP_A, operatorCode: null },
      { employeeId: EMP_A, operatorCode: null },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(1);
    expect(r.employees.get(EMP_A)?.operatorCode).toBeNull();
    expect(r.codeOnly.size).toBe(0);
  });

  it("attaches the operator_code as a tag on the employee row", () => {
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: "1042" },
      { employeeId: EMP_A, operatorCode: "1042" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.get(EMP_A)?.operatorCode).toBe("1042");
    // The code travelled with the employee — no separate legacy row.
    expect(r.codeOnly.size).toBe(0);
  });

  it("does NOT promote a code-only event to a legacy row when the same code already tags an employee on this bag", () => {
    // Mid-bag operator-change scenario: BLISTER_COMPLETE landed with
    // employee_id + code "1042"; a stale OPERATOR_CHANGE event from
    // before OP-1B/OP-1C was deployed has only "1042" in payload.
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: "1042" },
      { employeeId: null, operatorCode: "1042" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(1);
    expect(r.codeOnly.size).toBe(0);
  });

  it("keeps the FIRST operator_code on an employee row when subsequent events disagree", () => {
    // One operator typed two different codes on a single bag (typo
    // first time, retyped). We don't want to lose the first attribution
    // — the metric layer can warn separately. Here we just confirm
    // the row's tag stays stable rather than flip-flopping.
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: "1042" },
      { employeeId: EMP_A, operatorCode: "1402" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.get(EMP_A)?.operatorCode).toBe("1042");
  });

  it("upgrades a null tag to a non-null code on a later event", () => {
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: null },
      { employeeId: EMP_A, operatorCode: "1042" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.get(EMP_A)?.operatorCode).toBe("1042");
  });

  it("keeps two different employees on two rows", () => {
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: "1042" },
      { employeeId: EMP_B, operatorCode: "9001" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(2);
    expect(r.employees.get(EMP_A)?.operatorCode).toBe("1042");
    expect(r.employees.get(EMP_B)?.operatorCode).toBe("9001");
    expect(r.codeOnly.size).toBe(0);
  });

  it("promotes free-text code to a legacy row only when no employee ever resolved", () => {
    const events: AttributionEvent[] = [
      { employeeId: null, operatorCode: "9999" },
      { employeeId: null, operatorCode: "9999" },
      { employeeId: null, operatorCode: "8888" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(0);
    expect(Array.from(r.codeOnly).sort()).toEqual(["8888", "9999"]);
  });

  it("treats empty / whitespace fields as null", () => {
    const events: AttributionEvent[] = [
      { employeeId: "   ", operatorCode: "" },
      { employeeId: null, operatorCode: "  " },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(0);
    expect(r.codeOnly.size).toBe(0);
  });

  it("does not double-count when the same code appears on an employee event AND a code-only event in the same bag", () => {
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: "1042" },
      { employeeId: null, operatorCode: "1042" },
      { employeeId: null, operatorCode: "1042" },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(1);
    expect(r.codeOnly.size).toBe(0);
  });

  it("two employees with identical-looking display names stay separate (id is the key)", () => {
    // Caller hands us the resolved employee_id. The fact that two
    // employees share a fullName upstream is irrelevant here — the
    // grouping is on uuid.
    const events: AttributionEvent[] = [
      { employeeId: EMP_A, operatorCode: null },
      { employeeId: EMP_B, operatorCode: null },
    ];
    const r = attributeFinalizedBag(events);
    expect(r.employees.size).toBe(2);
  });
});
