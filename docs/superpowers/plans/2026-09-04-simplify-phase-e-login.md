# Luma Simplify Phase E — Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-in returns the operator to the page they asked for, offers one obvious path (SSO) with password tucked behind a link, closes the open redirect in the OIDC callback, and stops logging floor tablets out mid-shift.

**Architecture:** One pure, security-critical helper (`safeNextPath`) validates every `next` value at every entry point (login action, SSO start, OIDC callback). A header-only middleware exposes the requested pathname so `requireSession()` can build `/login?next=<path>` without touching ~100 call sites. The login card keeps both methods but ranks them: SSO is the primary button, password collapses behind a link.

**Tech Stack:** Next.js 15 App Router (middleware + RSC + server actions), React 19, TypeScript strict, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-luma-simplify-design.md` (Phase E section)

## Global Constraints

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- No emoji anywhere in UI.
- **Security:** every `next` value — from the query string, the `oidc_state` cookie, or a form field — passes through `safeNextPath` before it reaches `redirect()` or `new URL()`. Site-relative paths only; anything else falls back to `/dashboard`. This closes the existing open redirect at `app/api/auth/callback/route.ts` (currently `new URL(nextUrl, appBase)` unvalidated).
- The middleware added here sets a request header and does NOTHING else: no auth decisions, no redirects, no rewrites, no cookie access. Guards stay exactly where they are (per-page `requireSession`/`requireAdmin`/`requireLead`).
- Floor routes (`/floor/[token]`, `/floor/api/*`) and API routes are excluded from the middleware matcher — station-token auth is untouched by this phase.
- Password sign-in remains fully functional (emergency path when Authentik is down); only its visual rank changes.
- No schema changes; no new mutation endpoints.
- Run focused tests with `npx vitest run <file>`; full suite only in the gate task.
- Commit messages: conventional commits + session trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01MYojhbV7ZEqC2M6m8m2B9T`

## Facts established by reading the code (implementers rely on these)

- `lib/auth-guards.ts:8-12` — `requireSession()` does `redirect("/login")` with no `next`. `requireRole` redirects to `/` on wrong role (that one must NOT gain a `next`; the user is authenticated, just unauthorized).
- `app/(auth)/login/page.tsx:11-12` — takes no `searchParams`; redirects an already-authenticated visitor to `/dashboard`; renders `<LoginForm oidcEnabled={Boolean(process.env.AUTHENTIK_CLIENT_ID)} />`.
- `app/(auth)/login/login-form.tsx` — client component; SSO is a plain `<a href="/api/auth/sso">` above a divider, password form below with `placeholder="••••••••"` (line 64) and a submit button whose styling already de-emphasizes when `oidcEnabled`.
- `app/(auth)/login/actions.ts:28` — `redirect("/dashboard")` hardcoded; schema messages were humanized in Phase B.
- `app/api/auth/sso/route.ts:6,26` — reads `?next=` unvalidated, stashes `${state}:${next}` in the `oidc_state` cookie (maxAge 300, httpOnly, lax). State is 32 random hex bytes, so splitting on the FIRST colon is unambiguous even when the path contains one.
- `app/api/auth/callback/route.ts` — splits that cookie on the first colon, defaults `/dashboard`, and (Phase A/v1.37.1) resolves identity by Authentik subject first. Its final redirect is `new URL(nextUrl, appBase)` — the open redirect this phase closes.
- `lib/auth.ts:13` — `const COOKIE_MAX_AGE = 60 * 60 * 8; // 8h`, used by both `signIn`'s cookie set (line 127) and `createSessionCookie` (line 191). An 8-hour session expires inside a shift that started before login.
- There is NO `middleware.ts` in this repo today.
- `app/(auth)/login/` has no test file today; `app/api/auth/callback/callback-structural.test.ts` exists (v1.37.1) and pins subject-first lookup — keep it green.

---

### Task 1: `safeNextPath` — the validation helper

**Files:**
- Create: `lib/auth/safe-next-path.ts`
- Create: `lib/auth/safe-next-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `safeNextPath(raw: string | null | undefined, fallback?: string): string` — returns `raw` when it is a site-relative path, otherwise `fallback` (default `"/dashboard"`). Query strings and hashes are preserved. Tasks 2-4 all call this.

- [ ] **Step 1: Write the failing tests**

Create `lib/auth/safe-next-path.test.ts`:

```ts
// SSO-NEXT-1 — this helper is the only thing standing between a crafted
// ?next= and an off-site redirect. Test the attacks explicitly.

import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-next-path";

describe("safeNextPath — accepts genuine deep links", () => {
  it("keeps a plain path", () => {
    expect(safeNextPath("/po-closeout/abc")).toBe("/po-closeout/abc");
  });
  it("preserves query strings and hashes (closeout deep links carry tabs)", () => {
    expect(safeNextPath("/po-closeout/abc?tab=zoho&empty=1")).toBe("/po-closeout/abc?tab=zoho&empty=1");
    expect(safeNextPath("/workflow-submissions?bag=x#row")).toBe("/workflow-submissions?bag=x#row");
  });
  it("keeps the bare root", () => {
    expect(safeNextPath("/")).toBe("/");
  });
});

describe("safeNextPath — rejects everything that could leave the site", () => {
  const fallback = "/dashboard";
  it("absolute URLs", () => {
    expect(safeNextPath("https://evil.example/x")).toBe(fallback);
    expect(safeNextPath("http://evil.example")).toBe(fallback);
  });
  it("protocol-relative URLs (the classic //host bypass)", () => {
    expect(safeNextPath("//evil.example/x")).toBe(fallback);
    expect(safeNextPath("///evil.example")).toBe(fallback);
  });
  it("backslash variants (WHATWG treats \\ as / for special schemes)", () => {
    expect(safeNextPath("/\\evil.example")).toBe(fallback);
    expect(safeNextPath("\\\\evil.example")).toBe(fallback);
  });
  it("non-path schemes", () => {
    expect(safeNextPath("javascript:alert(1)")).toBe(fallback);
    expect(safeNextPath("data:text/html,x")).toBe(fallback);
  });
  it("relative paths without a leading slash", () => {
    expect(safeNextPath("dashboard")).toBe(fallback);
    expect(safeNextPath("../etc")).toBe(fallback);
  });
  it("control characters (header/redirect smuggling)", () => {
    expect(safeNextPath("/ok\nSet-Cookie: a=b")).toBe(fallback);
    expect(safeNextPath("/ok\r\nx")).toBe(fallback);
    expect(safeNextPath("/ok\u0000bad")).toBe(fallback);
  });
  it("surrounding whitespace is trimmed, not treated as an attack", () => {
    expect(safeNextPath("  /po-closeout/abc  ")).toBe("/po-closeout/abc");
  });
  it("empty, whitespace, missing, and absurdly long values", () => {
    expect(safeNextPath("")).toBe(fallback);
    expect(safeNextPath("   ")).toBe(fallback);
    expect(safeNextPath(null)).toBe(fallback);
    expect(safeNextPath(undefined)).toBe(fallback);
    expect(safeNextPath(`/${"a".repeat(2000)}`)).toBe(fallback);
  });
  it("never returns the login page itself (no redirect loop)", () => {
    expect(safeNextPath("/login")).toBe(fallback);
    expect(safeNextPath("/login?next=/x")).toBe(fallback);
  });
  it("honors an explicit fallback", () => {
    expect(safeNextPath("https://evil.example", "/floor-board")).toBe("/floor-board");
  });
});

describe("safeNextPath — the accepted values are genuinely same-origin", () => {
  it("every accepted value resolves back to the app origin", () => {
    const base = "https://luma.example";
    for (const candidate of ["/po-closeout/abc?tab=zoho", "/", "/finished-lots/new?bagId=1"]) {
      expect(new URL(safeNextPath(candidate), base).origin).toBe(base);
    }
  });
  it("every rejected value would NOT have (proving the guard earns its keep)", () => {
    const base = "https://luma.example";
    for (const attack of ["//evil.example/x", "/\\evil.example", "https://evil.example"]) {
      expect(new URL(safeNextPath(attack), base).origin).toBe(base);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/auth/safe-next-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/auth/safe-next-path.ts`:

```ts
// SSO-NEXT-1 — validate a post-login destination.
//
// The only safe shape is a SITE-RELATIVE path: exactly one leading slash,
// with the next character neither "/" nor "\". Both of those turn the value
// into a protocol-relative URL that `new URL(value, appBase)` resolves to a
// FOREIGN origin — the open-redirect this guard exists to prevent. Query
// strings and hashes are preserved: closeout deep links carry them.

const MAX_LENGTH = 512;

export function safeNextPath(
  raw: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
  if (!value.startsWith("/")) return fallback;
  // Second character decides: "//host" and "/\host" both escape the origin.
  const second = value.charAt(1);
  if (second === "/" || second === "\\") return fallback;
  // Control characters could smuggle headers when interpolated.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  // Bouncing back to the login page would loop the operator.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) {
    return fallback;
  }
  return value;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/auth/safe-next-path.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/safe-next-path.ts lib/auth/safe-next-path.test.ts
git commit -m "feat(auth): safeNextPath guard for post-login destinations"
```

---

### Task 2: Pathname header middleware + guard redirect with `next`

**Files:**
- Create: `middleware.ts` (repo root, beside `next.config.ts`)
- Modify: `lib/auth-guards.ts`
- Create: `lib/auth/auth-guards-structural.test.ts`

**Interfaces:**
- Consumes: `safeNextPath` (Task 1).
- Produces: request header `x-luma-pathname` carrying `pathname + search` on page routes; `requireSession()` redirects to `/login?next=<encoded path>` when that header is present and safe, plain `/login` otherwise. `requireRole`'s `/` redirect is UNCHANGED (authenticated-but-unauthorized is not a login problem).

- [ ] **Step 1: Write the failing structural test**

Create `lib/auth/auth-guards-structural.test.ts`:

```ts
// SSO-NEXT-1 — the guard's redirect target and the middleware's scope are
// security-relevant; pin them structurally (the runtime path needs a
// request context).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const guards = repo("lib/auth-guards.ts");
const middleware = repo("middleware.ts");

describe("requireSession carries the requested path into login", () => {
  it("builds /login?next= from the middleware header, through safeNextPath", () => {
    expect(guards).toMatch(/x-luma-pathname/);
    expect(guards).toMatch(/safeNextPath/);
    expect(guards).toMatch(/encodeURIComponent/);
    expect(guards).toMatch(/\/login\?next=/);
  });
  it("wrong-role redirects stay put (not a login problem)", () => {
    expect(guards).toMatch(/redirect\("\/"\)/);
    expect(guards).not.toMatch(/requireRole[\s\S]{0,200}\/login\?next=/);
  });
});

describe("middleware is header-only and skips floor + api routes", () => {
  it("sets the pathname header and nothing else", () => {
    expect(middleware).toMatch(/x-luma-pathname/);
    expect(middleware).toMatch(/NextResponse\.next/);
    expect(middleware).not.toMatch(/NextResponse\.redirect|NextResponse\.rewrite/);
    expect(middleware).not.toMatch(/cookies/);
  });
  it("matcher excludes api, floor api, and static assets", () => {
    expect(middleware).toMatch(/matcher/);
    expect(middleware).toMatch(/floor\/api/);
    expect(middleware).toMatch(/_next\/static/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/auth/auth-guards-structural.test.ts`
Expected: FAIL — `middleware.ts` does not exist.

- [ ] **Step 3: Implement the middleware**

Create `middleware.ts` at the repo root:

```ts
// SSO-NEXT-1 — expose the requested path to server components.
//
// Next.js gives a server component no way to read its own URL, so a guard
// that wants to send the operator back after login needs the path from
// somewhere. This middleware ONLY copies it into a request header. It makes
// no auth decision, reads no cookies, and never redirects or rewrites —
// every guard stays exactly where it is (per-page requireSession/-Admin).
//
// API and floor-API routes are excluded: they never redirect to /login, and
// station-token auth must stay off this path entirely.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-luma-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Everything except API routes, floor API routes, and static assets.
    "/((?!api/|floor/api/|_next/static|_next/image|favicon.ico|manifest|icons/).*)",
  ],
};
```

- [ ] **Step 4: Implement the guard change**

In `lib/auth-guards.ts`, replace `requireSession` (leave `requireRole`, `requireAdmin`, `requireLead`, `requireOwner` untouched):

```ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser, type CurrentUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/auth/safe-next-path";

export async function requireSession(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) {
    // SSO-NEXT-1 — come back here after signing in. The header is set by
    // middleware.ts; when it is absent (or unsafe) fall back to a plain
    // /login, which lands on /dashboard.
    let target: string | null = null;
    try {
      const h = await headers();
      const requested = h.get("x-luma-pathname");
      if (requested) {
        const safe = safeNextPath(requested, "");
        if (safe) target = safe;
      }
    } catch {
      // No request context (or headers unavailable) — plain login.
    }
    redirect(target ? `/login?next=${encodeURIComponent(target)}` : "/login");
  }
  return u;
}
```

Note: `safeNextPath(requested, "")` uses an empty fallback so an unsafe value yields `""` (falsy) → plain `/login`, rather than a pointless `?next=/dashboard`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run lib/auth/auth-guards-structural.test.ts lib/auth/safe-next-path.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add middleware.ts lib/auth-guards.ts lib/auth/auth-guards-structural.test.ts
git commit -m "feat(auth): carry the requested path into login via header middleware"
```

---

### Task 3: Login card — SSO primary, password collapsed, `next` threaded

**Files:**
- Modify: `app/(auth)/login/page.tsx`
- Modify: `app/(auth)/login/login-form.tsx`
- Modify: `app/(auth)/login/actions.ts`
- Create: `app/(auth)/login/login-structural.test.ts`

**Interfaces:**
- Consumes: `safeNextPath` (Task 1).
- Produces: `/login?next=<path>` honored by BOTH sign-in methods; `LoginForm({ oidcEnabled, next })` where `next: string` is already validated by the page; `loginAction` reads a hidden `next` field and redirects there.

- [ ] **Step 1: Write the failing structural test**

Create `app/(auth)/login/login-structural.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run 'app/(auth)/login/login-structural.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement the page**

In `app/(auth)/login/page.tsx`:

```tsx
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeNextPath(rawNext);
  if (await currentUser()) redirect(next);
  // …unchanged card markup…
  <LoginForm oidcEnabled={Boolean(process.env.AUTHENTIK_CLIENT_ID)} next={next} />
```

(Import `safeNextPath` from `@/lib/auth/safe-next-path`. Everything else on the page is unchanged.)

- [ ] **Step 4: Implement the form**

In `app/(auth)/login/login-form.tsx` — signature `LoginForm({ oidcEnabled, next }: { oidcEnabled?: boolean; next: string })`, add `const [showPassword, setShowPassword] = React.useState(!oidcEnabled);`, and restructure:

```tsx
{oidcEnabled && (
  <a
    href={`/api/auth/sso?next=${encodeURIComponent(next)}`}
    className="flex items-center justify-center gap-2 w-full h-10 rounded-md bg-brand-700 text-white text-sm font-medium hover:bg-brand-800 transition-colors"
  >
    Sign in
  </a>
)}
{oidcEnabled && !showPassword && (
  <button
    type="button"
    onClick={() => setShowPassword(true)}
    className="w-full text-center text-[11px] text-text-subtle underline decoration-dotted hover:text-text-muted"
  >
    Sign in with password instead
  </button>
)}
{showPassword && (
  <form action={/* unchanged handler */} className="space-y-4">
    <input type="hidden" name="next" value={next} />
    {/* unchanged email + password fields, EXCEPT: placeholder="" on password
        (an empty placeholder — never the dots, which read as a saved value),
        and the submit button label stays "Sign in with email" */}
  </form>
)}
```

Keep the existing divider only when both are visible (`oidcEnabled && showPassword`), keep the error box, keep `autoFocus={!oidcEnabled}` on email. The submit button keeps its secondary styling when `oidcEnabled`.

- [ ] **Step 5: Implement the action**

In `app/(auth)/login/actions.ts`, extend the schema and redirect:

```ts
const schema = z.object({
  email: /* unchanged */,
  password: /* unchanged */,
  next: z.string().optional(),
});

