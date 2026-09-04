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
