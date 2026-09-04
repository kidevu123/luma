// SSO-NEXT-1 — the guard's redirect target is security-relevant; pin it
// structurally (the runtime path needs a request context vitest doesn't
// provide). A middleware.ts approach was tried and reverted: Next.js
// compiles an Edge bundle whenever middleware.ts exists, which pulled
// instrumentation.ts (OpenTelemetry / @grpc/grpc-js, needing Node builtins)
// into that Edge compile and broke `next build`. The mechanism is now
// explicit: deep-linkable pages pass their own path via `{ next }`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const guards = repo("lib/auth-guards.ts");

describe("requireSession accepts an explicit next destination", () => {
  it("takes an optional { next } and threads it through safeNextPath", () => {
    expect(guards).toMatch(/requireSession\(\s*options\?\s*:\s*GuardOptions\s*\)/);
    expect(guards).toMatch(/safeNextPath\(\s*options\?\.next\s*,\s*""\s*\)/);
  });
  it("builds /login?next= from the safe value, falls back to plain /login", () => {
    expect(guards).toMatch(
      /redirect\(\s*safe\s*\?\s*`\/login\?next=\$\{encodeURIComponent\(safe\)\}`\s*:\s*"\/login"\s*\)/,
    );
  });
  it("requireRole/-Admin/-Lead/-Owner all forward options to requireSession", () => {
    expect(guards).toMatch(/requireRole\(\s*roles:\s*Role\[\]\s*,\s*options\?\s*:\s*GuardOptions\s*\)/);
    expect(guards).toMatch(/requireSession\(options\)/);
    expect(guards).toMatch(/requireRole\(\["OWNER",\s*"ADMIN"\],\s*options\)/);
    expect(guards).toMatch(/requireRole\(\["OWNER",\s*"ADMIN",\s*"MANAGER",\s*"LEAD"\],\s*options\)/);
    expect(guards).toMatch(/requireRole\(\["OWNER"\],\s*options\)/);
  });
  it("wrong-role redirects stay put (not a login problem)", () => {
    expect(guards).toMatch(/redirect\("\/"\)/);
    expect(guards).not.toMatch(/requireRole[\s\S]{0,200}\/login\?next=/);
  });
  it("there is no middleware.ts (Edge bundle broke the build; guards stay per-page)", () => {
    expect(() => repo("middleware.ts")).toThrow();
  });
});

describe("deep-linkable operational pages annotate their own path", () => {
  it("po-closeout list page passes its own path to requireAdmin", () => {
    const page = repo("app/(admin)/po-closeout/page.tsx");
    expect(page).toMatch(/requireAdmin\(\s*\{\s*next:\s*"\/po-closeout"\s*\}\s*\)/);
  });
  it("po-closeout detail page passes the PO-specific path to requireAdmin", () => {
    const page = repo("app/(admin)/po-closeout/[poId]/page.tsx");
    expect(page).toMatch(/requireAdmin\(\s*\{\s*next:\s*`\/po-closeout\/\$\{poId\}`\s*\}\s*\)/);
  });
  it("workflow-submissions page passes its own path to requireSession", () => {
    const page = repo("app/(admin)/workflow-submissions/page.tsx");
    expect(page).toMatch(/requireSession\(\s*\{\s*next:\s*"\/workflow-submissions"\s*\}\s*\)/);
  });
  it("finished-lots/new page passes its own path to requireLead", () => {
    const page = repo("app/(admin)/finished-lots/new/page.tsx");
    expect(page).toMatch(/requireLead\(\s*\{\s*next:\s*"\/finished-lots\/new"\s*\}\s*\)/);
  });
  it("zoho-production-operations page passes its own path to requireSession", () => {
    const page = repo("app/(admin)/zoho-production-operations/page.tsx");
    expect(page).toMatch(/requireSession\(\s*\{\s*next:\s*"\/zoho-production-operations"\s*\}\s*\)/);
  });
});
