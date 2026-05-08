// OP-1B — projector contract test.
//
// Asserts that when projectEvent receives the OP-1B accountability
// fields, the row inserted into workflow_events carries:
//   - employee_id  ← ev.accountableEmployeeId
//   - user_id      ← ev.enteredByUserId
//   - payload merged with accountability_source + name snapshot
//
// We early-exit projectEvent at the duplicate-detection branch by
// returning an empty array from the insert's .returning(), which
// avoids having to stub the full read-model surface. The values
// passed to .values() are still captured before the bail.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import { projectEvent } from "./index";

type CapturedInsert = {
  table: unknown;
  values: Record<string, unknown> | null;
};

function buildTxStub() {
  const captured: CapturedInsert = { table: null, values: null };
  const tx = {
    insert: (table: unknown) => {
      captured.table = table;
      return {
        values: (vals: Record<string, unknown>) => {
          captured.values = vals;
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([]),
            }),
          };
        },
      };
    },
  } as unknown as Parameters<typeof projectEvent>[0];
  return { tx, captured };
}

describe("projectEvent — OP-1B accountability propagation", () => {
  it("populates employee_id and user_id on the workflow_events insert", async () => {
    const { tx, captured } = buildTxStub();
    await projectEvent(tx, {
      workflowBagId: "11111111-1111-4111-8111-111111111111",
      stationId: "22222222-2222-4222-8222-222222222222",
      eventType: "BLISTER_COMPLETE",
      payload: { count_total: 20324 },
      enteredByUserId: "33333333-3333-4333-8333-333333333333",
      accountableEmployeeId: "44444444-4444-4444-8444-444444444444",
      accountabilitySource: "STATION_OPERATOR_SESSION",
      accountableEmployeeNameSnapshot: "Alice Operator",
    });
    expect(captured.values).not.toBeNull();
    expect(captured.values!.employeeId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(captured.values!.userId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    const payload = captured.values!.payload as Record<string, unknown>;
    expect(payload.count_total).toBe(20324);
    expect(payload.accountability_source).toBe("STATION_OPERATOR_SESSION");
    expect(payload.accountable_employee_name_snapshot).toBe("Alice Operator");
  });

  it("leaves employee_id and user_id null when the caller omits them", async () => {
    const { tx, captured } = buildTxStub();
    await projectEvent(tx, {
      workflowBagId: "11111111-1111-4111-8111-111111111111",
      stationId: "22222222-2222-4222-8222-222222222222",
      eventType: "BLISTER_COMPLETE",
      payload: { count_total: 20324 },
    });
    expect(captured.values!.employeeId).toBeNull();
    expect(captured.values!.userId).toBeNull();
    const payload = captured.values!.payload as Record<string, unknown>;
    expect(payload.count_total).toBe(20324);
    expect(payload.accountability_source).toBeUndefined();
    expect(payload.accountable_employee_name_snapshot).toBeUndefined();
  });

  it("preserves caller payload while merging accountability fields", async () => {
    const { tx, captured } = buildTxStub();
    await projectEvent(tx, {
      workflowBagId: "11111111-1111-4111-8111-111111111111",
      stationId: "22222222-2222-4222-8222-222222222222",
      eventType: "PACKAGING_COMPLETE",
      payload: {
        master_cases: 5,
        displays_made: 24,
        loose_cards: 0,
        damaged_packaging: 1,
      },
      accountableEmployeeId: "44444444-4444-4444-8444-444444444444",
      accountabilitySource: "EMPLOYEE_PICKER",
    });
    const payload = captured.values!.payload as Record<string, unknown>;
    expect(payload.master_cases).toBe(5);
    expect(payload.damaged_packaging).toBe(1);
    expect(payload.accountability_source).toBe("EMPLOYEE_PICKER");
    expect(captured.values!.employeeId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });
});
