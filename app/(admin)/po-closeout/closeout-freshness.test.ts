// CLOSEOUT-FRESHNESS-1 — the PO Closeout command center must reflect the
// live database on every request and keep an open tab from silently going
// stale. Source-structural checks (repo's admin test style — these pages
// are server/DB-bound and the default vitest run has no Postgres harness).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");

const indexPageSrc = repo("app/(admin)/po-closeout/page.tsx");
const detailPageSrc = repo("app/(admin)/po-closeout/[poId]/page.tsx");
const loaderSrc = repo("lib/db/queries/po-closeout.ts");
const summaryLoaderSrc = repo("lib/db/queries/bag-production-summary.ts");
const refreshSrc = repo("components/admin/auto-refresh-on-focus.tsx");

describe("PO Closeout pages are dynamic and never statically cached", () => {
  it("index page declares force-dynamic + revalidate 0", () => {
    expect(indexPageSrc).toMatch(/export const dynamic = "force-dynamic";/);
    expect(indexPageSrc).toMatch(/export const revalidate = 0;/);
  });

  it("detail page declares force-dynamic + revalidate 0", () => {
    expect(detailPageSrc).toMatch(/export const dynamic = "force-dynamic";/);
    expect(detailPageSrc).toMatch(/export const revalidate = 0;/);
  });
});

describe("loaders opt out of framework caching and are not memoized", () => {
  it("loadPoCloseout and the index rollup call noStore()", () => {
    expect(loaderSrc).toMatch(
      /import \{ unstable_noStore as noStore \} from "next\/cache";/,
    );
    expect(loaderSrc).toMatch(
      /export async function loadPoCloseout[\s\S]{0,300}noStore\(\);/,
    );
    expect(loaderSrc).toMatch(
      /export async function listCloseoutPoIndexRollups[\s\S]{0,300}noStore\(\);/,
    );
  });

  it("bag production summary loader calls noStore()", () => {
    expect(summaryLoaderSrc).toMatch(
      /export async function loadBagProductionSummaries[\s\S]{0,400}noStore\(\);/,
    );
  });

  it("no closeout loader is wrapped in cache()/unstable_cache", () => {
    for (const src of [loaderSrc, summaryLoaderSrc]) {
      expect(src).not.toMatch(/unstable_cache/);
      expect(src).not.toMatch(/=\s*cache\(/);
    }
  });

  it("loaders remain read-only (no mutation on page load)", () => {
    expect(summaryLoaderSrc).not.toMatch(
      /\.insert\(|\.update\(|\.delete\(|projectEvent|writeAudit/,
    );
    // loadPoCloseout composes classifiers only; it must not write.
    expect(loaderSrc).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});

describe("open tabs cannot silently go stale", () => {
  it("both pages mount AutoRefreshOnFocus", () => {
    expect(indexPageSrc).toMatch(/<AutoRefreshOnFocus \/>/);
    expect(detailPageSrc).toMatch(/<AutoRefreshOnFocus \/>/);
  });

  it("AutoRefreshOnFocus refetches via router.refresh on focus/visibility and never mutates", () => {
    expect(refreshSrc).toMatch(/router\.refresh\(\)/);
    expect(refreshSrc).toMatch(/visibilitychange/);
    expect(refreshSrc).toMatch(/addEventListener\("focus"/);
    // Refetch-only: no server actions, form posts, or direct fetches.
    expect(refreshSrc).not.toMatch(/useActionState|formAction|fetch\(|"use server"/);
  });

  it("both pages render the evaluated-at freshness marker", () => {
    expect(indexPageSrc).toMatch(/Data as of/);
    expect(detailPageSrc).toMatch(/Data as of/);
    expect(loaderSrc).toMatch(/evaluatedAt: new Date\(\)/);
  });
});

describe("mutating actions revalidate the closeout paths", () => {
  it("finished-lot mutations revalidate /po-closeout", () => {
    const src = repo("app/(admin)/finished-lots/actions.ts");
    const count = (src.match(/revalidatePath\("\/po-closeout"\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it("partial-bag mutations revalidate /po-closeout", () => {
    const src = repo("app/(admin)/partial-bags/actions.ts");
    expect(src).toMatch(/revalidatePath\("\/po-closeout"\)/);
  });

  it("PO-scoped batch actions revalidate both index and detail", () => {
    const src = repo("app/(admin)/po-closeout/actions.ts");
    expect(src).toMatch(/revalidatePath\(`\/po-closeout\/\$\{poId\}`\)/);
    expect(src).toMatch(/revalidatePath\("\/po-closeout"\)/);
  });

  it("correction wizard actions revalidate /po-closeout", () => {
    const src = repo("app/(admin)/workflow-submissions/actions.ts");
    expect(src).toMatch(/revalidatePath\("\/po-closeout"\)/);
  });
});

// CLOSEOUT-DRAWER-1 — the bag drawer's detail aggregate is read-only, live,
// and composes existing sources only.
describe("bag closeout detail loader (CLOSEOUT-DRAWER-1)", () => {
  const detailSrc = repo("lib/db/queries/bag-closeout-detail.ts");

  it("opts out of framework caching", () => {
    expect(detailSrc).toMatch(/unstable_noStore as noStore/);
    expect(detailSrc).toMatch(
      /export async function loadBagCloseoutDetail[\s\S]{0,400}noStore\(\);/,
    );
  });

  it("is strictly read-only", () => {
    expect(detailSrc).not.toMatch(
      /\.insert\(|\.update\(|\.delete\(|projectEvent|writeAudit/,
    );
  });

  it("composes existing sources (no recomputation, no new ledger)", () => {
    expect(detailSrc).toMatch(/loadBagProductionSummaries/);
    expect(detailSrc).toMatch(/deriveBagGenealogy/);
    expect(detailSrc).toMatch(/derivePoOutputComparison/);
    expect(detailSrc).toMatch(/evaluateProductSetupReadiness/);
    expect(detailSrc).toMatch(/listAuditLogsForInventoryBags/);
    expect(detailSrc).toMatch(/deriveApplicableBagActions/);
  });

  it("filters the audit trail by the spec prefixes and caps output", () => {
    for (const prefix of [
      "finished_lot.",
      "raw_bag_allocation.",
      "workflow_submissions.",
      "inventory_bag.",
      "qr_card.",
      "live_ops_repair.",
    ]) {
      expect(detailSrc).toContain(`"${prefix}"`);
    }
    expect(detailSrc).toMatch(/TIMELINE_EVENT_CAP = 50/);
    expect(detailSrc).toMatch(/ADMIN_ACTION_CAP = 30/);
  });

  it("is exposed through an admin-gated server action", () => {
    const actionsSrc = repo("app/(admin)/po-closeout/actions.ts");
    expect(actionsSrc).toMatch(
      /loadBagCloseoutDetailAction[\s\S]{0,300}requireAdmin\(\)/,
    );
  });
});
