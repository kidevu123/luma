import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const src = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/actions.ts"), "utf8");

describe("SIMPLIFY-B: repair validation", () => {
  it("starting balance accepts 0 and errors are field-labeled", () => {
    expect(src).toMatch(/repairStartingBalanceQty: z\.coerce\.number\(\)\.int\(\)\.nonnegative\(\)/);
    expect(src).toMatch(/formatZodError\(parsed\.error, LOT_FIELD_LABELS\)/);
    expect(src).not.toMatch(/parsed\.error\.issues\[0\]/);
  });
});
