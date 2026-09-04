// SSO-CALLBACK-SUBJECT-1 — structural pins for the OIDC callback's identity
// resolution (the DB path needs Postgres, so behavior is asserted against
// source). Regression: an email-only lookup 500'd with a
// users_authentik_unique violation whenever the Authentik email changed for
// an already-provisioned subject.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(
  join(process.cwd(), "app/api/auth/callback/route.ts"),
  "utf8",
);

describe("OIDC callback identity resolution", () => {
  it("looks up by authentik subject BEFORE email (subject is the stable identity)", () => {
    const subjectIdx = src.indexOf("eq(users.authentikSubject, userinfo.sub)");
    const emailIdx = src.indexOf("lower(${users.email}) = ${email}");
    expect(subjectIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(subjectIdx).toBeLessThan(emailIdx);
  });

  it("JIT insert is conflict-safe and falls back to re-select by subject", () => {
    expect(src).toMatch(/\.onConflictDoNothing\(\)/);
    // The re-select after a swallowed conflict must exist after the insert.
    const insertIdx = src.indexOf(".onConflictDoNothing()");
    const reselect = src.indexOf("eq(users.authentikSubject, userinfo.sub)", insertIdx);
    expect(reselect).toBeGreaterThan(insertIdx);
  });

  it("still refuses disabled accounts and backfills a missing subject", () => {
    expect(src).toMatch(/user\.disabledAt/);
    expect(src).toMatch(/!user\.authentikSubject/);
  });
});

const ssoSrc = readFileSync(
  join(process.cwd(), "app/api/auth/sso/route.ts"),
  "utf8",
);

describe("SSO-NEXT-1: next is validated at both ends", () => {
  it("the SSO start validates before stashing next in the state cookie", () => {
    expect(ssoSrc).toMatch(/const next = safeNextPath\(/);
    // Ensure the validated next is actually used in the cookie.
    const assignment = ssoSrc.indexOf("const next = safeNextPath(");
    const cookieWrite = ssoSrc.indexOf("oidc_state");
    expect(assignment).toBeGreaterThan(-1);
    expect(cookieWrite).toBeGreaterThan(assignment);
  });
  it("the callback re-validates before redirecting (no open redirect)", () => {
    expect(src).toMatch(/const nextUrl = safeNextPath\(/);
    // Ensure validation happens before the final redirect.
    const assignment = src.indexOf("const nextUrl = safeNextPath(");
    const redirectCall = src.indexOf("NextResponse.redirect(new URL(");
    expect(assignment).toBeGreaterThan(-1);
    expect(assignment).toBeLessThan(redirectCall);
  });
});