// inside loginAction, after parsing email/password (pass next through safeParse input):
const next = safeNextPath(parsed.data.next);
const result = await signIn(parsed.data.email, parsed.data.password);
if ("error" in result) return result;
redirect(next);
```

(Read `next` from `formData.get("next")` in the `safeParse` object; import `safeNextPath`.)

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run 'app/(auth)/login/login-structural.test.ts' lib/auth/safe-next-path.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add 'app/(auth)/login/page.tsx' 'app/(auth)/login/login-form.tsx' 'app/(auth)/login/actions.ts' 'app/(auth)/login/login-structural.test.ts'
git commit -m "feat(login): SSO primary with password behind a disclosure; honor next on both paths"
```

---

### Task 4: Close the OIDC open redirect (SSO start + callback)

**Files:**
- Modify: `app/api/auth/sso/route.ts`
- Modify: `app/api/auth/callback/route.ts`
- Modify: `app/api/auth/callback/callback-structural.test.ts`

**Interfaces:**
- Consumes: `safeNextPath` (Task 1).
- Produces: the `oidc_state` cookie only ever carries a validated path; the callback re-validates on the way out (defense in depth — the cookie is httpOnly but the redirect is the last gate before `new URL`).

- [ ] **Step 1: Extend the structural test (failing first)**

