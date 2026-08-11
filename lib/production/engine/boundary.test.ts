import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("floor import boundary", () => {
  it("is declared in the eslint config", () => {
    const config = readFileSync(join(process.cwd(), "eslint.config.mjs"), "utf8");
    expect(config).toContain("lib/production/engine");
    expect(config).toContain("no-restricted-imports");
  });
});
