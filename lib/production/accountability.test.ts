// OP-1B — accountability resolver tests.
//
// Pure-helper tests for the source classification + a stub-driven
// integration test that exercises the drizzle .select().from().where()
// chain through resolveAccountableEmployee. The stub returns whatever
// the test installs, so we validate routing precedence + shape without
// standing up a real database.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { transaction: () => Promise.resolve(undefined) },
}));

import {
  resolveAccountableEmployee,
  accountabilityConfidence,
} from "./accountability";

type FakeRow = {
  id: string;
  fullName: string;
  employeeCode: string | null;
  status: "ACTIVE" | "INACTIVE" | "TERMINATED";
};

/** Build a tx-shaped stub whose .select().from().where() chain resolves
 *  to whatever the test installed. The handler receives no arguments;
 *  tests vary behaviour by installing different handlers. */
function buildTxStub(handler: () => FakeRow | null) {
  return {
    select: () => ({
      from: () => ({
        where: (_clause: unknown) => {
          const row = handler();
          return Promise.resolve(row ? [row] : []);
        },
      }),
    }),
  } as unknown as Parameters<typeof resolveAccountableEmployee>[0];
}

const ALICE: FakeRow = {
  id: "11111111-1111-4111-8111-111111111111",
  fullName: "Alice Operator",
  employeeCode: "1042",
  status: "ACTIVE",
};

const BOB_INACTIVE: FakeRow = {
  id: "22222222-2222-4222-8222-222222222222",
  fullName: "Bob Former",
  employeeCode: "9999",
  status: "INACTIVE",
};

describe("resolveAccountableEmployee — input shape routing", () => {
  it("returns null when no input is provided", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(tx, {});
    expect(out).toBeNull();
  });

  it("returns null in strict mode when only free text is provided", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(
      tx,
      { freeText: "Mystery Person" },
      { strict: true },
    );
    expect(out).toBeNull();
  });

  it("falls back to LEGACY_TEXT for free text in non-strict mode", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(tx, {
      freeText: "  Hand Typed  ",
    });
    expect(out).not.toBeNull();
    expect(out!.source).toBe("LEGACY_TEXT");
    expect(out!.isStable).toBe(false);
    expect(out!.accountableEmployeeId).toBeNull();
    expect(out!.nameSnapshot).toBe("Hand Typed");
  });

  it("uses MANUAL_TEXT source label when caller hints it", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(tx, {
      freeText: "Sticker Note",
      sourceHint: "MANUAL_TEXT",
    });
    expect(out!.source).toBe("MANUAL_TEXT");
  });

  it("resolves by employeeId, defaulting source to LOGGED_IN_USER", async () => {
    const tx = buildTxStub(() => ALICE);
    const out = await resolveAccountableEmployee(tx, {
      employeeId: ALICE.id,
    });
    expect(out!.source).toBe("LOGGED_IN_USER");
    expect(out!.accountableEmployeeId).toBe(ALICE.id);
    expect(out!.accountableEmployeeCode).toBe("1042");
    expect(out!.nameSnapshot).toBe("Alice Operator");
    expect(out!.isStable).toBe(true);
  });

  it("rejects malformed employeeId (non-UUID) without DB lookup", async () => {
    let called = false;
    const tx = buildTxStub(() => {
      called = true;
      return ALICE;
    });
    const out = await resolveAccountableEmployee(tx, {
      employeeId: "not-a-uuid",
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("honours sourceHint over the default LOGGED_IN_USER", async () => {
    const tx = buildTxStub(() => ALICE);
    const out = await resolveAccountableEmployee(tx, {
      employeeId: ALICE.id,
      sourceHint: "SUPERVISOR_OVERRIDE",
    });
    expect(out!.source).toBe("SUPERVISOR_OVERRIDE");
  });

  it("resolves by employeeCode (active match) → EMPLOYEE_CODE", async () => {
    const tx = buildTxStub(() => ALICE);
    const out = await resolveAccountableEmployee(tx, {
      employeeCode: "1042",
    });
    expect(out!.source).toBe("EMPLOYEE_CODE");
    expect(out!.accountableEmployeeId).toBe(ALICE.id);
    expect(out!.isStable).toBe(true);
  });

  it("falls through past employeeCode when stub returns no row (inactive / unknown)", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(tx, {
      employeeCode: "9999",
      freeText: "Bob Former",
    });
    // Code didn't resolve to an active row, but free text fallback fires.
    expect(out!.source).toBe("LEGACY_TEXT");
    expect(out!.nameSnapshot).toBe("Bob Former");
  });

  it("resolves badgeSubject through the same active-code lookup → BADGE_SCAN", async () => {
    const tx = buildTxStub(() => ALICE);
    const out = await resolveAccountableEmployee(tx, {
      badgeSubject: "1042",
    });
    expect(out!.source).toBe("BADGE_SCAN");
    expect(out!.isStable).toBe(true);
  });

  it("trims and ignores whitespace-only inputs", async () => {
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(tx, {
      employeeCode: "   ",
      freeText: "   ",
    });
    expect(out).toBeNull();
  });

  it("captures name snapshot from the stable row", async () => {
    const tx = buildTxStub(() => ALICE);
    const out = await resolveAccountableEmployee(tx, {
      employeeId: ALICE.id,
    });
    expect(out!.nameSnapshot).toBe("Alice Operator");
  });

  it("inactive code → row would be filtered upstream; resolver treats it as no-match", async () => {
    // Resolver itself doesn't filter; it relies on the SQL WHERE clause
    // to constrain to ACTIVE rows. Here we confirm that when the stub
    // returns nothing the resolver treats the code as unresolved.
    const tx = buildTxStub(() => null);
    const out = await resolveAccountableEmployee(
      tx,
      { employeeCode: BOB_INACTIVE.employeeCode },
      { strict: true },
    );
    expect(out).toBeNull();
  });
});

describe("accountabilityConfidence — confidence ladder", () => {
  it("MISSING when source is null", () => {
    expect(accountabilityConfidence(null, false)).toBe("MISSING");
  });

  it("LOW when free-text fallback (isStable=false)", () => {
    expect(accountabilityConfidence("LEGACY_TEXT", false)).toBe("LOW");
    expect(accountabilityConfidence("MANUAL_TEXT", false)).toBe("LOW");
  });

  it("MEDIUM for typed employee code (typo risk)", () => {
    expect(accountabilityConfidence("EMPLOYEE_CODE", true)).toBe("MEDIUM");
  });

  it("HIGH for picker / scan / logged-in / station-session", () => {
    expect(accountabilityConfidence("LOGGED_IN_USER", true)).toBe("HIGH");
    expect(accountabilityConfidence("EMPLOYEE_PICKER", true)).toBe("HIGH");
    expect(accountabilityConfidence("BADGE_SCAN", true)).toBe("HIGH");
    expect(accountabilityConfidence("SUPERVISOR_OVERRIDE", true)).toBe("HIGH");
    expect(accountabilityConfidence("STATION_OPERATOR_SESSION", true)).toBe(
      "HIGH",
    );
  });

  it("LOW for any source where isStable is false", () => {
    // A picker that somehow returned no stable id should be LOW, not HIGH.
    expect(accountabilityConfidence("EMPLOYEE_PICKER", false)).toBe("LOW");
    expect(accountabilityConfidence("EMPLOYEE_CODE", false)).toBe("LOW");
  });
});
