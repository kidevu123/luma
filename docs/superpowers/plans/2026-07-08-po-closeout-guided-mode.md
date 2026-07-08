# PO Closeout Guided Mode (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Close this PO" button on `/po-closeout/[poId]` that walks the admin through every unresolved bag in dependency order — safe batch first, one confirm per judgment step — using the Phase-1 drawer components.

**Architecture:** Pure queue derivation (`deriveGuidedCloseoutQueue`) over the `PoCloseoutRow[]` the page already computes; a URL-addressable overlay (`?guided=1&step=n`) rendered by the server page, so every step advance is a fresh server render (live recompute by construction). Each bag step renders the existing `BagDrawer`; step 0 wraps the existing PO-scoped batch actions behind one confirm. No new business logic, no new mutation endpoints.

**Tech Stack:** Next.js searchParams routing, existing drawer components, vitest pure + structural tests.

## Global Constraints (from spec)

- Batch safe, confirm risky: step 0 = existing `autoIssueSafeLotsForPoAction` + `autoReleaseSafeLotsForPoAction` (each re-checks per row); partials/corrections/QR/Zoho always get their own confirm via the drawer panels.
- Queue recomputed from live data at every step advance (never snapshotted).
- Floor-only steps render "needs the floor — skip for now", never pretending admins can fix them.
- Finish screen reports done/remaining and exactly why blocked; honest note that the PO flips Closed only when everything is resolved.
- No auto Zoho commit; read-only page loads; version → **1.26.0**; CHANGELOG `## [1.26.0] — 2026-07-08`; all gates green; deploy + verification.

## Verified interfaces (existing, reuse as-is)

- `PoCloseoutRow` (status, action, reason, actionLabel, inventoryBagId, receiptNumber, bagNumber, tabletName, workflowBagId, finishedLotId, lotStatus, receiveId, zoho) — `lib/db/queries/po-closeout.ts`
- `BagDrawer({inventoryBagId, poId, row, reason})` — `app/(admin)/po-closeout/_drawer/bag-drawer.tsx`
- `autoIssueSafeLotsForPoAction(poId)` / `autoReleaseSafeLotsForPoAction(poId)` → `PoBatchResult` — `app/(admin)/po-closeout/actions.ts`
- Detail page already computes `summary.rows`, `summary.counts`, `summary.topBlockers`, `issueReady`, `releaseReady`.

---

### Task 1: Pure `deriveGuidedCloseoutQueue`

**Files:**
- Create: `lib/production/guided-closeout.ts`
- Test: `lib/production/guided-closeout.test.ts`

**Interfaces (produces):**
```typescript
export type GuidedPhase = "QR" | "FLOOR" | "PARTIAL" | "LOT" | "QC" | "ZOHO" | "REVIEW";
export type GuidedStep = {
  inventoryBagId: string;
  receiptNumber: string | null;
  bagNumber: number | null;
  tabletName: string | null;
  phase: GuidedPhase;
  floorOnly: boolean;      // true → "needs the floor — skip for now"
  reason: string;
  actionLabel: string;
};
export function deriveGuidedCloseoutQueue(rows: Array<Pick<PoCloseoutRow,
  "inventoryBagId"|"receiptNumber"|"bagNumber"|"tabletName"|"status"|"action"|"reason"|"actionLabel"
>>): GuidedStep[];
```

Mapping: DONE rows skipped. `REPAIR_QR_RESERVATION`→QR; `START_OR_FINALIZE_WORKFLOW`→FLOOR (floorOnly=true); `CORRECT_STARTING_BALANCE`|`RECORD_REMAINING_OR_CLOSE_PARTIAL`→PARTIAL; `AUTO_ISSUE_FINISHED_LOT`→LOT; `AUTO_RELEASE_FINISHED_LOT`|`REVIEW_QC_HOLD`→QC; `QUEUE_OR_RETRY_ZOHO`→ZOHO; everything else (FIX_PRODUCT_SETUP, REVIEW_MANUALLY, NONE, unknown)→REVIEW. Sort by phase rank (QR=0…REVIEW=6), stable within phase by receiptNumber.

