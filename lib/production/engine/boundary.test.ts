import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Task 5 measured 82. Task 7's dead-import cleanup brought it to 80, so
// the ratchet is pinned at the currently measured count rather than the
// original baseline — at 82, two new violations could be added silently.
// (Task 8 briefly reached 79 by sourcing page.tsx's bag label from the
// engine; that rewire was reverted to Phase 4, so 80 is the real count.)
// Phase 4 drives this to zero and flips the rule to "error"; until then
// the only rule is that it must not grow.
const BASELINE_VIOLATIONS = 80;

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

  it("does not let the floor violation count grow", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(["app/(floor)/**/*.{ts,tsx}"]);
    const count = results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === "no-restricted-imports").length;
    expect(count).toBeLessThanOrEqual(BASELINE_VIOLATIONS);
  });
});
