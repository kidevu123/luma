// STALE-SNAPSHOT-MATH-1 — structural guarantees for the stale
// units_yielded fix (receipt 6337-46: page showed 16,272 tabs, physical
// math said 19,872 — the finalize-time snapshot predated a product
// structure correction). Three layers:
//   1. Display math is live (pure module — covered by unit tests in
//      bag-production-summary.test.ts).
//   2. Product structure edits reproject affected bags in-transaction.
//   3. A bearer-authed maintenance route repairs historical staleness.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("STALE-SNAPSHOT-MATH-1 · product structure edits invalidate snapshots", () => {
  const src = repo("lib/db/queries/products.ts");

  it("updateProduct reprojects this product's bags when packaging structure changes", () => {
    expect(src).toMatch(/structureChanged/);
    expect(src).toMatch(/before\.unitsPerDisplay !== row\.unitsPerDisplay/);
    expect(src).toMatch(/before\.displaysPerCase !== row\.displaysPerCase/);
    expect(src).toMatch(/reprojectBagMetricsForWorkflowBag\(tx, bag\.id\)/);
  });

  it("the reprojection is audited with before/after structure and bag count", () => {
    expect(src).toMatch(/product\.structure_change_reprojection/);
    expect(src).toMatch(/bags_reprojected/);
  });
});

describe("STALE-SNAPSHOT-MATH-1 · maintenance repair route", () => {
  const src = repo("app/api/cron/reproject-stale-bag-metrics/route.ts");

  it("is bearer-authed like the other cron routes (never runs on deploy)", () => {
    expect(src).toMatch(/validateCronBearer/);
    expect(src).toMatch(/cronAuthHttpStatus/);
  });

  it("supports a read-only dry run", () => {
    expect(src).toMatch(/dryRun.*searchParams\.get\("dryRun"\)/s);
    expect(src).toMatch(/dryRun: true, staleCount/);
  });

  it("repairs via the canonical per-bag reprojection (rollups refresh too) and audits the pass", () => {
    expect(src).toMatch(/reprojectBagMetricsForWorkflowBag\(tx, row\.workflow_bag_id\)/);
    expect(src).toMatch(/read_model\.stale_bag_metrics_reprojection/);
    expect(src).toMatch(/REPAIR_CAP = 200/);
  });

  it("staleness is defined as snapshot != live recompute under the CURRENT product structure", () => {
    expect(src).toMatch(/units_yielded <> \(/);
    expect(src).toMatch(/master_cases \* p\.units_per_display \* p\.displays_per_case/);
  });
});

describe("STALE-SNAPSHOT-MATH-1 · summary math is live", () => {
  it("the pure summary recomputes units from counts, never trusting the snapshot when structure exists", () => {
    const src = repo("lib/production/bag-production-summary.ts");
    expect(src).toMatch(/liveUnitsForWorkflow/);
    expect(src).toMatch(/computeUnitsUnderProduct/);
  });

  it("the loader supplies the current packaging structure per workflow", () => {
    const src = repo("lib/db/queries/bag-production-summary.ts");
    expect(src).toMatch(/unitsPerDisplay: products\.unitsPerDisplay/);
    expect(src).toMatch(/displaysPerCase: products\.displaysPerCase/);
  });
});
