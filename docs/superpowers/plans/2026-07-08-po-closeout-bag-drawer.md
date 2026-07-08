# PO Closeout Bag Drawer (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bag row on `/po-closeout/[poId]` opens a drawer with full verification data (summary, timeline, cross-check, Zoho readiness, audit trail) and every applicable closeout action runnable inline — calling the existing server actions verbatim.

**Architecture:** One new read-only aggregate loader (`loadBagCloseoutDetail`, noStore, lazy via server action) + one pure `deriveApplicableBagActions` gate + a `_drawer/` component family whose action panels are thin clients of the EXISTING server actions (partial-bags, finished-lots, zoho-production-operations, QR repair, correction wizard). No new business logic, no new mutation endpoints.

**Tech Stack:** Next.js 15 server actions, Drizzle, vitest (pure + source-structural tests).

## Global Constraints (from spec)

- Reuse existing services/server actions verbatim; no new mutation endpoints.
- No auto Zoho commit; queueing keeps its explicit confirm.
- Page loads and drawer opens strictly read-only; loaders use `unstable_noStore()`.
- Fail closed: unknown verdict → verify-only drawer (no action panels).
- Every mutation keeps its existing audit + revalidation; drawer refetches after each action.
- Version → **1.25.0** (MINOR); CHANGELOG `## [1.25.0] — 2026-07-08`; all gates green before push; deploy + PO-00238 read-only walkthrough.

## Verified interfaces (existing code, reuse as-is)

- `loadBagProductionSummaries({inventoryBagIds})` → `Map<bagId, BagProductionSummary>` (`lib/db/queries/bag-production-summary.ts`)
- `deriveBagGenealogy(workflowBagId)` (`lib/production/metrics`, used by `loadBagEventsAction`)
- `derivePoOutputComparison(poId)` / `listPoSummaries()` (`lib/production/po-reconciliation.ts:1061/149`)
- `evaluateProductSetupReadiness(input)` → `ProductSetupReadiness{missingFields[], autoIssueBlockers[], zohoReady, unknown}` (`lib/production/product-setup-readiness.ts:75`)
- `getActiveZohoProductionOutputOpForLot(lotId)` (`lib/db/queries/zoho-production-output.ts`)
- `listAuditLogsForInventoryBags(bagIds, limit)` (`lib/db/queries/audit-log.ts:51`)
- Server actions (verbatim):
  - `repairQrReservationAction(receiveId, bagId)` — `app/(admin)/inbound/[id]/bag/[bagId]/edit/actions.ts:71`
  - `repairAutoIssueFinishedLotAction(workflowBagId)`, `setFinishedLotStatusAction({id,status,reason})` — `app/(admin)/finished-lots/actions.ts:122/312`
  - `useCalculatedRemainingAction(FormData{inventoryBagId,...})`, `correctPartialBagRemainingAction(FormData{inventoryBagId,reason,newRemaining,method})`, `markPartialBagDepletedAction(FormData{inventoryBagId,reason})` — `app/(admin)/partial-bags/actions.ts:91/166/192`
  - `queueProductionOutputOpAction(FormData{opId})`, `retryPreviewProductionOutputOpAction(FormData{opId})` — `app/(admin)/zoho-production-operations/actions.ts:33/50`
  - `WorkflowRecoveryForm` component (v1.23 wizard) — `app/(admin)/workflow-submissions/_workflow-recovery-form.tsx` (props: workflowBagId, bagFinalized, hasFinishedLot)
- Row verdict: `PoCloseoutRow` (`status`, `action: PoCloseoutAction`, `workflowBagId`, `finishedLotId`, `receiveId`, `zoho`) from `lib/db/queries/po-closeout.ts`.

---

### Task 1: Pure `deriveApplicableBagActions`

**Files:**
- Create: `lib/production/bag-closeout-actions.ts`
- Test: `lib/production/bag-closeout-actions.test.ts`

**Interfaces (produces):**
```typescript
export type BagDrawerActionKey =
  | "REPAIR_QR" | "ISSUE_LOT" | "RELEASE_LOT" | "REVIEW_HOLD"
  | "RESOLVE_PARTIAL" | "ZOHO_QUEUE" | "ZOHO_RETRY" | "CORRECTION_WIZARD";

export function deriveApplicableBagActions(input: {
  rowStatus: string;            // PoCloseoutRowStatus
  rowAction: string;            // PoCloseoutAction
  zoho: string;                 // PoCloseoutZohoStatus
  hasWorkflow: boolean;
  hasFinishedLot: boolean;
  lotStatus: string | null;
  allocationOpen: boolean;
}): BagDrawerActionKey[];
```

