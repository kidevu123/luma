// PO-CLOSEOUT-COMMAND-CENTER-1 — structural guarantees (the DB paths need
// Postgres, so behavior is asserted structurally against source).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const loaderSrc = repo("lib/db/queries/po-closeout.ts");
const actionsSrc = repo("app/(admin)/po-closeout/actions.ts");
const listPageSrc = repo("app/(admin)/po-closeout/page.tsx");
const detailPageSrc = repo("app/(admin)/po-closeout/[poId]/page.tsx");
const navSrc = repo("lib/auth/admin-nav.ts");

describe("PO closeout loader — read-only, reuses existing classifiers (no duplication)", () => {
  it("composes the existing pure classifiers / per-row evaluators, not new business logic", () => {
    expect(loaderSrc).toMatch(/evaluateInventoryBagReadiness/);
    expect(loaderSrc).toMatch(/canRepairQrReservation/);
    expect(loaderSrc).toMatch(/getProductionOutputBacklogRow/);
    expect(loaderSrc).toMatch(/evaluateFinishedLotReleaseEligibility/);
    expect(loaderSrc).toMatch(/computeOpenSessionRebaseEligibility/);
    expect(loaderSrc).toMatch(/classifyPoCloseoutRow/);
  });
  it("never mutates any table", () => {
    expect(loaderSrc).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
  it("scopes bags to the PO via the receives.po_id chain", () => {
    expect(loaderSrc).toMatch(/eq\(receives\.poId, poId\)/);
    expect(loaderSrc).toMatch(/innerJoin\(smallBoxes/);
  });
  it("fails closed per row (try/catch around heavy evaluators)", () => {
    expect(loaderSrc).toMatch(/catch\s*\{/);
  });
});

describe("PO-scoped batch actions — reuse existing per-row services, PO-scoped, no Zoho commit", () => {
  it("auto-issue is lead-gated, filters to this PO, reuses repairAutoIssueFinishedLotForWorkflowBag", () => {
    expect(actionsSrc).toMatch(/export async function autoIssueSafeLotsForPoAction/);
    expect(actionsSrc).toMatch(/autoIssueSafeLotsForPoAction[\s\S]{0,220}requireLead\(\)/);
    expect(actionsSrc).toMatch(/loadPoCloseout\(poId\)/);
    expect(actionsSrc).toMatch(/action === "AUTO_ISSUE_FINISHED_LOT"/);
    expect(actionsSrc).toMatch(/repairAutoIssueFinishedLotForWorkflowBag\(/);
  });
  it("auto-release is lead-gated, filters to this PO, re-checks eligibility, reuses setFinishedLotStatus", () => {
    expect(actionsSrc).toMatch(/export async function autoReleaseSafeLotsForPoAction/);
    expect(actionsSrc).toMatch(/action === "AUTO_RELEASE_FINISHED_LOT"/);
    expect(actionsSrc).toMatch(/evaluateFinishedLotReleaseEligibility\(r\.finishedLotId!\)/);
    expect(actionsSrc).toMatch(/setFinishedLotStatus\(\s*r\.finishedLotId!,\s*"RELEASED"/);
  });
  it("writes PO-scoped batch audits and never commits Zoho", () => {
    expect(actionsSrc).toMatch(/scope: "PO"/);
    expect(actionsSrc).toMatch(/po_id: poId/);
    expect(actionsSrc).toMatch(/zoho_output_committed: false/);
    expect(actionsSrc).not.toMatch(/commitZoho|processConsolidatedProductionOutputCommit|committedAt: /i);
  });
  it("caps the batch and reports skipped reasons", () => {
    expect(actionsSrc).toMatch(/PO_BATCH_CAP = 100/);
    expect(actionsSrc).toMatch(/skippedReasons/);
  });
});

describe("PO closeout pages", () => {
  it("list page is admin-gated with a PO search/picker", () => {
    expect(listPageSrc).toMatch(/requireAdmin\(\)/);
    // BAG-PRODUCTION-SUMMARY-1: the index now uses the Active/Closed rollup
    // loader instead of the plain PO options list.
    expect(listPageSrc).toMatch(/listCloseoutPoIndexRollups/);
    expect(listPageSrc).toMatch(/Search PO number or vendor/);
  });
  it("detail page is admin-gated, renders summary cards, filter tabs, checklist, links, batch buttons, plain-language copy", () => {
    expect(detailPageSrc).toMatch(/requireAdmin\(\)/);
    expect(detailPageSrc).toMatch(/loadPoCloseout\(poId\)/);
    expect(detailPageSrc).toMatch(/Ready for action/);
    expect(detailPageSrc).toMatch(/Needs review/);
    expect(detailPageSrc).toMatch(/PoBatchButtons/);
    expect(detailPageSrc).toMatch(/Finalized.{0,40}floor work is complete/);
    expect(detailPageSrc).toMatch(/Done.{0,60}no manual Luma action remains/);
    // Links to existing pages (no new lifecycle surfaces).
    expect(detailPageSrc).toMatch(/\/inbound\/\$\{row\.receiveId\}/);
    expect(detailPageSrc).toMatch(/\/finished-lots\/\$\{row\.finishedLotId\}/);
    expect(detailPageSrc).toMatch(/\/partial-bags/);
    expect(detailPageSrc).toMatch(/\/zoho-production-operations/);
    // Avoid the "open allocation session" jargon in UI copy.
    expect(detailPageSrc).not.toMatch(/open allocation session/i);
  });
  it("is registered in the admin nav under reconciliation & output", () => {
    expect(navSrc).toMatch(/href: "\/po-closeout", label: "PO closeout"/);
  });
});
