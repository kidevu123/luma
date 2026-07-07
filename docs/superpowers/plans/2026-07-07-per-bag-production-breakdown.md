# Per-Bag Production Breakdown + PO Closeout Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins per-bag Received / Produced / Remaining / Complete% (with honest sources and flags) on Receive Detail, PO Closeout, Production Output, Partial Bags, Finished Lot detail, and Recall; add Active/Closed filtering to the PO Closeout index; make browser titles page-specific.

**Architecture:** One shared read-only summary: pure compute in `lib/production/bag-production-summary.ts` + batch loader in `lib/db/queries/bag-production-summary.ts` that reuses canonical sources (inventory_bags counts, read_bag_metrics/deriveStageOutputForBag outputs, `computeExpectedTabletConsumptionFromProduct` conversion, allocation sessions, finished_lots, zoho ops). One shared presentational component renders it everywhere. No new ledger, no mutations, no new business rules — display classification only, fail-closed to "Needs review".

**Tech Stack:** Next.js 15 metadata API, Drizzle batch queries (inArray), vitest pure + source-contract tests.

## Global Constraints

- Read-only feature: no mutation on load, no auto-issue/release/queue/commit, no QR/allocation/workflow state change.
- Data honesty (luma-data-honesty skill): missing ≠ zero ("Needs review — production/remaining unknown"), estimated vs actual labeled, negative remaining NOT clamped, LOW/MEDIUM confidence never displayed as confirmed.
- Floor language (luma-workflow-ux): lead with Received / Produced / Remaining / Complete / Source / Next action; allocation jargon only as secondary detail.
- No box-number dependency.
- Version → **1.24.0** (MINOR); CHANGELOG `## [1.24.0] — 2026-07-07`; all gates green before push.

## Verified source-of-truth rules (from recon)