Mapping (fail closed — anything unmatched adds nothing; DONE rows and unknown
verdicts return `[]` except CORRECTION_WIZARD which is available whenever
`hasWorkflow` and rowStatus !== "DONE"):
- `REPAIR_QR_RESERVATION` → `["REPAIR_QR"]`
- `AUTO_ISSUE_FINISHED_LOT` → `["ISSUE_LOT"]`
- `AUTO_RELEASE_FINISHED_LOT` → `["RELEASE_LOT"]`
- `REVIEW_QC_HOLD` → `["REVIEW_HOLD"]`
- `CORRECT_STARTING_BALANCE` | `RECORD_REMAINING_OR_CLOSE_PARTIAL` → `["RESOLVE_PARTIAL"]`; also add `RESOLVE_PARTIAL` when `allocationOpen && hasFinishedLot === false && lotStatus == null && rowStatus !== "DONE"`
- `QUEUE_OR_RETRY_ZOHO` → zoho `FAILED` → `["ZOHO_RETRY"]`, else `["ZOHO_QUEUE"]`

- [ ] **Step 1: Write failing tests** — one `it` per mapping row above, plus: DONE row → `[]`; unknown action string → `[]` (or wizard only when hasWorkflow); wizard present for NEEDS_REVIEW row with workflow; wizard absent when `hasWorkflow: false`.
- [ ] **Step 2:** `npx vitest run lib/production/bag-closeout-actions.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the pure mapping exactly as specified.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git add lib/production/bag-closeout-actions.* && git commit -m "feat(closeout-drawer): pure applicable-actions gate"`

### Task 2: `loadBagCloseoutDetail` + server action

**Files:**
- Create: `lib/db/queries/bag-closeout-detail.ts`
- Modify: `app/(admin)/po-closeout/actions.ts` (add `loadBagCloseoutDetailAction`)
- Test: extend `app/(admin)/po-closeout/closeout-freshness.test.ts` (structural)

**Interfaces (produces):**
```typescript
export type BagCloseoutDetail = {
  summary: BagProductionSummary | null;
  timeline: Awaited<ReturnType<typeof deriveBagGenealogy>> | null; // latest workflow, cap 50 events
  crossCheck: { poLine: /* row from derivePoOutputComparison for this bag's flavor */ } | null;
  zohoReadiness: { setup: ProductSetupReadiness | null; op: { id: string; status: string } | null };
  adminActions: Array<{ createdAt: Date; action: string; targetType: string }>; // cap 30, prefix-filtered
  applicableActions: BagDrawerActionKey[];
  evaluatedAt: Date;
};
export async function loadBagCloseoutDetail(args: {
  inventoryBagId: string;
  row: Pick<PoCloseoutRow, "status"|"action"|"zoho"|"workflowBagId"|"finishedLotId"|"lotStatus"|"receiveId">;
  poId: string;
}): Promise<BagCloseoutDetail>;
```

- [ ] **Step 1 (structural test first):** add to closeout-freshness.test.ts: loader file calls `noStore()`, contains no `.insert(|.update(|.delete(|projectEvent|writeAudit`, audit filter uses the spec prefixes (`finished_lot.`, `raw_bag_allocation.`, `workflow_submissions.`, `inventory_bag.`, `qr_card.`, `live_ops_repair.`), caps (50 events / 30 audit rows) present. Run → FAIL (file missing).
- [ ] **Step 2:** Implement: `noStore()`; `loadBagProductionSummaries({inventoryBagIds:[id]})`; timeline = `row.workflowBagId ? deriveBagGenealogy(row.workflowBagId)` with `events.slice(0,50)`; crossCheck = `derivePoOutputComparison(poId)` → pick the line matching the bag's tablet/flavor (fall back null, never throw); zohoReadiness = product row via summary.workflow.productId → `evaluateProductSetupReadiness`, op via `row.finishedLotId ? getActiveZohoProductionOutputOpForLot(...)`; adminActions = `listAuditLogsForInventoryBags([id], 500)` + rows targeting `row.workflowBagId`/`row.finishedLotId` filtered by prefixes, sliced 30; applicableActions = Task 1 fn (allocationOpen from summary.allocation?.isOpen).
- [ ] **Step 3:** `loadBagCloseoutDetailAction(inventoryBagId, rowJson)` in po-closeout/actions.ts: `requireAdmin()`, zod-validate ids, wrap loader, return `{detail}|{error}` (never throw to client).
- [ ] **Step 4:** `npx tsc --noEmit` clean; freshness tests PASS.
- [ ] **Step 5:** Commit `feat(closeout-drawer): read-only bag closeout detail aggregate`.

### Task 3: Drawer shell + verify panel

**Files:**
- Create: `app/(admin)/po-closeout/_drawer/bag-drawer.tsx` (client: expand state, lazy `loadBagCloseoutDetailAction`, refetch(), error state)
- Create: `app/(admin)/po-closeout/_drawer/verify-panel.tsx` (server-safe presentational: `<BagProductionSummaryInline variant="panel">`, cross-check mini-table "Ordered/Received/Produced/Remaining", timeline list reusing the badge styling pattern from workflow-table, Zoho readiness list showing `setup.missingFields[].label` + op status, admin-actions list, `evaluatedAt` line)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (each row gets a chevron toggle rendering `<BagDrawer row={...} poId={poId} />` in a full-width `<tr><td colSpan=7>`)
- Test: extend closeout-freshness.test.ts structural (page renders BagDrawer; drawer refetches after action via `refetch` prop threading)

