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
