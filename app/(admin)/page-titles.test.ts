// PAGE-TITLES-1 + BAG-PRODUCTION-SUMMARY-1 — source-structural checks
// (matching the repo's admin test style; these surfaces are server/DB-bound
// and the default vitest run has no Postgres harness).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("PAGE-TITLES-1 — root layout title template", () => {
  const layoutSrc = repo("app/layout.tsx");

  it("root layout uses a title template so pages render as Luma — <Page>", () => {
    expect(layoutSrc).toMatch(/template:\s*"Luma — %s"/);
    expect(layoutSrc).toMatch(/default:\s*"Luma — Production Command"/);
  });
});

describe("PAGE-TITLES-1 — key pages define page-specific titles", () => {
  const staticTitles: Array<[string, string]> = [
    ["app/(admin)/dashboard/page.tsx", "Dashboard"],
    ["app/(admin)/inbound/page.tsx", "Receiving"],
    ["app/(admin)/receiving/raw-bags/page.tsx", "Receive Raw Pills"],
    ["app/(admin)/packaging-output/page.tsx", "Production Output"],
    ["app/(admin)/po-closeout/page.tsx", "PO Closeout"],
    ["app/(admin)/po-reconciliation/page.tsx", "PO Reconciliation"],
    ["app/(admin)/finished-lots/page.tsx", "Finished Lots"],
    ["app/(admin)/recall/page.tsx", "Traceability Lookup"],
    ["app/(admin)/partial-bags/page.tsx", "Partial Bag Workbench"],
    ["app/(admin)/workflow-submissions/page.tsx", "Workflows"],
    ["app/(admin)/zoho-production-operations/page.tsx", "Zoho Production Output"],
    ["app/(admin)/metrics/page.tsx", "Metrics"],
    ["app/(admin)/settings/page.tsx", "Settings"],
    ["app/(admin)/genealogy/page.tsx", "Bag Genealogy"],
    ["app/(admin)/qc-review/page.tsx", "QC Review"],
    ["app/(admin)/floor-board/page.tsx", "Live Floor"],
  ];

  for (const [file, title] of staticTitles) {
    it(`${file} sets title "${title}"`, () => {
      expect(repo(file)).toMatch(
        new RegExp(
          `export const metadata = \\{ title: "${title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}" \\}`,
        ),
      );
    });
  }

  it("dynamic pages include a useful identifier in the title", () => {
    expect(repo("app/(admin)/inbound/[id]/page.tsx")).toMatch(
      /generateMetadata[\s\S]*Receive \$\{r\.receive\.receiveName\}/,
    );
    expect(repo("app/(admin)/po-closeout/[poId]/page.tsx")).toMatch(
      /generateMetadata[\s\S]*PO Closeout \$\{po\.poNumber\}/,
    );
    expect(repo("app/(admin)/finished-lots/[id]/page.tsx")).toMatch(
      /generateMetadata[\s\S]*Finished Lot \$\{lot\.lot\.finishedLotNumber\}/,
    );
  });
});

describe("BAG-PRODUCTION-SUMMARY-1 — surfaces render the breakdown", () => {
  it("Receive Detail renders Received / Produced / Remaining / Complete per bag", () => {
    const src = repo("app/(admin)/inbound/[id]/page.tsx");
    expect(src).toMatch(/loadBagProductionSummaries\(\{ receiveId: id \}\)/);
    expect(src).toMatch(/BagProductionSummaryInline/);
    expect(src).toMatch(/<TH>Production<\/TH>/);
    // No box-number dependency introduced by the breakdown.
    expect(src).not.toMatch(/summary\.boxNumber|boxNumber.*BagProductionSummary/);
  });

  it("shared component leads with plain labels and honest sources", () => {
    const src = repo("components/admin/bag-production-summary-inline.tsx");
    for (const label of ["Received", "Produced", "Remaining", "Complete", "Source", "Next action"]) {
      expect(src).toContain(label);
    }
    expect(src).toMatch(/Over-consumed: produced output exceeds received quantity/);
    expect(src).toMatch(/Multiple workflows used this bag/);
    expect(src).toMatch(/allocation is still open/);
  });

  it("PO Closeout index has Active / Closed tabs with Active as default", () => {
    const src = repo("app/(admin)/po-closeout/page.tsx");
    expect(src).toMatch(/Active POs/);
    expect(src).toMatch(/Closed POs/);
    expect(src).toMatch(/tab === "closed" \|\| tab === "all" \? \(tab as TabKey\) : "active"/);
    expect(src).toMatch(/listCloseoutPoIndexRollups/);
  });

  it("PO Closeout detail renders per-bag production metrics and view filters", () => {
    const src = repo("app/(admin)/po-closeout/[poId]/page.tsx");
    expect(src).toMatch(/loadBagProductionSummaries\(\{ poId \}\)/);
    expect(src).toMatch(/matchesShowFilter/);
    expect(src).toMatch(/over-consumed/i);
    // CLOSEOUT-DRAWER-1: the per-bag metrics cell moved into the client
    // rows component (which also hosts the drawer).
    expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(
      /BagProductionSummaryInline/,
    );
  });

  it("Production Output, Partial Bags, Finished Lot detail, Recall show source-bag context", () => {
    expect(repo("app/(admin)/packaging-output/page.tsx")).toMatch(
      /loadBagProductionSummariesByWorkflowBag/,
    );
    expect(repo("app/(admin)/partial-bags/page.tsx")).toMatch(/productionSummaries/);
    expect(repo("app/(admin)/finished-lots/[id]/page.tsx")).toMatch(/sourceBagSummary/);
    expect(repo("app/(admin)/recall/page.tsx")).toMatch(/loadBagProductionSummaries/);
  });

  it("loader and pages never mutate on load", () => {
    const loader = repo("lib/db/queries/bag-production-summary.ts");
    expect(loader).not.toMatch(/\.insert\(|\.update\(|\.delete\(|projectEvent|writeAudit/);
    const indexQuery = repo("lib/db/queries/po-closeout.ts");
    expect(indexQuery).toMatch(/listCloseoutPoIndexRollups/);
  });
});
