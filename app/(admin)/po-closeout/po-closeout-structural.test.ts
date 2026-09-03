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
  it("SIMPLIFY-B: loader surfaces the latest auto_create_blocked audit reason per bag", () => {
    expect(loaderSrc).toMatch(/mapLatestAutoCreateBlockedByWorkflowBag/);
    expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/Auto-issue blocked:/);
  });
  it("SIMPLIFY-B: product-setup rows deep-link to the product page, not bare /products", () => {
    const rows = repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx");
    expect(rows).toMatch(/\/products\/\$\{row\.productId\}/);
    expect(rows).not.toMatch(/href: "\/products", label: "Open products"/);
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
  it("SIMPLIFY-B: PO bulk issue covers repair-issue-ready rows too", () => {
    expect(actionsSrc).toMatch(/AUTO_ISSUE_FINISHED_LOT" \|\| r\.action === "ISSUE_FINISHED_LOT/);
    expect(detailPageSrc).toMatch(/r\.action === "ISSUE_FINISHED_LOT"/);
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
  it("SIMPLIFY-B: PO bulk calculated-remaining reuses the per-bag service and audits PO-scoped", () => {
    expect(actionsSrc).toMatch(/export async function useCalculatedRemainingForPoAction/);
    expect(actionsSrc).toMatch(/computeSystemDerivedResolutionForBag/);
    expect(actionsSrc).toMatch(/resolveAllocationFromProductionOutput/);
    expect(actionsSrc).toMatch(/raw_bag_allocation\.system_derived_batch/);
    expect(repo("app/(admin)/po-closeout/batch-buttons.tsx")).toMatch(/calcReady/);
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
  it("detail page is admin-gated, renders summary cards, checklist, links, batch buttons, plain-language copy", () => {
    expect(detailPageSrc).toMatch(/requireAdmin\(\)/);
    expect(detailPageSrc).toMatch(/loadPoCloseout\(poId\)/);
    expect(detailPageSrc).toMatch(/PoBatchButtons/);
    expect(detailPageSrc).toMatch(/Finalized.{0,40}floor work is complete/);
    expect(detailPageSrc).toMatch(/Done.{0,60}no manual Luma action remains/);
    // CLOSEOUT-DRAWER-1: row rendering (incl. links to existing pages)
    // moved into the client rows component — no new lifecycle surfaces.
    const rowsSrc = readFileSync(
      join(__dirname, "_drawer", "closeout-rows.tsx"),
      "utf8",
    );
    expect(rowsSrc).toMatch(/\/inbound\/\$\{row\.receiveId\}/);
    expect(rowsSrc).toMatch(/\/finished-lots\/\$\{row\.finishedLotId\}/);
    expect(rowsSrc).toMatch(/\/partial-bags/);
    expect(rowsSrc).toMatch(/\/zoho-production-operations/);
    // Avoid the "open allocation session" jargon in UI copy.
    expect(detailPageSrc).not.toMatch(/open allocation session/i);
  });
  it("SIMPLIFY-A: inline row action reuses EXISTING finished-lot actions, no new mutation endpoints", () => {
    const src = repo("app/(admin)/po-closeout/_drawer/row-action-button.tsx");
    expect(src).toMatch(/from "@\/app\/\(admin\)\/finished-lots\/actions"/);
    expect(src).toMatch(/repairAutoIssueFinishedLotAction/);
    expect(src).toMatch(/setFinishedLotStatusAction/);
    expect(src).not.toMatch(/"use server"/);
    expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/RowActionButton/);
    expect(repo("app/(admin)/po-closeout/_drawer/row-action-button.tsx")).toMatch(/useCalculatedRemainingAction/);
  });
  it("detail page renders bucket tabs from the pure bucket classifier (no inline policy)", () => {
    expect(detailPageSrc).toMatch(/deriveCloseoutBucket/);
    expect(detailPageSrc).toMatch(/summarizeBuckets/);
    expect(detailPageSrc).toMatch(/recommendCloseoutNextAction/);
    expect(detailPageSrc).toMatch(/"do-here"/);
    expect(detailPageSrc).toMatch(/Waiting on Zoho/);
    expect(detailPageSrc).toMatch(/empty bag/i);
  });
  it("is registered in the admin nav under reconciliation & output", () => {
    expect(navSrc).toMatch(/href: "\/po-closeout", label: "Close out POs"/);
  });
  it("SIMPLIFY-A: zero-bag POs are collapsed, not full rows", () => {
    expect(listPageSrc).toMatch(/bagCount === 0/);
    expect(listPageSrc).toMatch(/nothing to close out/i);
    expect(listPageSrc).toMatch(/<details/);
  });
});

describe("QUEUE-FIX-1: zoho-actions drawer — surfaces action refusals; disables queue for non-queueable ops", () => {
  const zohoActionsSrc = readFileSync(
    join(__dirname, "_drawer", "zoho-actions.tsx"),
    "utf8",
  );
  const zohoOpActionsSrc = repo(
    "app/(admin)/zoho-production-operations/actions.ts",
  );

  it("queueProductionOutputOpAction returns a result object, not void", () => {
    // Return type must be Promise<{ ok: true } | { ok: false; error: string }>
    expect(zohoOpActionsSrc).toMatch(
      /queueProductionOutputOpAction[\s\S]{0,200}Promise<\s*\{\s*ok:\s*true\s*\}\s*\|\s*\{\s*ok:\s*false;\s*error:\s*string\s*\}/,
    );
  });

  it("retryPreviewProductionOutputOpAction returns a result object, not void", () => {
    expect(zohoOpActionsSrc).toMatch(
      /retryPreviewProductionOutputOpAction[\s\S]{0,200}Promise<\s*\{\s*ok:\s*true\s*\}\s*\|\s*\{\s*ok:\s*false;\s*error:\s*string\s*\}/,
    );
  });

  it("action guard returns { ok: false, error } instead of bare return", () => {
    // Both actions must return an error object when auth fails, not silently return void.
    expect(zohoOpActionsSrc).toMatch(/ok: false, error: "Not authorized\."/);
    expect(zohoOpActionsSrc).toMatch(/ok: false, error: "Missing operation id\."/);
  });

  it("drawer captures the action result and renders an error branch on failure", () => {
    // actionError state and the error paragraph must both exist.
    expect(zohoActionsSrc).toMatch(/actionError/);
    expect(zohoActionsSrc).toMatch(/border-red-200.*bg-red-50|bg-red-50.*border-red-200/);
    // On !ok, setActionError is called instead of onDone.
    expect(zohoActionsSrc).toMatch(/setActionError\(result\.error\)/);
    // onDone is only called on success (result.ok is checked before calling onDone).
    expect(zohoActionsSrc).toMatch(/result\.ok[\s\S]{0,200}onDone\(\)/);
  });

  it("QUEUE button disabled condition references READY and FAILED statuses", () => {
    // QUEUEABLE_STATUSES must include both READY and FAILED.
    expect(zohoActionsSrc).toMatch(/QUEUEABLE_STATUSES/);
    expect(zohoActionsSrc).toMatch(/"READY"/);
    expect(zohoActionsSrc).toMatch(/"FAILED"/);
    // notQueueable is used in the disabled prop.
    expect(zohoActionsSrc).toMatch(/notQueueable/);
    expect(zohoActionsSrc).toMatch(/disabled=\{[\s\S]{0,80}notQueueable/);
  });

  it("renders an inline reason when the op cannot be queued", () => {
    // The human-readable refusal message appears in the drawer.
    expect(zohoActionsSrc).toMatch(/Cannot queue/);
    expect(zohoActionsSrc).toMatch(/resolve the blocker first/);
  });
});

describe("DRAWER-FRESHNESS-1: panel keys track live row facts; finished-lot actions revalidate closeout paths", () => {
  const drawerSrc = readFileSync(join(__dirname, "_drawer", "bag-drawer.tsx"), "utf8");
  const panelsSrc = readFileSync(join(__dirname, "_drawer", "action-panels.tsx"), "utf8");
  const finishedLotActionsSrc = repo("app/(admin)/finished-lots/actions.ts");

  it("action-panels derives keys from the live row prop via deriveApplicableBagActions (not from a one-time snapshot)", () => {
    // Must import and call deriveApplicableBagActions with row prop fields,
    // not read keys directly from detail.applicableActions.
    expect(panelsSrc).toMatch(/deriveApplicableBagActions/);
    expect(panelsSrc).toMatch(/rowStatus: row\.status/);
    expect(panelsSrc).toMatch(/rowAction: row\.action/);
    // allocationOpen comes from the fetched detail, not from a stale snapshot.
    expect(panelsSrc).toMatch(/allocationOpen: detail\./);
    // Must NOT use detail.applicableActions as the primary keys source.
    expect(panelsSrc).not.toMatch(/const keys = detail\.applicableActions/);
  });

  it("bag-drawer refetches when row action/status/finishedLotId change (not only on mount)", () => {
    // A useEffect must key on row.action, row.status, and row.finishedLotId
    // so that a revalidation + router.refresh() triggers a detail re-fetch.
    expect(drawerSrc).toMatch(/row\.action/);
    expect(drawerSrc).toMatch(/row\.status/);
    expect(drawerSrc).toMatch(/row\.finishedLotId/);
    // prevRowKeyRef (or equivalent tracking) ensures the re-fetch is reactive
    // to row changes after the initial mount load.
    expect(drawerSrc).toMatch(/prevRowKeyRef|row\.action[\s\S]{0,400}refetch/);
  });

  it("repairAutoIssueFinishedLotAction revalidates the dynamic closeout detail path", () => {
    expect(finishedLotActionsSrc).toMatch(
      /repairAutoIssueFinishedLotAction[\s\S]{0,600}revalidatePath\("\/po-closeout\/\[poId\]", "page"\)/,
    );
  });

  it("setFinishedLotStatusAction revalidates the dynamic closeout detail path", () => {
    expect(finishedLotActionsSrc).toMatch(
      /setFinishedLotStatusAction[\s\S]{0,700}revalidatePath\("\/po-closeout\/\[poId\]", "page"\)/,
    );
  });
});

describe("COMMIT-EVIDENCE-1: zoho readiness box shows committed timestamp + ref when op is COMMITTED", () => {
  // Operator request: after auto-commit, the drawer must display proof of
  // commit (timestamp + Zoho reference) instead of just the status label.
  const verifyPanelSrc = readFileSync(join(__dirname, "_drawer", "verify-panel.tsx"), "utf8");
  const bagCloseoutDetailSrc = repo("lib/db/queries/bag-closeout-detail.ts");

  it("verify-panel guards on status === 'COMMITTED' before rendering commit evidence", () => {
    expect(verifyPanelSrc).toMatch(/status === "COMMITTED"/);
  });

  it("verify-panel renders committed timestamp via formatDateTimeEst when committedAt is set", () => {
    // Must check committedAt != null before rendering.
    expect(verifyPanelSrc).toMatch(/committedAt/);
    expect(verifyPanelSrc).toMatch(/formatDateTimeEst/);
    // Must render the human copy "Committed to Zoho".
    expect(verifyPanelSrc).toMatch(/Committed to Zoho/);
  });

  it("verify-panel renders externalReferenceId when present", () => {
    expect(verifyPanelSrc).toMatch(/externalReferenceId/);
    // Renders it with a label such as "ref".
    expect(verifyPanelSrc).toMatch(/ref\s/);
  });

  it("bag-closeout-detail threads committedAt and externalReferenceId into the op field", () => {
    // The op shape in BagCloseoutDetail must include both fields.
    expect(bagCloseoutDetailSrc).toMatch(/committedAt/);
    expect(bagCloseoutDetailSrc).toMatch(/externalReferenceId/);
    // Both fields must be populated from getActiveZohoProductionOutputOpForLot result.
    expect(bagCloseoutDetailSrc).toMatch(/activeOp\.committedAt/);
    expect(bagCloseoutDetailSrc).toMatch(/activeOp\.externalReferenceId/);
  });
});
