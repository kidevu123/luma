# Admin Correction Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "Wrong route / assignment recovery" into a guided Admin Correction Wizard with a real wrong-product remap flow (preview → apply), an enhanced wrong-route quarantine+restart flow, and downstream integration (metrics, finished lots, Zoho ops, allocation, PO Closeout, traceability) — all append-only, audited, fail-closed.

**Architecture:** Reuse the existing audited event patterns — `PRODUCT_MAPPED` (already reprojects `read_bag_state` product from `workflow_bags.productId`), `reprojectBagMetricsForWorkflowBag` (recomputes metrics from events under the bag's current product), `WORKFLOW_RECOVERY` (quarantine), `RAW_BAG_ADJUSTED` allocation ledger events, and the `applySubmissionCorrectionDownstreamEffects` lot-hold/op-void pattern. **No DB migration needed** — no new pg enum values; new payload fields are additive JSONB/zod-optional.

**Tech Stack:** Next.js 15 server actions, Drizzle, zod, vitest (pure unit tests + source-contract tests).

## Global Constraints

- Live production app: no destructive data changes, no deploy-time mutation, no auto Zoho commit, no history rewrites — append events only.
- Every mutation requires explicit admin confirmation (checkbox + reason ≥ 10 chars) and writes `audit_log`.
- Fail closed: any ambiguity → blocked with precise reason.
- Version bump to **1.23.0** (MINOR), CHANGELOG entry `## [1.23.0] — 2026-07-07`, `lib/version.contract.test.ts` must stay green.
- Push to main only with typecheck + lint + tests + build clean.
- No emoji in UI; Lucide icons + chips + text.

---

## Key facts from recon (verified in code)

- Recovery action: `app/(admin)/workflow-submissions/actions.ts:268` (`workflowRecoveryAction`); payload schema `lib/production/workflow-recovery.ts:26` has `intended_product_id` **hardcoded null** at actions.ts:385.
- `PRODUCT_MAPPED` projector branch (`lib/projector/index.ts:558-585`) reads `workflowBags.productId` and **directly overwrites** `read_bag_state.product_id/product_name` (not COALESCE) → updating `workflowBags.productId` first, then emitting `PRODUCT_MAPPED`, remaps read state safely.
- `reprojectBagMetricsForWorkflowBag(tx, workflowBagId)` (`lib/projector/reproject-bag-metrics.ts:20`) recomputes `read_bag_metrics` from events + current product, then refreshes sku-daily, material-reconciliation, station-daily.
- Lot hold + op void pattern: `lib/production/correction-downstream-effects.ts` (`applySubmissionCorrectionDownstreamEffects`).
- Passport reprojection: `projectFinishedLotPassportForLot(tx, finishedLotId)` (`lib/projector/finished-lot-passport.ts:302`), idempotent upserts.
- Allocation ledger insert pattern: `lib/production/open-session-rebase.ts:201` (RAW_BAG_ADJUSTED).
- PO Closeout classifier: `lib/production/po-closeout.ts:151`; excluded rows currently short-circuit to DONE at line 221-224. Loader builds input at `lib/db/queries/po-closeout.ts` (~line 351).
- Production Output backlog already filters `excluded_from_output = false` and derives product via `workflowBags.productId` → corrected product flows automatically.
- Zoho op statuses are free text; `COMMITTED` blocks void (`canVoidZohoProductionOutputOp`); unique non-voided op per lot; voided ops don't block fresh preview/queue.
- Tests: pure unit tests in `lib/production/*.test.ts`; server actions covered by source-contract tests (regex over source, see `app/(admin)/workflow-submissions/actions.test.ts`).

## Correction type model (Task B)

| Type | Mechanism | Mutates | Does NOT mutate |
|---|---|---|---|
| `WRONG_PRODUCT_CORRECTION` | new service; `workflowBags.productId` update + `PRODUCT_MAPPED` (source `ADMIN_WRONG_PRODUCT_CORRECTION`) + metric reprojection + lot update/hold + op void + allocation recalc | product mapping, derived read models, lot (if safe), uncommitted ops, terminal allocation session | station events, committed Zoho, QR |
| `WRONG_ROUTE_CORRECTION` | existing `WORKFLOW_RECOVERY` kind `WRONG_ROUTE`, now with populated `intended_product_id` + additive payload fields | recovery status, excluded flag, lot hold, op void, QR release if safe | events, committed Zoho; **never converts route metrics** |
| `WRONG_QR_OR_RECEIPT_CORRECTION` | existing `WORKFLOW_RECOVERY` kind `WRONG_QR_ASSIGNMENT` (quarantine-only; direct relink deferred — documented) | same as quarantine | bag/receipt linkage |
| `QUARANTINE_ONLY` | existing `WORKFLOW_RECOVERY` kind `WRONG_ROUTE` with `correction_mode: "QUARANTINE_ONLY"` | same as today | product mapping |

### Task 1: Pure wrong-product correction module (TDD)

**Files:**
- Create: `lib/production/wrong-product-correction.ts`
- Test: `lib/production/wrong-product-correction.test.ts`

**Interfaces (produces):**
```typescript
export const WRONG_PRODUCT_CORRECTION_SOURCE = "ADMIN_WRONG_PRODUCT_CORRECTION" as const;

export type WrongProductCorrectionBlocker = { code: string; message: string; recommendation: string };
export type WrongProductCorrectionWarning = { code: string; message: string };

export type CorrectionProductFacts = {
  id: string; sku: string; name: string; kind: string; // CARD | BOTTLE | VARIETY
  tabletsPerUnit: number | null; unitsPerDisplay: number | null;
  displaysPerCase: number | null; defaultShelfLifeDays: number | null;
  isActive: boolean; allowsBagTabletType: boolean;
};

export type WrongProductCorrectionCounts = {
  masterCases: number; displaysMade: number; looseCards: number;
  bottlesCompleted: number; // 0 for card routes
};

export function computeUnitsUnderProduct(counts, product): number | null; // null when structure missing
export function computeExpectedConsumption(units, tabletsPerUnit): number | null;

export function evaluateWrongProductCorrection(args: {
  oldProduct: CorrectionProductFacts | null;
  newProduct: CorrectionProductFacts | null;
  isFinalized: boolean;
  alreadyQuarantined: boolean;   // excludedFromOutput || recoveryStatus
  zohoOutputCommitted: boolean;
  lotStatus: string | null;      // finished_lots.status or null
  allocationSessions: Array<{ status: string; startingBalanceQty: number | null }>;
  counts: WrongProductCorrectionCounts | null; // null when not finalized (no packaging counts yet)
}): { allowed: boolean; blockers: WrongProductCorrectionBlocker[]; warnings: WrongProductCorrectionWarning[] };

export function buildWrongProductCorrectionPreview(args): WrongProductCorrectionPreview;
// preview: old/new product+route, counts snapshot, old/new units, old/new expected consumption,
// allocation impact {sessionStatus, startingBalance, oldConsumed, newConsumed, oldEnding, newEnding} | null,
// finishedLotImpact: "NONE" | "UPDATE_AND_HOLD" | "BLOCKED_COMMITTED" | "BLOCKED_SHIPPED_OR_RECALLED",
// zohoImpact: "NONE" | "VOID_UNCOMMITTED_REBUILD" | "BLOCKED_COMMITTED",
// poCloseoutImpact: string (copy)
```

**Blocker codes (fail closed):** `SAME_PRODUCT`, `PRODUCT_NOT_FOUND`, `PRODUCT_INACTIVE`, `ROUTE_INCOMPATIBLE` (kind mismatch or either kind VARIETY), `TABLET_NOT_ALLOWED`, `PRODUCT_SETUP_INCOMPLETE` (missing tabletsPerUnit, or missing unitsPerDisplay/displaysPerCase when case/display counts > 0), `ALREADY_QUARANTINED`, `ZOHO_COMMITTED`, `LOT_SHIPPED_OR_RECALLED`, `ALLOCATION_OPEN`, `ALLOCATION_AMBIGUOUS` (>1 non-voided session), `NEGATIVE_REMAINING` (new consumption > known starting balance).

**Warnings:** `MISSING_SHELF_LIFE` (auto-issue later blocks on setup), `LOT_WILL_HOLD` (RELEASED/PENDING_QC lot goes ON_HOLD and needs re-release), `ZOHO_OP_WILL_VOID` (must re-preview/queue).

**Steps:**
- [ ] Write failing tests covering every blocker, warning, unit/consumption math (card + bottle), preview shape, and the receipt-352182 scenario (7223 start, 10/44/0 counts, 4 tpu, 20×25 → 5880/23520 vs 10×12 → 1640/6560).
- [ ] Run `npx vitest run lib/production/wrong-product-correction.test.ts` → FAIL.
- [ ] Implement module (pure functions only, no DB).
- [ ] Run test → PASS.

### Task 2: Apply service (transactional) + additive recovery payload fields

**Files:**
- Create: `lib/production/wrong-product-correction-service.ts`
- Modify: `lib/production/workflow-recovery.ts` (additive optional payload fields: `intended_route`, `correction_mode`)
- Test: extend `lib/production/wrong-product-correction.test.ts` (service is thin; covered by source-contract test in Task 3)

**Service `applyWrongProductCorrectionInTx(tx, args)` order of operations:**
1. Reload bag, state, products, lot, ops, allocation sessions inside tx; re-run `evaluateWrongProductCorrection` — throw first blocker (fail closed at apply time, not just preview).
2. `UPDATE workflow_bags SET product_id = new` (audited via audit_log before/after).
3. `projectEvent` `PRODUCT_MAPPED` with payload: product_id/sku/name/kind, `source: "ADMIN_WRONG_PRODUCT_CORRECTION"`, `correction: { old_product_id, old_product_name, old_product_kind, new_product_id, new_product_name, reason, notes, counts_snapshot }` — projector updates `read_bag_state` product columns.
4. `reprojectBagMetricsForWorkflowBag(tx, bagId)` → new units under corrected product + downstream daily read models.
5. Set `read_bag_state.has_correction = true`.
6. Allocation (when exactly one non-voided **terminal** session): recompute consumed/ending, `UPDATE raw_bag_allocation_sessions SET product_id, consumed_qty, ending_balance_qty, consumed_qty_source = 'ADMIN_WRONG_PRODUCT_CORRECTION'`, insert `RAW_BAG_ADJUSTED` allocation event with old/new payload, audit.
7. Finished lot (when exists; blockers already exclude committed/shipped/recalled): `UPDATE finished_lots SET product_id, units_produced, displays_produced, cases_produced` from reprojected metrics; status → `ON_HOLD` (existing correction pattern); update `finished_lot_inputs.qty_consumed` to recomputed consumption; `projectFinishedLotPassportForLot(tx, lotId)`; audit.
8. Void non-voided, non-committed `zoho_production_output_ops` for the lot with reason "Voided after wrong-product correction — re-preview and queue with corrected product."
9. `writeAudit` action `workflow_submissions.wrong_product_correction`, targetType WorkflowBag, before/after containing: actor, workflow bag id, inventory bag id, old/new product id+name, old/new route, counts snapshot, finished lot ids, zoho op ids, reason, notes.

- [ ] Implement service; typecheck.

### Task 3: Server actions + wizard UI

**Files:**
- Modify: `app/(admin)/workflow-submissions/actions.ts` — add `loadWrongProductCorrectionContextAction(workflowBagId)` (returns current product, candidate products [active, same kind, allows bag tablet type, ≠ current], lot/zoho/allocation facts, counts), `previewWrongProductCorrectionAction`, `applyWrongProductCorrectionAction` (requireAdmin, zod, confirm literal, reason ≥ 10); extend `workflowRecoveryAction` to accept optional `intendedProductId` and `correctionMode`, and pass through to payload (replacing the hardcoded null).
- Create: `app/(admin)/workflow-submissions/_correction-wizard.tsx` — replaces `_workflow-recovery-form.tsx` usage in `workflow-table.tsx` (keep old file exporting the new wizard or delete + update import).
- Test: extend `app/(admin)/workflow-submissions/actions.test.ts` (source-contract) + new `_correction-wizard.test.ts` (source-contract).

**Wizard UX (single component, staged):**
1. **Choose correction type** — 4 radio cards with explicit copy (changes / does not change / downstream effects / whether output continues automatically).
2. **Wrong product path:** required "Correct product" select (candidates only; incompatible products not listed — plus explanatory line), current → correct product and route comparison, compatibility banner; "Preview impact" button → renders preview table (counts, old/new units, old/new consumption, allocation, lot, Zoho, PO Closeout); blockers render as red list with recommendations and disable apply; then reason + notes + confirm checkbox + "Apply correction".
3. **Wrong route path:** optional intended product select (any active product) to record intent, copy: "This will mark the wrong workflow output as invalid for normal output. It preserves history and allows the correct workflow to be started." Direct conversion is never offered. Applies quarantine via `workflowRecoveryAction`; success panel links to `/production/start`.
4. **Wrong QR/receipt path:** quarantine-only with copy explaining relink is manual review for now.
5. **Quarantine only:** existing behavior, current copy.

- [ ] Write failing source-contract tests (correct-product selector required; preview action exists; apply re-evaluates blockers in tx; PRODUCT_MAPPED emitted with ADMIN_WRONG_PRODUCT_CORRECTION; no update/delete of workflow_events; audit action name; void reason; ON_HOLD; intended_product_id no longer hardcoded null).
- [ ] Implement actions + wizard; tests PASS.

### Task 4: PO Closeout + downstream visibility

**Files:**
- Modify: `lib/production/po-closeout.ts` — add `recoveryStatus: string | null` (and `hasCorrectedProduct?: boolean` if cheap) to `PoCloseoutRowInput`; replace the excluded short-circuit:
  - `EXTERNAL_RECOVERY_REQUIRED` → BLOCKED "Recovered but Zoho already committed — manual intervention required" / REVIEW_MANUALLY.
  - `WRONG_ROUTE_RECOVERED` → NEEDS_REVIEW "Wrong route recovered — start correct workflow" / START_OR_FINALIZE_WORKFLOW.
  - `VOIDED_FROM_OUTPUT` → NEEDS_REVIEW "Wrong route recovered — manual review needed" / REVIEW_MANUALLY.
  - excluded without recovery status → DONE (unchanged).
- Modify: `lib/db/queries/po-closeout.ts` — select `recoveryStatus` alongside `excludedFromOutput`, pass through.
- Modify: `app/(admin)/workflow-submissions/workflow-table.tsx` — add `PRODUCT_MAPPED` event badge; corrected-product banner when a correction event exists (from expanded genealogy payloads): "Product corrected — original: X → corrected: Y" in audit section.
- Test: extend `lib/production/po-closeout.test.ts` for the three new branches + regression (excluded, no recovery status → DONE).

- [ ] Failing classifier tests → implement → PASS.
- [ ] Verify traceability/genealogy renders correction events (payload rendering is generic; PRODUCT_MAPPED badge added) and recall passport unaffected (lot passport reprojected by service).

### Task 5: Full verification + docs + deploy

- [ ] `npm run typecheck` && `npm run typecheck:scripts` && `npm run lint` && `npm run test` && `npm run build` — all green.
- [ ] Bump `package.json` to 1.23.0; CHANGELOG entry `## [1.23.0] — 2026-07-07` (Added — ADMIN-CORRECTION-WIZARD-1).
- [ ] Commit + push main; wait for deploy timer on LXC 122; verify `/api/health` version 1.23.0.
- [ ] Read-only post-deploy checks: workflow-submissions and po-closeout pages load; finished lot count, committed Zoho op count, QR status distribution unchanged vs pre-deploy snapshot; receipt 352182 untouched.

## Self-review notes

- Spec coverage: Task A (recon, done), B (type model, Task 3 UI + this table), C (Tasks 1-3), D (Task 3 wrong-route path + Task 4 closeout), E (quarantine-only + deferred design in report), F (Task 4 + automatic flows via productId), G (blocker list Task 1), H (tests in each task), I (dry-run done pre-plan), J (Task 5).
- Wrong-route direct conversion: intentionally never allowed — no route-compatible mapping exists in the codebase; quarantine + restart is the safe path.
- No duplicate lots: correction updates the existing lot in place (unique lot number retained); auto-issue dedup guards untouched.
- No duplicate Zoho ops: voided ops freed from unique index; fresh op requires explicit admin preview/queue.