- [ ] **Step 1: failing tests** — DONE skipped; each action maps to its phase; dependency ordering across mixed rows; floorOnly only for START_OR_FINALIZE_WORKFLOW; unknown action → REVIEW (fail closed); stable ordering by receipt within phase; empty input → [].
- [ ] **Step 2:** `npx vitest run lib/production/guided-closeout.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement pure mapping + sort.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** `git add lib/production/guided-closeout.* && git commit -m "feat(guided-closeout): pure dependency-ordered step queue"`

### Task 2: Guided overlay + page wiring

**Files:**
- Create: `app/(admin)/po-closeout/_guided/guided-overlay.tsx` (client)
- Create: `app/(admin)/po-closeout/_guided/safe-batch-step.tsx` (client)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (parse `guided`/`step` searchParams; render overlay; add "Close this PO" button)
- Test: extend `app/(admin)/po-closeout/closeout-freshness.test.ts` (structural)

**Behavior:**
- Page parses `guided === "1"` and `step` (int ≥ 0, default 0). Computes `queue = deriveGuidedCloseoutQueue(summary.rows)` and `hasSafeBatch = issueReady + releaseReady > 0`. Steps are: step 0 = safe batch when `hasSafeBatch`, else bag steps start at 0; bag step index = step − (hasSafeBatch ? 1 : 0); index ≥ queue.length → finish screen.
- `GuidedOverlay` (client) renders a fixed inset overlay: header ("Close this PO — step X of Y", exit link to `/po-closeout/${poId}`), body, and footer nav (Back / Skip / Next as `<Link>`s to `?guided=1&step=n±1` — server re-render = live recompute).
  - Safe-batch body: `<SafeBatchStep poId issueReady releaseReady />` — copy "Issue N lots and release M — nothing touches Zoho", one confirm checkbox + Run button calling `autoIssueSafeLotsForPoAction` then `autoReleaseSafeLotsForPoAction`, rendering both results (affected/skipped + reasons), then `router.refresh()`.
  - Bag-step body: headline `step.reason` + `<BagDrawer inventoryBagId poId row reason>` (row facts passed from the matching `PoCloseoutRow`); floorOnly steps show "Needs the floor — skip for now" banner instead of expecting an admin fix.
  - Finish body: counts rollup (done/ready/review/blocked) + `topBlockers` list + copy "This PO flips to Closed when every bag is resolved and Zoho output is queued or committed."
- Guided mode adds NOTHING mutational: only existing batch actions + drawer panels.

- [ ] **Step 1: failing structural tests** — page parses `guided`/`step` and renders `<GuidedOverlay`; overlay navigates via `?guided=1&step=` links (live recompute) and contains no `"use server"`; safe-batch imports the two existing PO batch actions and has confirm copy "nothing touches Zoho"; floor-only copy "Needs the floor — skip for now" present; finish copy "flips to Closed" present; "Close this PO" button present.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement components + wiring.
- [ ] **Step 4:** `npx tsc --noEmit`, targeted vitest, `npm run lint`, `npm run build` all green.
- [ ] **Step 5:** `git add app/(admin)/po-closeout && git commit -m "feat(guided-closeout): Close this PO guided mode over drawer components"`

### Task 3: Gates, version, deploy, verification

- [ ] Full gates (`typecheck`, `typecheck:scripts`, `lint`, `test`, `build`).
- [ ] `npm version 1.26.0 --no-git-tag-version`; CHANGELOG `## [1.26.0] — 2026-07-08` (Added — GUIDED-CLOSEOUT-1; Notes: no new mutation logic, batch-safe/confirm-risky, live recompute per step).
- [ ] Pre-deploy invariant snapshot; commit; push; wait for deploy; `/api/health` → 1.26.0; pages respond; invariants unchanged; no non-cron audit rows.

## Self-review

- Spec coverage: URL-addressable overlay ✔ (Task 2), step 0 safe batch ✔, dependency order + DONE skip + floor-only ✔ (Task 1), finish screen ✔, live recompute ✔ (server-render per step), batching policy ✔. Types consistent (`GuidedStep`, `deriveGuidedCloseoutQueue`, `GuidedOverlay`, `SafeBatchStep`).
- No placeholders.