- **Received tablets:** `inventory_bags.pill_count` (label `Actual`) else `declared_pill_count` (label `Supplier-declared`); both missing → `Missing`, never 0.
- **Produced tablets per workflow:** finalized → `read_bag_metrics.units_yielded × products.tablets_per_unit` (source `Packaging counts`); non-finalized/no metrics → `deriveStageOutputForBag` deepest output (FINISHED > PACKAGING > SEALING, existing `pickDeepestOutput` semantics) × tablets_per_unit (source `Sealing counts` when that's the deepest); missing tablets_per_unit or no output events → unknown (`consumptionUnknown`), never 0. Sum across all workflows for the bag.
- **Expected remaining:** received − produced (both known). Negative allowed → `overConsumed`.
- **Recorded remaining:** latest terminal allocation session — CLOSED/RETURNED_TO_STOCK → `ending_balance_qty` (+ `ending_balance_source` label), DEPLETED → 0. OPEN session → no recorded value; flag `Allocation still open` when output exists.
- **Mismatch:** both known and different → `remainingMismatch` with difference shown.
- **Multi-workflow bags** (2 exist in prod): total produced + workflow count + `multipleWorkflows` flag + latest workflow state.
- **Zoho status labels:** reuse v1.22.1 done-policy vocabulary (Committed / Queued / Ready to queue / Needs mapping / Failed / Not required).

### Task 1: Pure summary module (TDD)

**Files:** Create `lib/production/bag-production-summary.ts`, test `lib/production/bag-production-summary.test.ts`.

DTO per spec (`BagProductionSummary`) with `computeBagProductionSummary(input)` pure over pre-loaded facts:
```typescript
type BagSummaryWorkflowInput = {
  workflowBagId: string; productId: string | null; productName: string | null;
  productKind: string | null; tabletsPerUnit: number | null;
  stage: string | null; isFinalized: boolean; finalizedAt: Date | null;
  excludedFromOutput: boolean; recoveryStatus: string | null;
  metrics: { masterCases: number; displaysMade: number; looseCards: number;
             damagedPackaging: number; rippedCards: number; unitsYielded: number } | null;
  deepestOutput: { stage: "FINISHED" | "PACKAGING" | "SEALING"; units: number } | null;
};
```
Unit tests: every case in spec Task I (untouched bag, packaging output, finalized-awaiting-lot, pending QC, released-not-queued, committed, CLOSED/RETURNED/DEPLETED recorded remaining, open+system-derived, mismatch, over-consumed not clamped, multi-workflow, recovered/excluded, missing conversion → needs review with produced unknown, card + bottle routes).
`deriveBagNextAction` mapping (fail-closed): no QR reserve → handled by floor readiness upstream; not started → "Start workflow"; on floor → "Finalize workflow"; finalized no lot → "Issue finished lot / review"; open allocation w/ output → "Resolve remaining"; lot PENDING_QC → "Release lot (QC)"; RELEASED + zoho ready → "Queue Zoho"; needs mapping → "Fix Zoho mapping"; queued/committed/not-required → "Done"; recovered → "Wrong route recovered"; ambiguity → "Needs review".

### Task 2: Batch loader

**Files:** Create `lib/db/queries/bag-production-summary.ts`.

`loadBagProductionSummaries(args: { inventoryBagIds?: string[]; receiveId?: string; poId?: string; workflowBagIds?: string[] })` → `Map<inventoryBagId, BagProductionSummary>` (+ helper `loadBagProductionSummaryForWorkflowBags` returning keyed-by-workflow map). Batch queries with `inArray`; per-workflow `deriveStageOutputForBag` only when metrics row absent. Cap 200 bags. Zoho status normalized identically to po-closeout loader (zohoRequired via `isProductionOutputPersistEnabled()`).

### Task 3: Receive Detail breakdown (`app/(admin)/inbound/[id]/page.tsx`)

Add a "Production" cell/section per bag row: `Received N · Produced N · Remaining N · Complete P%` + compact source line + output counts + workflow-state chip + next-action text; summary panel component `components/bag-production-summary-inline.tsx` (shared, server-safe). Keep table scannable; existing columns preserved; no box numbers.

### Task 4: PO Closeout index Active/Closed (`app/(admin)/po-closeout/page.tsx` + queries)

Add `listCloseoutPoIndexRollups()` (cheap SQL rollup per tablet PO: bag/receive counts, lots by status, active zoho op statuses, excluded/recovery counts) + pure `classifyPoCloseoutIndexBucket()` in `lib/production/po-closeout.ts` (tested): CLOSED only when every received bag is conservatively done (excluded-no-recovery OR lot RELEASED/SHIPPED with op QUEUED/COMMITTED or zoho-not-required) AND no bags awaiting anything AND PO not DRAFT/OPEN/RECEIVING-with-outstanding; CANCELLED → Closed bucket; ambiguity → Active. Tabs Active (default) / Closed / All via searchParams; per-PO chips (bags, done, open, zoho blockers); search over PO number + vendor.

### Task 5: PO Closeout detail per-bag metrics + filters (`[poId]/page.tsx`)

Merge summaries into rows (by inventoryBagId): Received/Produced/Remaining/%/counts/source + partial-split/over-consumed/multi-run chips. Extend filter tabs with low-risk data filters (`?show=` needs-action|has-production|no-production|partial|over|done) without touching verdict logic or batch actions.

### Task 6: Context panels (packaging-output, partial-bags, finished-lots/[id], recall)

Shared `<BagProductionSummaryInline>`: packaging-output backlog rows (by workflowBagId); partial-bags rows (expected vs recorded remaining with plain-language source lines); finished lot detail side panel (source bag production incl. remaining after lot + allocation closeout + zoho status); recall raw-bags section (renders with no finished lot / no workflow — no crash).

### Task 7: Page titles

Root layout: `title: { default: "Luma — Production Command", template: "Luma — %s" }`. Add `export const metadata = { title: "..." }` to: dashboard, inbound ("Receiving"), receiving/raw-bags ("Receive Raw Pills"), packaging-output ("Production Output"), po-closeout ("PO Closeout"), po-reconciliation(+v2), finished-lots ("Finished Lots"), recall ("Traceability Lookup"), partial-bags ("Partial Bag Workbench"), workflow-submissions ("Workflows"), zoho-production-operations ("Zoho Production Output"), metrics, settings, genealogy ("Bag Genealogy"), qc-review ("QC Review"), floor-board ("Live Floor"). `generateMetadata` on inbound/[id] ("Receive <name>"), po-closeout/[poId] ("PO Closeout <poNumber>"), finished-lots/[id] ("Finished Lot <number>"). Structural test asserting each key page file contains a metadata/generateMetadata export and root layout has the template.

### Task 8: Dry run (read-only), verification, deploy

Dry-run report for PO-00238, PO-00206, split bags, NEEDS_MAPPING receives via SQL mirroring the loader; full gates (typecheck, typecheck:scripts, lint, test, build); v1.24.0 + CHANGELOG; push; verify health + pages + invariant snapshot unchanged.

## Self-review

- Spec coverage: A→Tasks 1-2, B→3, C→4, D→5, E→6, F→7, G→copy embedded in 1/3/6, H→8, I→tests in each task, J→8.
- No mutations anywhere; all links point at existing actions/pages.
- Multi-workflow and partial states carried as flags + counts, not flattened.
