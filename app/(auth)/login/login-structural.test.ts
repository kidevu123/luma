// SSO-NEXT-1 / LOGIN-ONE-PATH-1 — both sign-in methods honor ?next=, and
// the card ranks SSO first with password behind a disclosure.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = repo("app/(auth)/login/page.tsx");
const form = repo("app/(auth)/login/login-form.tsx");
const actions = repo("app/(auth)/login/actions.ts");

describe("login honors ?next= on both paths", () => {
  it("page validates next and passes it down", () => {
    expect(page).toMatch(/searchParams/);
    expect(page).toMatch(/safeNextPath/);
    expect(page).toMatch(/next=\{/);
  });
  it("already-signed-in visitors land on next, not always /dashboard", () => {
    expect(page).toMatch(/redirect\(next\)/);
  });
  it("SSO link carries next; password form posts it", () => {
    expect(form).toMatch(/\/api\/auth\/sso\?next=/);
    expect(form).toMatch(/encodeURIComponent/);
    expect(form).toMatch(/name="next"/);
  });
  it("the action redirects to the validated next", () => {
    expect(actions).toMatch(/safeNextPath/);
    expect(actions).toMatch(/redirect\(next\)/);
    expect(actions).not.toMatch(/redirect\("\/dashboard"\)/);
  });
});

describe("one obvious path for the floor", () => {
  it("password sign-in hides behind a disclosure when SSO is configured", () => {
    expect(form).toMatch(/showPassword/);
    expect(form).toMatch(/password instead/i);
  });
  it("the password placeholder no longer fakes a saved credential", () => {
    expect(form).not.toMatch(/••••••••/);
  });
  it("password sign-in still exists (Authentik outages need a way in)", () => {
    expect(form).toMatch(/name="password"/);
    expect(form).toMatch(/loginAction/);
  });
});
