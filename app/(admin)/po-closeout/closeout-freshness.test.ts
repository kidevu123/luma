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

// CLOSEOUT-DRAWER-1 — drawer UI: verify-in-place + act-in-place with the
// EXISTING server actions only.
describe("bag drawer UI (CLOSEOUT-DRAWER-1)", () => {
  const rowsSrc = repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx");
  const drawerSrc = repo("app/(admin)/po-closeout/_drawer/bag-drawer.tsx");
  const panelsSrc = repo("app/(admin)/po-closeout/_drawer/action-panels.tsx");

  it("detail page renders rows through the drawer table", () => {
    expect(repo("app/(admin)/po-closeout/[poId]/page.tsx")).toMatch(/<CloseoutRows/);
    expect(rowsSrc).toMatch(/<BagDrawer/);
  });

  it("drawer lazy-loads live detail and refetches after actions", () => {
    expect(drawerSrc).toMatch(/loadBagCloseoutDetailAction/);
    expect(drawerSrc).toMatch(/onDone=\{\(\) => void refetch\(\)\}/);
    expect(drawerSrc).toMatch(/router\.refresh\(\)/);
  });

  it("fail closed: no applicable actions renders no action panels", () => {
    expect(panelsSrc).toMatch(/if \(keys\.length === 0\) return null;/);
  });

  it("panels import EXISTING server actions only — no new mutation endpoints in _drawer/", () => {
    const panelImports: Array<[string, RegExp]> = [
      ["qr-actions.tsx", /from "@\/app\/\(admin\)\/inbound\/\[id\]\/bag\/\[bagId\]\/edit\/actions"/],
      ["lot-actions.tsx", /from "@\/app\/\(admin\)\/finished-lots\/actions"/],
      ["partial-actions.tsx", /from "@\/app\/\(admin\)\/partial-bags\/actions"/],
      ["zoho-actions.tsx", /from "@\/app\/\(admin\)\/zoho-production-operations\/actions"/],
      ["correction-launcher.tsx", /_workflow-recovery-form/],
    ];
    for (const [file, pattern] of panelImports) {
      const src = repo(`app/(admin)/po-closeout/_drawer/${file}`);
      expect(src, file).toMatch(pattern);
      expect(src, file).not.toMatch(/"use server"/);
    }
    expect(drawerSrc).not.toMatch(/"use server"/);
    expect(rowsSrc).not.toMatch(/"use server"/);
  });

  it("zoho panel keeps queueing behind an explicit confirm and never commits", () => {
    const src = repo("app/(admin)/po-closeout/_drawer/zoho-actions.tsx");
    expect(src).toMatch(/I confirm this output should be queued/);
    expect(src).toMatch(/nothing is committed by this/i);
    expect(src).not.toMatch(/commit[A-Z]|processConsolidatedProductionOutputCommit/);
  });
});

// CLOSEOUT-DRAWER-1 — liveness rollout: operational pages self-refresh on
// tab focus so corrections propagate to every open surface.
describe("liveness rollout (CLOSEOUT-DRAWER-1)", () => {
  for (const page of [
    "app/(admin)/inbound/[id]/page.tsx",
    "app/(admin)/packaging-output/page.tsx",
    "app/(admin)/partial-bags/page.tsx",
    "app/(admin)/finished-lots/page.tsx",
  ]) {
    it(`${page} mounts AutoRefreshOnFocus`, () => {
      expect(repo(page)).toMatch(/<AutoRefreshOnFocus \/>/);
    });
  }
});

// GUIDED-CLOSEOUT-1 — guided "Close this PO" mode: URL-driven live steps,
// safe batch behind one confirm, no new mutation logic.
describe("guided closeout mode (GUIDED-CLOSEOUT-1)", () => {
  const pageSrc = repo("app/(admin)/po-closeout/[poId]/page.tsx");
  const overlaySrc = repo("app/(admin)/po-closeout/_guided/guided-overlay.tsx");
  const batchSrc = repo("app/(admin)/po-closeout/_guided/safe-batch-step.tsx");

  it("page parses ?guided/step and derives the queue from live rows", () => {
    expect(pageSrc).toMatch(/rawGuided === "1"/);
    expect(pageSrc).toMatch(/deriveGuidedCloseoutQueue\(summary\.rows\)/);
    expect(pageSrc).toMatch(/<GuidedOverlay/);
    expect(pageSrc).toMatch(/Close this PO/);
  });

  it("overlay navigates via plain step links (fresh server render = live recompute)", () => {
    expect(overlaySrc).toMatch(/\?guided=1&step=\$\{n\}/);
    expect(overlaySrc).toMatch(/Queue recomputes from live data at every step/);
    expect(overlaySrc).not.toMatch(/"use server"/);
  });

  it("bag steps reuse the Phase-1 drawer; floor-only steps say skip for now", () => {
    expect(overlaySrc).toMatch(/<BagDrawer/);
    expect(overlaySrc).toMatch(/Needs the floor — skip for now/);
  });

  it("safe batch wraps the two EXISTING PO batch actions behind one confirm and never touches Zoho", () => {
    expect(batchSrc).toMatch(/autoIssueSafeLotsForPoAction/);
    expect(batchSrc).toMatch(/autoReleaseSafeLotsForPoAction/);
    expect(batchSrc).toMatch(/nothing touches Zoho/);
    expect(batchSrc).toMatch(/checkbox/);
    expect(batchSrc).not.toMatch(/"use server"/);
  });

  it("finish screen is honest about what Closed means", () => {
    expect(overlaySrc).toMatch(/flips to Closed when every bag is resolved/);
  });
});
