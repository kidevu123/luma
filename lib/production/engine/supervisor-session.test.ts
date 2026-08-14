// P5-SUPERVISOR Task 2 — supervisor-session module tests.
//
// PURE-LOGIC COVERAGE. supervisorSessionRemainingSeconds is the
// engine's only pure export from this module; it drives the tablet
// banner countdown. Positive / zero-clamp / past-expiry are the
// three cases the ticker actually renders, so all three are pinned.
//
// SOURCE SCAN. openSupervisorSession's contract is that the string
// `pin` NEVER appears outside the input-type field and the
// verifyPassword call site — that is what makes the module unloggable
// by construction. Static string search on the module source is a
// weaker test than a runtime assertion, but the runtime cost of "we
// never wrote pin material to audit_log" is a database round-trip;
// the source scan catches the same drift in the file that would
// introduce it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  SUPERVISOR_SESSION_TTL_MS,
  supervisorSessionRemainingSeconds,
} from "./supervisor-session";

describe("supervisorSessionRemainingSeconds — floor banner ticker", () => {
  it("returns the whole-seconds gap when the session is still live", () => {
    const now = new Date("2026-08-14T10:00:00Z");
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // +5m
    expect(supervisorSessionRemainingSeconds(expiresAt, now)).toBe(5 * 60);
  });

  it("truncates sub-second remainders so the ticker never rounds up", () => {
    // A ticker that ROUNDED instead of floored would flash "16" at
    // t=15.6s remaining, which is a lie about the TTL the operator
    // is watching.
    const now = new Date("2026-08-14T10:00:00.400Z");
    const expiresAt = new Date("2026-08-14T10:00:15.900Z");
    expect(supervisorSessionRemainingSeconds(expiresAt, now)).toBe(15);
  });

  it("clamps to zero at the moment of expiry", () => {
    const now = new Date("2026-08-14T10:00:00Z");
    expect(supervisorSessionRemainingSeconds(now, now)).toBe(0);
  });

  it("clamps to zero for a past-expiry (negative-diff) call", () => {
    // The ticker keeps calling this on its own interval; a session
    // that expired between ticks must not render as negative seconds.
    const now = new Date("2026-08-14T10:00:10Z");
    const expiresAt = new Date("2026-08-14T10:00:00Z");
    expect(supervisorSessionRemainingSeconds(expiresAt, now)).toBe(0);
  });

  it("SUPERVISOR_SESSION_TTL_MS is the spec-locked 15 minutes", () => {
    // The plan / spec pin this to 15 minutes; if the constant drifts,
    // every gate downstream shifts with it. Pin it here so the drift
    // fails a test instead of failing a smoke months later.
    expect(SUPERVISOR_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("supervisor-session.ts — PIN material discipline (source scan)", () => {
  const src = readFileSync(join(__dirname, "supervisor-session.ts"), "utf8");

  it("mentions the identifier `pin` (lowercase) ONLY in the input-type field and the verify call site", () => {
    // Case-SENSITIVE lowercase match. The plan's own operator sentence
    // contains the human-facing word "PIN" ("That code and PIN
    // combination does not unlock this station."), which is prose in a
    // string literal, not the identifier that carries pin material.
    // Comments are stripped first so the header (which discusses the
    // design in prose) doesn't count as a real occurrence — the
    // invariant is about code, not the module docstring above it.
    const stripped = stripComments(src);
    const hits = Array.from(
      stripped.matchAll(/\bpin\b/g),
      (m) => ({ index: m.index ?? 0, matched: m[0] }),
    );

    // The two allowed occurrences of the identifier `pin`:
    //   1. `pin: string;` — the OpenSupervisorSessionInput.pin field
    //   2. `verifyPassword(input.pin, ...)` — the argon2id verify call
    // Any other hit means pin material touched a line it shouldn't
    // (audit payload, error message, log, comment made real by an edit).
    const contexts = hits.map((h) =>
      stripped.slice(Math.max(0, h.index - 40), h.index + 40),
    );

    const allowed = (ctx: string): boolean =>
      /pin:\s*string/.test(ctx) ||
      /verifyPassword\(input\.pin/.test(ctx);

    const disallowed = contexts.filter((c) => !allowed(c));
    expect(disallowed).toEqual([]);

    // Non-vacuous: both allowed occurrences MUST actually be present,
    // otherwise a rename that dropped the field would silently pass
    // this test.
    expect(contexts.some((c) => /pin:\s*string/.test(c))).toBe(true);
    expect(contexts.some((c) => /verifyPassword\(input\.pin/.test(c))).toBe(
      true,
    );
  });

  it("never writes the identifier `pin` into an audit payload or an error message", () => {
    // Belt-and-braces: even if the previous test drifted, this one
    // catches the specific classes of misuse the plan calls out —
    // pin material never in payloads, never in error strings.
    // Case-sensitive `\bpin\b` again — see previous test for why
    // uppercase "PIN" in the operator sentence is not the invariant.
    const stripped = stripComments(src);
    const suspects = [
      /writeAudit\([\s\S]*?\bpin\b[\s\S]*?\)/,
      /new Error\([^)]*\bpin\b[^)]*\)/,
      /throw new Error\([^)]*\bpin\b[^)]*\)/,
      /operatorSentence:[^,}]*\bpin\b/,
    ];
    for (const re of suspects) {
      expect(stripped).not.toMatch(re);
    }
  });
});

/** Strip TS-style line and block comments. Deliberately naive — good
 *  enough to keep prose in the module header from being mistaken for
 *  code. A production string parser is overkill for a source-scan
 *  test whose only job is "does the module TEXT under any interpretation
 *  break the invariant." */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1: string) => p1);
}