- [ ] **Step 1:** Structural test additions → FAIL.
- [ ] **Step 2:** Implement components (drawer shows verify panel always; action area only when `detail.applicableActions.length > 0`, else the row's blocked reason).
- [ ] **Step 3:** `npx tsc --noEmit` + `npx vitest run "app/(admin)/po-closeout"` PASS; `npm run build` clean.
- [ ] **Step 4:** Commit `feat(closeout-drawer): verify-in-place drawer on PO closeout rows`.

### Task 4: Action panels (existing actions verbatim)

**Files:**
- Create: `_drawer/qr-actions.tsx` — button → `repairQrReservationAction(receiveId, bagId)`; requires `row.receiveId`.
- Create: `_drawer/lot-actions.tsx` — ISSUE_LOT: button → `repairAutoIssueFinishedLotAction(workflowBagId)`; RELEASE_LOT/REVIEW_HOLD: release/hold buttons → `setFinishedLotStatusAction({id: finishedLotId, status: "RELEASED"|"ON_HOLD", reason})` with required reason input for hold.
- Create: `_drawer/partial-actions.tsx` — three existing FormData actions (`useCalculatedRemainingAction`, `correctPartialBagRemainingAction` with `newRemaining`+`reason`+`method:"PHYSICAL_RECOUNT"` select of `PARTIAL_BAG_RESOLUTION_METHODS`, `markPartialBagDepletedAction` with `reason`) + "Open full workbench" link to `/partial-bags/[inventoryBagId]/resolve`.
- Create: `_drawer/zoho-actions.tsx` — shows readiness blockers; ZOHO_QUEUE: confirm + `queueProductionOutputOpAction(FormData{opId})` (only when op exists and readiness ok — else link to `/zoho-production-operations`); ZOHO_RETRY: `retryPreviewProductionOutputOpAction`. Copy: "Queueing sends to the worker; nothing is committed by this click."
- Create: `_drawer/correction-launcher.tsx` — renders existing `WorkflowRecoveryForm` with `workflowBagId`, `bagFinalized`, `hasFinishedLot` from the row.
- Modify: `_drawer/bag-drawer.tsx` — map `applicableActions` → panels; every panel gets `onDone={refetch}`.
- Test: extend closeout-freshness.test.ts: each panel file imports its action from the existing module path (regex per import); `_drawer/` contains no `"use server"` (no new mutation endpoints).

- [ ] **Step 1:** Structural tests → FAIL.
- [ ] **Step 2:** Implement panels (each ≤ ~120 lines; inline error rendering from action results; disabled-with-reason never shown — panel simply absent when not applicable).
- [ ] **Step 3:** `npx tsc --noEmit`, targeted vitest, `npm run lint` PASS.
- [ ] **Step 4:** Commit `feat(closeout-drawer): act-in-place panels calling existing actions`.

### Task 5: Liveness rollout

**Files:**
- Modify: `app/(admin)/inbound/[id]/page.tsx`, `app/(admin)/packaging-output/page.tsx`, `app/(admin)/partial-bags/page.tsx`, `app/(admin)/finished-lots/page.tsx` — mount `<AutoRefreshOnFocus />` (import from `@/components/admin/auto-refresh-on-focus`) as first child of the page root.
- Test: extend closeout-freshness.test.ts: all four page sources match `/<AutoRefreshOnFocus \/>/`.

- [ ] **Step 1:** Test → FAIL. **Step 2:** Mount component. **Step 3:** Tests PASS. **Step 4:** Commit `feat(liveness): auto-refresh on focus for operational pages`.

### Task 6: Gates, version, deploy, verification

- [ ] `npm run typecheck && npm run typecheck:scripts && npm run lint && npm run test && npm run build` all green.
- [ ] `npm version 1.25.0 --no-git-tag-version`; CHANGELOG `## [1.25.0] — 2026-07-08` (Added — CLOSEOUT-DRAWER-1, summarizing drawer, panels, liveness; Notes: read-only loads, existing actions verbatim, no auto Zoho commit).
- [ ] Pre-deploy read-only invariant snapshot (lots / committed ops / events / QR / allocations) via ssh psql.
- [ ] Commit + push; wait for deploy; `/api/health` → 1.25.0.
- [ ] Post-deploy: invariants unchanged; `/po-closeout/[PO-00238 id]` responds; no non-cron audit rows from deploy.

## Self-review

- Spec coverage: drawer data (5 fields) → Task 2; panels (4 groups + wizard) → Task 4; fail-closed gate → Task 1; liveness → Task 5 + noStore in Task 2; single-form-implementation → satisfied by calling existing actions/components (WorkflowRecoveryForm reused directly; no forms duplicated — partial panel uses the same server actions the workbench buttons use); rollout → Task 6. Guided mode + nav = Phases 2/3, separate plans.
- No placeholders; interfaces named consistently (`BagDrawerActionKey`, `loadBagCloseoutDetail`, `BagCloseoutDetail`).
