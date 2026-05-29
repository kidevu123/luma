// OP-1C — station-operator-session helper tests.
//
// Pure-helper coverage of the resolve precedence: per-form override
// (treated as employee_code, hinted as SUPERVISOR_OVERRIDE) → active
// station-operator-session → free-text fallback. The helper composes
// resolveAccountableEmployee plus an active-session lookup; we stub
// the drizzle chain so the test exercises the precedence logic
// without a live database.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import {
  resolveStationAccountability,
  withAccountabilityPayload,
  resolveAdminAccountability,
  sessionSatisfiesFirstOpCount,
  FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS,
} from "./station-operator-session";

type EmployeeRow = {
  id: string;
  fullName: string;
  employeeCode: string | null;
  status: "ACTIVE" | "INACTIVE";
};
type SessionRow = {
  id: string;
  stationId: string;
  employeeId: string | null;
  employeeNameSnapshot: string;
  accountabilitySource: string;
  openedAt: Date;
};

/** Build a stub tx whose .select().from(table).where(clause) chain
 *  returns whatever the route handler decides based on call order.
 *  Each handler returns either a row or null; tests vary precedence
 *  by toggling which call returns a hit. */
function buildTxStub(opts: {
  /** How many .from() calls have been made. The handler uses this to
   *  decide which query is being run (stations vs employees vs
   *  station_operator_sessions). The order matches the resolver's
   *  internal sequence. */
  results: Array<EmployeeRow | SessionRow | null>;
}) {
  let i = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const r = opts.results[i] ?? null;
          i += 1;
          return Promise.resolve(r ? [r] : []);
        },
      }),
    }),
  } as unknown as Parameters<typeof resolveStationAccountability>[0];
}

const STATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ALICE: EmployeeRow = {
  id: "11111111-1111-4111-8111-111111111111",
  fullName: "Alice Operator",
  employeeCode: "1042",
  status: "ACTIVE",
};

const BOB: EmployeeRow = {
  id: "22222222-2222-4222-8222-222222222222",
  fullName: "Bob Supervisor",
  employeeCode: "9001",
  status: "ACTIVE",
};

const ACTIVE_SESSION_ALICE: SessionRow = {
  id: "33333333-3333-4333-8333-333333333333",
  stationId: STATION_ID,
  employeeId: ALICE.id,
  employeeNameSnapshot: ALICE.fullName,
  accountabilitySource: "EMPLOYEE_CODE",
  openedAt: new Date("2026-05-08T10:00:00Z"),
};

describe("resolveStationAccountability — precedence", () => {
  it("returns all-null when no override + no session + no free text", async () => {
    const tx = buildTxStub({ results: [null] }); // session lookup returns nothing
    const r = await resolveStationAccountability(tx, { stationId: STATION_ID });
    expect(r.accountableEmployeeId).toBeNull();
    expect(r.accountabilitySource).toBeNull();
    expect(r.isStable).toBe(false);
  });

  it("uses the active session when no override is supplied", async () => {
    // First lookup is the session.
    const tx = buildTxStub({ results: [ACTIVE_SESSION_ALICE] });
    const r = await resolveStationAccountability(tx, { stationId: STATION_ID });
    expect(r.accountableEmployeeId).toBe(ALICE.id);
    expect(r.accountabilitySource).toBe("STATION_OPERATOR_SESSION");
    expect(r.accountableEmployeeNameSnapshot).toBe(ALICE.fullName);
    expect(r.isStable).toBe(true);
  });

  it("override beats the active session — sourced as SUPERVISOR_OVERRIDE", async () => {
    // Override is resolved FIRST: employee-code lookup returns BOB.
    // Session would have returned ALICE but is never queried.
    const tx = buildTxStub({ results: [BOB] });
    const r = await resolveStationAccountability(tx, {
      stationId: STATION_ID,
      overrideEmployeeCode: "9001",
    });
    expect(r.accountableEmployeeId).toBe(BOB.id);
    expect(r.accountabilitySource).toBe("SUPERVISOR_OVERRIDE");
    expect(r.isStable).toBe(true);
  });

  it("falls through override → session when override doesn't resolve", async () => {
    // First call (override): no match. Second call (session): ALICE.
    const tx = buildTxStub({ results: [null, ACTIVE_SESSION_ALICE] });
    const r = await resolveStationAccountability(tx, {
      stationId: STATION_ID,
      overrideEmployeeCode: "BOGUS",
    });
    expect(r.accountableEmployeeId).toBe(ALICE.id);
    expect(r.accountabilitySource).toBe("STATION_OPERATOR_SESSION");
  });

  it("free-text fallback only fires when override + session both miss", async () => {
    // override → null, session → null, then free-text path.
    const tx = buildTxStub({ results: [null, null] });
    const r = await resolveStationAccountability(tx, {
      stationId: STATION_ID,
      freeText: "Visiting Tech",
    });
    expect(r.accountableEmployeeId).toBeNull();
    expect(r.accountabilitySource).toBe("LEGACY_TEXT");
    expect(r.accountableEmployeeNameSnapshot).toBe("Visiting Tech");
    expect(r.isStable).toBe(false);
  });
});

