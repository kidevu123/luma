import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("partial-bags admin resolve workflow", () => {
  it("partial-bags page shows Resolve inventory for Needs review rows", () => {
    const page = read("app/(admin)/partial-bags/page.tsx");
    expect(page).toContain("Resolve inventory");
    expect(page).toContain('row.eligibility === "missing_linkage"');
    expect(page).toContain("Start run blocked");
  });

  it("resolve page requires lead access and shows context", () => {
    const page = read("app/(admin)/partial-bags/[inventoryBagId]/resolve/page.tsx");
    expect(page).toContain("requireLead");
    expect(page).toContain("loadPartialBagReviewContext");
    expect(page).toContain("Sealed card count is shown for traceability only");
  });

  it("server action requires lead and calls ledger resolver", () => {
    const actions = read("app/(admin)/partial-bags/actions.ts");
    expect(actions).toContain("requireLead");
    expect(actions).toContain("resolvePartialBagInventoryLedger");
    expect(actions).toContain('note: z.string().min(1)');
  });

  it("ledger resolver writes audit; ending balance is admin-entered", () => {
    const lib = read("lib/production/partial-bag-review-closeout.ts");
    expect(lib).toContain("partial_bag.inventory_resolution");
    expect(lib).toContain("Never infers remaining from sealed cards");
    expect(lib).toContain("admin_partial_bag_review_closeout");
    expect(lib).toContain("endingBalanceQty: args.remainingTabletCount");
  });

  it("resolve form requires remaining count, method, and note", () => {
    const form = read(
      "app/(admin)/partial-bags/[inventoryBagId]/resolve/resolve-form.tsx",
    );
    expect(form).toContain('name="remainingTabletCount"');
    expect(form).toContain('name="resolutionMethod"');
    expect(form).toContain('name="note"');
    expect(form).toContain("required");
    expect(form).toContain("Do not use sealed card counts");
  });
});
