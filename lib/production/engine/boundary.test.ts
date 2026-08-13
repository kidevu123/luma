import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Task 5 measured 82. Task 7's dead-import cleanup brought it to 80, so
// the ratchet is pinned at the currently measured count rather than the
// original baseline — at 82, two new violations could be added silently.
// (Task 8 briefly reached 79 by sourcing page.tsx's bag label from the
// engine; that rewire was reverted to Phase 4, so 80 is the real count.)
// The final review closed the deep-path hole in the rule's group (a lone
// "*" does not cross "/", so "@/lib/production/engine/<file>" imports were
// unrestricted) and moved actions.ts onto the barrel. Re-measured after
// both changes: still 80 — the only deep engine import in floor code was
// that one line, and it now resolves to the permitted barrel.
// P4a Task 1 took it to 75: extracting packagingCompleteAction's body to
// lib/production/engine/record-packaging-complete.ts left 5 lib/production
// imports in actions.ts with no remaining reference, and they went with
// the body. Re-pinned, because a stale 80 leaves exactly the slack this
// comment warns about. Trail: 82 -> 80 -> (79, reverted) -> 80 -> 75.
// P4b Task 5 (THE CUTOVER) took it to 48. Three things moved it:
// page.tsx dropped from 22 imports to 2 (getStationView is the only read
// left, and everything it used to resolve inline went with the panels);
// stage-action-buttons.tsx (9) and scan-card-form.tsx (3) were DELETED
// outright, since no route uses them after the cutover. Re-pinned,
// because a stale 60 leaves exactly the slack this comment warns about.
// Trail: 82 -> 80 -> (79, reverted) -> 80 -> 75 -> 48.
// Task 6 drives this to zero and flips the rule to "error"; until then
// the only rule is that it must not grow.
const BASELINE_VIOLATIONS = 48;

describe("floor import boundary", () => {
  it("blocks a non-engine lib/production import from floor code", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      `import { loadPartialReuseContext } from "@/lib/production/partial-bags";\n` +
        `export const x = loadPartialReuseContext;\n`,
      { filePath: "app/(floor)/floor/[token]/boundary-probe.ts" },
    );
    const restricted = (result?.messages ?? []).filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restricted).toHaveLength(1);
  });

  it("permits importing the engine barrel from floor code", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      `import { resolveOperation } from "@/lib/production/engine";\n` +
        `export const x = resolveOperation;\n`,
      { filePath: "app/(floor)/floor/[token]/boundary-probe.ts" },
    );
    const restricted = (result?.messages ?? []).filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restricted).toHaveLength(0);
  });

  it("permits the CLIENT engine barrel from floor code", async () => {
    // P4b Task 5: `"use client"` files cannot import the server barrel —
    // it re-exports getStationView/advanceBag/station-token, every one of
    // which imports @/lib/db, and the Next build fails on
    // `Can't resolve 'perf_hooks'` when the Postgres driver lands in a
    // browser bundle. engine/client.ts is the pure half, and it is the
    // ONLY other permitted path.
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      `import { partialScreenFor } from "@/lib/production/engine/client";\n` +
        `export const x = partialScreenFor;\n`,
      { filePath: "app/(floor)/floor/[token]/boundary-probe.ts" },
    );
    const restricted = (result?.messages ?? []).filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restricted).toHaveLength(0);
  });

  it("blocks a DEEP engine import from floor code", async () => {
    // The barrel is the only permitted entry point. Reaching past it into
    // a specific engine module must be restricted exactly like a
    // non-engine lib/production import — this is the hole the final review
    // found: minimatch "*" does not cross "/", so before the group gained
    // "@/lib/production/*/**" this probe reported 0.
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(
      `import { recordStageEvent } from "@/lib/production/engine/record-stage-event";\n` +
        `export const x = recordStageEvent;\n`,
      { filePath: "app/(floor)/floor/[token]/boundary-probe.ts" },
    );
    const restricted = (result?.messages ?? []).filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(restricted).toHaveLength(1);
  });

  it("does not let the floor violation count grow", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(["app/(floor)/**/*.{ts,tsx}"]);
    const count = results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === "no-restricted-imports").length;
    expect(count).toBeLessThanOrEqual(BASELINE_VIOLATIONS);
  });
});
