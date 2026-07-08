// RECON-FIXES-1 — structural pins for the PO reconciliation cleanup:
// header duplication, per-tablet summary, weight units, tablet column,
// and the finished-count derivation (source-structural, repo admin style).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const pageSrc = repo("app/(admin)/po-reconciliation/[poId]/page.tsx");
const libSrc = repo("lib/production/po-reconciliation.ts");
const exportSrc = repo("app/(admin)/po-reconciliation/[poId]/export/route.ts");

describe("RECON-FIXES-1 · header", () => {
  it("never prepends 'PO ' to the already-prefixed PO number", () => {
    expect(pageSrc).not.toMatch(/title=\{`PO \$\{recon\.poNumber\}`\}/);
    expect(pageSrc).toMatch(/title=\{recon\.poNumber\}/);
  });

  it("has a cheap page-specific title (no double heavy load)", () => {
    expect(pageSrc).toMatch(/generateMetadata/);
    expect(pageSrc).toMatch(/PO Reconciliation \$\{po\.poNumber\}/);
    expect(pageSrc).not.toMatch(/generateMetadata[\s\S]{0,400}derivePoRawMaterialReconciliation/);
  });
});

describe("RECON-FIXES-1 · per-tablet summary", () => {
  it("Bags received and Vendor declared total carry per-tablet breakdown lines", () => {
    expect(pageSrc).toMatch(/summarizePoTabletBreakdown\(recon\.bagBreakdown\)/);
    const bagsStat = pageSrc.indexOf('label="Bags received"');
    const vendorStat = pageSrc.indexOf('label="Vendor declared total"');
    expect(bagsStat).toBeGreaterThan(-1);
    expect(vendorStat).toBeGreaterThan(-1);
    expect((pageSrc.match(/breakdown=\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("missing declared counts render as Missing/partial, never fabricated", () => {
    expect(pageSrc).toMatch(/"Missing"/);
    expect(pageSrc).toMatch(/\(partial\)/);
    expect(libSrc).toMatch(/never\s+fabricated 0|never fabricated/i);
  });
});

describe("RECON-FIXES-1 · weight units", () => {
  it("render() appends physical units so weights are never bare numbers", () => {
    expect(pageSrc).toMatch(/if \(m\.unit === "g" \|\| m\.unit === "kg"\) return `\$\{text\} \$\{m\.unit\}`;/);
  });

  it("weight MetricResults carry the g unit at the source", () => {
    expect(libSrc).toMatch(/ok\(bag\.weight_grams, "g"\)/);
  });
});

describe("RECON-FIXES-1 · bag table tablet identity", () => {
  it("the bag breakdown table has a Tablet column bound to tabletTypeName", () => {
    expect(pageSrc).toMatch(/<th className="text-left p-2">Tablet<\/th>/);
    expect(pageSrc).toMatch(/b\.tabletTypeName \?\?/);
  });

  it("the CSV export includes the Tablet column", () => {
    expect(exportSrc).toMatch(/"Tablet",/);
    expect(exportSrc).toMatch(/b\.tabletTypeName \?\? ""/);
  });
});

describe("RECON-FIXES-1 · finished counts match workflow-visible truth", () => {
  it("per-bag finished is scoped to THIS bag's workflow runs, not the batch", () => {
    expect(libSrc).toMatch(/WHERE wb\.inventory_bag_id = \$\{inventoryBagId\}/);
    expect(libSrc).not.toMatch(/FROM finished_lot_inputs fli\s+WHERE fli\.batch_id/);
  });

  it("finished uses live packaging-count math under the CURRENT product structure", () => {
    expect(libSrc).toMatch(
      /m\.master_cases \* p\.units_per_display \* p\.displays_per_case\s*\+ m\.displays_made \* p\.units_per_display \+ m\.loose_cards/,
    );
    expect(libSrc).toMatch(/\* p\.tablets_per_unit/);
  });

  it("recovered/excluded runs contribute nothing", () => {
    expect(libSrc).toMatch(/COALESCE\(rbs\.excluded_from_output, false\) THEN 0/);
  });

  it("missing tablets-per-unit makes finished honestly unknown, never fabricated", () => {
    expect(libSrc).toMatch(/conversion_unknown/);
    expect(libSrc).toMatch(/tablets-per-unit is missing — complete product setup/);
  });
});
