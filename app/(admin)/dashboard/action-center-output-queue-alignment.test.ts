// The "Needs lot review" tile on the Dashboard Action Center must
// report the same number that the Production Output queue shows when
// the operator clicks through. Drift between the two has bitten us
// before — a tile that says "46" linking to a page that looks empty
// is worse than no tile at all.
//
// We enforce alignment two ways:
//   1. The Action Center count delegates to countProductionOutputBacklog()
//      — the same function the packaging-output page calls for its
//      header copy. There is no inline subquery anymore.
//   2. countProductionOutputBacklog() and listProductionOutputBacklogWithEligibility()
//      live in the same module and apply the same three predicates.
//      If anyone weakens or strengthens one, this test catches it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

const loaders = read("app/(admin)/dashboard/loaders.ts");
const backlog = read("lib/db/queries/production-output-backlog.ts");
const dashboard = read("app/(admin)/dashboard/page.tsx");
const packagingOutput = read("app/(admin)/packaging-output/page.tsx");

describe("Action Center / Output queue alignment", () => {
  it("dashboard loaders.ts delegates needsLotReview to countProductionOutputBacklog", () => {
    // No more inline SELECT COUNT(*) ... needs_lot_review subquery.
    expect(loaders).not.toMatch(/needs_lot_review/);
    expect(loaders).toMatch(/countProductionOutputBacklog/);
  });

  it("countProductionOutputBacklog applies the canonical three predicates", () => {
    // finalized_at not null
    expect(backlog).toMatch(/isNotNull\(workflowBags\.finalizedAt\)/);
    // finished_lots.id IS NULL
    expect(backlog).toMatch(/isNull\(finishedLots\.id\)/);
    // excluded_from_output = false (default to false when null)
    expect(backlog).toMatch(
      /COALESCE\(\$\{readBagState\.excludedFromOutput\}, false\) = false/,
    );
  });

  it("listProductionOutputBacklogWithEligibility applies the same three predicates", () => {
    const listSlice = backlog.slice(
      backlog.indexOf("listProductionOutputBacklogWithEligibility"),
    );
    expect(listSlice).toMatch(/isNotNull\(workflowBags\.finalizedAt\)/);
    expect(listSlice).toMatch(/isNull\(finishedLots\.id\)/);
    expect(listSlice).toMatch(
      /COALESCE\(\$\{readBagState\.excludedFromOutput\}, false\) = false/,
    );
  });

  it("the Action Center tile deep-links to the queue anchor on /packaging-output", () => {
    // The whole point of the alignment work: clicking the tile drops
    // the operator at the visible queue, not the top of the page.
    expect(dashboard).toMatch(
      /label:\s*"Needs lot review"[\s\S]*?href:\s*"\/packaging-output#output-queue"/,
    );
  });

  it("/packaging-output renders the #output-queue anchor", () => {
    expect(packagingOutput).toMatch(/id=["']output-queue["']/);
  });

  it("/packaging-output surfaces the FULL count, not just the rendered slice", () => {
    // countProductionOutputBacklog() is loaded alongside the list so
    // the header can say "Showing 20 of 46". Without this the user
    // can't tell whether the 20 visible bags are the whole story.
    expect(packagingOutput).toMatch(/countProductionOutputBacklog/);
    expect(packagingOutput).toMatch(/awaitingLotTotal/);
  });
});
