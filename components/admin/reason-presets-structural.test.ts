import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("SIMPLIFY-B: reason presets", () => {
  it("component renders chips that fill, never submit", () => {
    const src = repo("components/admin/reason-presets.tsx");
    expect(src).toMatch(/type="button"/);
    expect(src).not.toMatch(/type="submit"/);
    expect(src).toMatch(/onPick/);
  });
  it("release + hold-review + over-consumption + manual-correct inputs offer presets", () => {
    expect(repo("app/(admin)/po-closeout/_drawer/lot-actions.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/finished-lots/[id]/status-actions.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/finished-lots/new/issue-form.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/po-closeout/_drawer/partial-actions.tsx")).toMatch(/ReasonPresets/);
  });
  it("over-consumption presets carry the system's own numbers", () => {
    expect(repo("app/(admin)/finished-lots/new/issue-form.tsx")).toMatch(/Recount: consumed/);
  });
});
