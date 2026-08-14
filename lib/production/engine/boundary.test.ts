import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// The ratchet that used to live here (BASELINE_VIOLATIONS, pinned at each
// task's measured count: 82 -> 80 -> 75 -> 48) is gone. Task 6 drove the
// floor's lib/production violations to zero and flipped the rule from
// "warn" to "error" in eslint.config.mjs — `npm run lint` now fails
// outright on a new deep import instead of merely not regressing a count,
// which is strictly stronger than the ratchet it replaces. The four
// probes below (two "blocked" shapes, two "allowed" shapes) plus the
// severity check are what's left to guard the rule itself.

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

  it("enforces the boundary as an error, not a warning", async () => {
    // Task 6: the floor's lib/production violations reached zero and
    // eslint.config.mjs flipped the rule from "warn" to "error". ESLint's
    // Linter.Severity is 1 = warn, 2 = error — a regression back to
    // "warn" would still show messages (so the other probes here would
    // stay green) but `npm run lint` would exit 0 on a real violation.
    // This is the one assertion that would catch that regression.
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
    expect(restricted[0]?.severity).toBe(2);
  });
});
