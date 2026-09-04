// AUTH-REVOKE-1 — closes the role/disabled staleness window: currentUser()
// re-reads role + disabledAt from `users` on every call (via the same query
// that already fetched employeeId) instead of trusting the signed cookie
// payload for the full 12h cookie lifetime. These tests exercise the real
// runtime path (mocked db + cookies) rather than only pinning source text,
// so they fail if the disabled check or the fail-open guard is removed —
// not just reworded.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "fs";
import { join } from "path";

process.env.AUTH_SECRET = "test-only-auth-secret-not-for-prod-xxxxxxxx";

// ─── Controllable db.select().from(users).where(...) result ────────────
// One of:
//   { kind: "row", row }  — the row was found (disabled or not)
//   { kind: "not-found" } — query succeeded, no matching row
//   { kind: "throw" }     — the query itself failed (DB blip)
type DbState =
  | { kind: "row"; row: { employeeId: string | null; role: string; disabledAt: Date | null } }
  | { kind: "not-found" }
  | { kind: "throw" };

const dbState: { current: DbState } = { current: { kind: "not-found" } };

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          if (dbState.current.kind === "throw") {
            return Promise.reject(new Error("connection reset"));
          }
          if (dbState.current.kind === "row") {
            return Promise.resolve([dbState.current.row]);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

const cookieState: { value: string | undefined } = { value: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieState.value ? { value: cookieState.value } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

import { currentUser, createSessionCookie } from "@/lib/auth";

describe("AUTH-REVOKE-1 · currentUser() per-request role/disabled check", () => {
  beforeEach(() => {
    dbState.current = { kind: "not-found" };
    cookieState.value = undefined;
  });

  it("the extended query selects role and disabledAt alongside employeeId (not a second query)", () => {
    const src = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");
    expect(src).toMatch(
      /select\(\{ employeeId: users\.employeeId, role: users\.role, disabledAt: users\.disabledAt \}\)/,
    );
  });

  it("returns null when the DB row is found and disabledAt is set — the demoted/disabled path", async () => {
    const uid = randomUUID();
    dbState.current = {
      kind: "row",
      row: { employeeId: null, role: "STAFF", disabledAt: new Date() },
    };
    const { value } = await createSessionCookie({ id: uid, role: "ADMIN", email: "a@example.com" });
    cookieState.value = value;

    expect(await currentUser()).toBeNull();
  });

  it("prefers the freshly-read DB role over a stale cookie role when the row is found and not disabled", async () => {
    const uid = randomUUID();
    dbState.current = {
      kind: "row",
      row: { employeeId: null, role: "STAFF", disabledAt: null },
    };
    // Cookie was signed while the user was still ADMIN.
    const { value } = await createSessionCookie({ id: uid, role: "ADMIN", email: "a@example.com" });
    cookieState.value = value;

    const user = await currentUser();
    expect(user?.role).toBe("STAFF");
  });

  it("fails open to the cookie payload when the query throws — a DB blip must never log the floor out", async () => {
    const uid = randomUUID();
    dbState.current = { kind: "throw" };
    const { value } = await createSessionCookie({ id: uid, role: "ADMIN", email: "a@example.com" });
    cookieState.value = value;

    const user = await currentUser();
    expect(user).toEqual({ id: uid, email: "a@example.com", role: "ADMIN", employeeId: null });
  });

  it("fails open to the cookie payload when the row is not found — never rejects, never revokes", async () => {
    const uid = randomUUID();
    dbState.current = { kind: "not-found" };
    const { value } = await createSessionCookie({ id: uid, role: "MANAGER", email: "b@example.com" });
    cookieState.value = value;

    const user = await currentUser();
    expect(user).toEqual({ id: uid, email: "b@example.com", role: "MANAGER", employeeId: null });
  });
});