Append to `app/api/auth/callback/callback-structural.test.ts` (it already reads the callback source; add a second source read for the SSO route):

```ts
const ssoSrc = readFileSync(
  join(process.cwd(), "app/api/auth/sso/route.ts"),
  "utf8",
);

describe("SSO-NEXT-1: next is validated at both ends", () => {
  it("the SSO start validates before stashing next in the state cookie", () => {
    expect(ssoSrc).toMatch(/safeNextPath/);
  });
  it("the callback re-validates before redirecting (no open redirect)", () => {
    expect(src).toMatch(/safeNextPath/);
    const validate = src.indexOf("safeNextPath");
    const redirectCall = src.indexOf("NextResponse.redirect(new URL(");
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(redirectCall);
  });
});
```

(The existing file's source const may be named `src` — match whatever it uses.)

Run: `npx vitest run 'app/api/auth/callback/callback-structural.test.ts'` — FAIL.

- [ ] **Step 2: Implement**

`app/api/auth/sso/route.ts` line 6:

```ts
const next = safeNextPath(searchParams.get("next"));
```

`app/api/auth/callback/route.ts` — the cookie parse (around line 21) becomes:

```ts
// SSO-NEXT-1 — the cookie is httpOnly, but this is the last gate before
// new URL(): validate here too, so no crafted state can bounce a signed-in
// operator off-site.
const nextUrl = safeNextPath(colonIdx >= 0 ? raw.slice(colonIdx + 1) : null);
```

Both files import `safeNextPath` from `@/lib/auth/safe-next-path`. The final `NextResponse.redirect(new URL(nextUrl, appBase))` line is otherwise unchanged.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/api/auth/callback/callback-structural.test.ts' lib/auth/safe-next-path.test.ts && npx tsc --noEmit`
Expected: PASS (including the pre-existing subject-first assertions).

```bash
git add 'app/api/auth/sso/route.ts' 'app/api/auth/callback/route.ts' 'app/api/auth/callback/callback-structural.test.ts'
git commit -m "fix(auth): validate next at SSO start and callback, closing the open redirect"
```

---

### Task 5: Session long enough for a shift

**Files:**
- Modify: `lib/auth.ts:13`
- Create: `lib/auth/session-duration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `COOKIE_MAX_AGE = 60 * 60 * 12` (12h) — covers a full shift plus handover for a physically controlled, single-tenant floor tablet, without becoming an indefinite session.

- [ ] **Step 1: Write the failing test**

Create `lib/auth/session-duration.test.ts`:

```ts
// FLOOR-SESSION-1 — an 8h cookie expires inside a shift that started
// before login. Pin the duration so a future edit is deliberate.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");

describe("session cookie duration", () => {
  it("is 12 hours — a full shift plus handover", () => {
    expect(src).toMatch(/COOKIE_MAX_AGE = 60 \* 60 \* 12;/);
  });
  it("both the sign-in cookie and createSessionCookie use the constant", () => {
    const uses = src.match(/maxAge: COOKIE_MAX_AGE/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });
});
```

Run: `npx vitest run lib/auth/session-duration.test.ts` — FAIL (still 8).

- [ ] **Step 2: Implement**

`lib/auth.ts:13`:

```ts
// FLOOR-SESSION-1 — 12h: a floor tablet must not log out mid-shift.
// Devices are physically controlled and single-tenant; the cookie stays
// httpOnly + sameSite=lax + secure in production.
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12h
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run lib/auth/session-duration.test.ts && npx tsc --noEmit`

```bash
git add lib/auth.ts lib/auth/session-duration.test.ts
git commit -m "feat(auth): 12h session so floor tablets survive a shift"
```

---

### Task 6: Phase gate — full suite, build, and the ops note

**Files:** none new — this task only runs the gate and reports.

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint` — clean.
- [ ] **Step 2:** `npx vitest run` — all pass (baseline 5747 + additions). Any failure anywhere is this phase's to investigate (superpowers:systematic-debugging). Pay attention to any existing test that asserts a `/login` redirect target or the 8h session.
- [ ] **Step 3:** `npm run build` — completes. A root `middleware.ts` changes the build output (a middleware bundle appears); confirm no build warning about edge-runtime imports (the middleware imports only `next/server`).
- [ ] **Step 4:** Report in the canonical `luma-test-build-deploy` shape, and include this line verbatim so it reaches the human partner:

> Ops task, not shipped in code: Authentik's login screen still uses its stock orange/mountain theme and looks nothing like Luma. Fix it in Authentik's Brand settings on LXC 111 (192.168.1.164) — logo, background, and accent — so operators do not think they left the app.

No push, no deploy — the human reviews first.
