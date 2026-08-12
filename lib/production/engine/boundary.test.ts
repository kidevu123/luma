import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// Baseline measured at Task 5. Phase 4 drives this to zero and flips the
// rule to "error"; until then the only rule is that it must not grow.
const BASELINE_VIOLATIONS = 82;

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
