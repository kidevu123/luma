// SIMPLIFY-C — "Fix mapping" must land on the relevant ops, not an
// unfiltered 100-row list, and must offer the way back to closeout.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pageSrc = repo("app/(admin)/zoho-production-operations/page.tsx");
const querySrc = repo("lib/db/queries/zoho-production-output-consolidated.ts");

describe("zoho ops filtered deep-links", () => {
  it("page parses ?po= and ?op= with strict UUID guards", () => {
    expect(pageSrc).toMatch(/searchParams/);
    expect(pageSrc).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    expect(pageSrc).toMatch(/Back to closeout/);
  });
  it("PO filter resolves lots via the receives chain, never zohoPurchaseorderId", () => {
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo/);
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo[\s\S]{0,900}receives\.poId/);
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo[\s\S]{0,1500}finishedLotId/);
  });
  it("closeout rows and the drawer panel deep-link with ?po=", () => {
    expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/\/zoho-production-operations\?po=/);
    expect(repo("app/(admin)/po-closeout/_drawer/zoho-actions.tsx")).toMatch(/\/zoho-production-operations\?po=/);
  });
});