describe("withAccountabilityPayload — payload merge", () => {
  it("merges accountability fields into a base payload", () => {
    const out = withAccountabilityPayload(
      { count_total: 20324 },
      {
        enteredByUserId: null,
        accountableEmployeeId: ALICE.id,
        accountabilitySource: "STATION_OPERATOR_SESSION",
        accountableEmployeeNameSnapshot: "Alice Operator",
        isStable: true,
      },
    );
    expect(out.count_total).toBe(20324);
    expect(out.accountable_employee_id).toBe(ALICE.id);
    expect(out.accountability_source).toBe("STATION_OPERATOR_SESSION");
    expect(out.accountable_employee_name_snapshot).toBe("Alice Operator");
  });

  it("does not add fields when accountability has nothing to merge", () => {
    const out = withAccountabilityPayload(
      { count_total: 1 },
      {
        enteredByUserId: null,
        accountableEmployeeId: null,
        accountabilitySource: null,
        accountableEmployeeNameSnapshot: null,
        isStable: false,
      },
    );
    expect(out.count_total).toBe(1);
    expect(out.accountable_employee_id).toBeUndefined();
    expect(out.accountability_source).toBeUndefined();
    expect(out.accountable_employee_name_snapshot).toBeUndefined();
  });

  it("does not mutate the input payload", () => {
    const input = { master_cases: 5 };
    const out = withAccountabilityPayload(input, {
      enteredByUserId: null,
      accountableEmployeeId: ALICE.id,
      accountabilitySource: "LOGGED_IN_USER",
      accountableEmployeeNameSnapshot: "Alice",
      isStable: true,
    });
    expect(out).not.toBe(input);
    expect((input as Record<string, unknown>).accountable_employee_id).toBeUndefined();
  });
});

describe("resolveAdminAccountability — defaults from currentUser", () => {
  it("defaults to LOGGED_IN_USER when actor has employeeId", async () => {
    // First lookup: actor.employeeId resolves to ALICE.
    const tx = buildTxStub({ results: [ALICE] });
    const r = await resolveAdminAccountability(tx, {
      actor: { id: "user-1", employeeId: ALICE.id },
    });
    expect(r.enteredByUserId).toBe("user-1");
    expect(r.accountableEmployeeId).toBe(ALICE.id);
    expect(r.accountabilitySource).toBe("LOGGED_IN_USER");
    expect(r.isStable).toBe(true);
  });

  it("supervisor override path tags the source correctly", async () => {
    const tx = buildTxStub({ results: [BOB] });
    const r = await resolveAdminAccountability(tx, {
      actor: { id: "user-1", employeeId: ALICE.id },
      overrideEmployeeId: BOB.id,
    });
    expect(r.enteredByUserId).toBe("user-1");
    expect(r.accountableEmployeeId).toBe(BOB.id);
    expect(r.accountabilitySource).toBe("SUPERVISOR_OVERRIDE");
  });

  it("returns LOGGED_IN_USER + null employee when actor has no employeeId", async () => {
    // Resolver isn't called because actor.employeeId is null and no
    // override was supplied; the helper short-circuits.
    const tx = buildTxStub({ results: [] });
    const r = await resolveAdminAccountability(tx, {
      actor: { id: "user-1", employeeId: null },
    });
    expect(r.enteredByUserId).toBe("user-1");
    expect(r.accountableEmployeeId).toBeNull();
    expect(r.accountabilitySource).toBe("LOGGED_IN_USER");
    expect(r.isStable).toBe(false);
  });
});

describe("OPERATOR-SHIFT-SUBMIT-BLOCK-1 · first-op session helpers", () => {
  it("FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS includes BLISTER and BOTTLE_HANDPACK", () => {
    expect(FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has("BLISTER")).toBe(true);
    expect(FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has("COMBINED")).toBe(true);
    expect(FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has("BOTTLE_HANDPACK")).toBe(
      true,
    );
    expect(FIRST_OP_COUNT_ACCOUNTABILITY_STATION_KINDS.has("SEALING")).toBe(false);
  });

  it("sessionSatisfiesFirstOpCount requires employeeId", () => {
    expect(sessionSatisfiesFirstOpCount({ employeeId: ALICE.id })).toBe(true);
    expect(sessionSatisfiesFirstOpCount({ employeeId: null })).toBe(false);
  });

  it("active LEGACY_TEXT session resolves with null accountableEmployeeId", async () => {
    const legacySession: SessionRow = {
      id: "44444444-4444-4444-8444-444444444444",
      stationId: STATION_ID,
      employeeId: null,
      employeeNameSnapshot: "Sahil",
      accountabilitySource: "LEGACY_TEXT",
      openedAt: new Date("2026-05-29T14:29:30Z"),
    };
    const tx = buildTxStub({ results: [legacySession] });
    const r = await resolveStationAccountability(tx, { stationId: STATION_ID });
    expect(r.accountableEmployeeId).toBeNull();
    expect(r.accountableEmployeeNameSnapshot).toBe("Sahil");
    expect(r.isStable).toBe(false);
  });
});
