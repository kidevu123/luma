# Luma Simplify Phase B — Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the deterministic closeout steps — surface why auto-issue was blocked, widen bulk issue to every safe row, auto-release clean lots at issue time, bulk-apply calculated remaining per PO, convert consistent balance reviews into one-click actions, offer preset QC reasons with the system's own numbers, and fix the allocation-repair zero-balance rejection with field-labeled errors.

**Architecture:** Everything reuses existing per-row services that re-check eligibility in their own transactions (`repairAutoIssueFinishedLotForWorkflowBag`, `resolveAllocationFromProductionOutput`, `setFinishedLotStatus`) — new code is eligibility plumbing, PO-scoped loops following the established `PoBatchButtons` + `actions.ts` template, and pure derivations in `lib/production/`. No schema changes.

**Tech Stack:** Next.js 15 App Router (RSC + server actions), React 19, TypeScript strict, Drizzle/Postgres, Tailwind v3, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-luma-simplify-design.md` (Phase B section)

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index access yields `T | undefined`; never assign `undefined` to optional props.
- No emoji anywhere in UI.
- Every mutation writes `audit_log`; PO-scoped batches write ONE PO-scoped audit with `scope: "PO"`, `po_id`, `ready_at_scan`, affected/skipped counts, `skipped_reasons`, and `zoho_output_committed: false`.
- No new mutation endpoints under `_drawer/` — drawer/row components call existing server actions verbatim.
- Batch caps stay at 100 (`PO_BATCH_CAP`).
- Zoho only via `zoho-integration-service`; nothing in this phase touches Zoho.
- Data honesty: labels never imply missing = zero or suggested = confirmed; preset reasons are suggestions the operator explicitly picks, never auto-submitted.
- Structural tests assert source text; a task changing an asserted pattern updates the assertion truthfully in the same task (never weakens a guarantee).
- Run focused tests with `npx vitest run <file>`; the full 5.7k suite runs only in Task 9.
- Commit messages: conventional commits; append the session trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01MYojhbV7ZEqC2M6m8m2B9T`

## Facts established by code exploration (implementers rely on these)

- `repairAutoIssueFinishedLotForWorkflowBag(workflowBagId, actor)` (lib/db/queries/finished-lots.ts:978) already **issues AND releases** — it delegates to `autoCreateAndReleaseFinishedLotForWorkflowBag`, which sets `RELEASED` in-transaction. It re-checks eligibility via `assertAutoLotRepairAllowed` internally, so callers may loop it safely.
- The packaging engine writes blocked auto-issues to audit only: action `"finished_lot.auto_create_blocked"`, targetType `"WorkflowBag"`, targetId = workflowBagId, `after: { reason, message, packaging_complete_client_event_id }` (lib/production/engine/record-packaging-complete.ts:333-347). Nothing reads it today.
- `computeSystemDerivedResolutionForBag(inventoryBagId)` (lib/production/system-derived-allocation-resolution.ts:69) returns `{available: true, …}` when calculated-remaining is purely derivable; `resolveAllocationFromProductionOutput({inventoryBagId, actor, note?})` (same file :297) applies it, re-checking inside its own transaction and auditing `raw_bag_allocation.system_derived_resolution`.
- `useCalculatedRemainingAction(formData)` (app/(admin)/partial-bags/actions.ts:91) is the lead-gated per-bag action; input is FormData with `inventoryBagId` (+ optional evidence fields).
- `evaluateFinishedLotReleaseEligibility(finishedLotId)` (lib/production/finished-lot-release-eligibility.ts:266) returns `{status, code, message}`; `AUTO_RELEASE_READY` is the only releasable status. Over-consumption is NOT among its blockers (handled upstream as `NEGATIVE_ENDING_BALANCE` in the auto-lot backlog).
- `FIX_PRODUCT_SETUP` maps to blocker codes `MISSING_TABLETS_PER_UNIT`, `MISSING_SHELF_LIFE`, `MISSING_PACKAGING_STRUCTURE` (lib/production/auto-lot-backlog-eligibility.ts:133-138). The product deep-link precedent is `` `/products/${productId}?from=output-queue` `` (app/(admin)/packaging-output/backlog-row-actions.tsx:72). There is no `/products/[id]/edit`.
- The raw-zod-error idiom `parsed.error.issues[0]?.message ?? "Invalid input."` appears in app/(auth)/login/actions.ts:24, app/(admin)/finished-lots/actions.ts:45,79,316, and app/(admin)/partial-bags/actions.ts:54,103,153,182,200.
- Phase A already shipped: bucket tabs (`deriveCloseoutBucket`), inline `RowActionButton` (Issue/Release), `PoBatchButtons` with `useBatch()` hook, and the guided overlay reading `issueReady`/`releaseReady` on the page.

---

### Task 1: Latest auto-create-blocked reason — batch audit reader + closeout surfacing

**Files:**
- Modify: `lib/db/queries/audit-log.ts` (append the pure dedupe + the batch reader beside the existing audit readers)
- Modify: `lib/db/queries/po-closeout.ts` (loader wires the map into rows; `PoCloseoutRow` gains `autoIssueBlockedMessage: string | null`)
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx` (render the message under the reason)
- Test: `lib/db/queries/audit-latest-per-target.test.ts` (pure dedupe) + extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `auditLog` schema columns (`action`, `targetType`, `targetId`, `after` jsonb, `createdAt`); existing loader row assembly in `loadPoCloseout`.
- Produces: `pickLatestPerTarget<T extends { targetId: string | null; createdAt: Date }>(rows: T[]): Map<string, T>` and `mapLatestAutoCreateBlockedByWorkflowBag(workflowBagIds: string[]): Promise<Map<string, { reason: string; message: string }>>` — Task 2 links off the same row fields; nothing else consumes these.

- [ ] **Step 1: Write the failing pure test**

Create `lib/db/queries/audit-latest-per-target.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickLatestPerTarget } from "./audit-log";

describe("SIMPLIFY-B: pickLatestPerTarget", () => {
  it("keeps only the newest row per targetId", () => {
    const rows = [
      { targetId: "a", createdAt: new Date("2026-01-01"), v: 1 },
      { targetId: "a", createdAt: new Date("2026-02-01"), v: 2 },
      { targetId: "b", createdAt: new Date("2026-01-15"), v: 3 },
    ];
    const m = pickLatestPerTarget(rows);
    expect(m.get("a")?.v).toBe(2);
    expect(m.get("b")?.v).toBe(3);
    expect(m.size).toBe(2);
  });
  it("ignores null targetIds and handles empty input", () => {
    expect(pickLatestPerTarget([]).size).toBe(0);
    expect(pickLatestPerTarget([{ targetId: null, createdAt: new Date(), v: 1 }]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/db/queries/audit-latest-per-target.test.ts`
Expected: FAIL — `pickLatestPerTarget` not exported.

- [ ] **Step 3: Implement the helper pair**

Append to `lib/db/queries/audit-log.ts` (imports for `and`, `eq`, `inArray`, `desc` already exist there; add any missing from `drizzle-orm`):

```ts
// SIMPLIFY-B — latest audit row per target, pure half. The packaging engine
// records WHY auto-issue was blocked only in audit_log
// (finished_lot.auto_create_blocked); closeout surfaces the newest reason
// per workflow bag instead of leaving operators guessing.
export function pickLatestPerTarget<T extends { targetId: string | null; createdAt: Date }>(
  rows: T[],
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    if (row.targetId == null) continue;
    const prev = out.get(row.targetId);
    if (!prev || row.createdAt > prev.createdAt) out.set(row.targetId, row);
  }
  return out;
}

export async function mapLatestAutoCreateBlockedByWorkflowBag(
  workflowBagIds: string[],
): Promise<Map<string, { reason: string; message: string }>> {
  if (workflowBagIds.length === 0) return new Map();
  const rows = await db
    .select({
      targetId: auditLog.targetId,
      createdAt: auditLog.createdAt,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "WorkflowBag"),
        eq(auditLog.action, "finished_lot.auto_create_blocked"),
        inArray(auditLog.targetId, workflowBagIds),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(500);
  const latest = pickLatestPerTarget(rows);
  const out = new Map<string, { reason: string; message: string }>();
  for (const [id, row] of latest) {
    const after = (row.after ?? {}) as { reason?: unknown; message?: unknown };
    out.set(id, {
      reason: typeof after.reason === "string" ? after.reason : "UNKNOWN",
      message: typeof after.message === "string" ? after.message : "Auto-issue was blocked at packaging close-out.",
    });
  }
  return out;
}
```

- [ ] **Step 4: Wire into the closeout loader**

In `lib/db/queries/po-closeout.ts`:
- Add `autoIssueBlockedMessage: string | null;` to `PoCloseoutRow` (type at line ~43).
- In `loadPoCloseout`, after the per-bag rows are assembled (rows array built around line 284-440): collect `const blockedCandidates = rows.filter((r) => r.workflowBagId && r.checklist.floorFinalizedOrExcluded && !r.finishedLotId).map((r) => r.workflowBagId!)`, call `mapLatestAutoCreateBlockedByWorkflowBag(blockedCandidates)` ONCE, and set each row's `autoIssueBlockedMessage` to `map.get(r.workflowBagId)?.message ?? null` (rows outside the candidate set get `null`). Import the helper. Keep the loader read-only.

- [ ] **Step 5: Render on the row**

In `closeout-rows.tsx`, in the "What's next" cell under the existing reason div (and above `<RowActionButton …/>`):

```tsx
{row.autoIssueBlockedMessage && row.autoIssueBlockedMessage !== row.reason ? (
  <div className="text-[10px] text-amber-700">
    Auto-issue blocked: {row.autoIssueBlockedMessage}
  </div>
) : null}
```

- [ ] **Step 6: Extend the structural test**

In `app/(admin)/po-closeout/po-closeout-structural.test.ts`, inside the loader describe:

```ts
it("SIMPLIFY-B: loader surfaces the latest auto_create_blocked audit reason per bag", () => {
  expect(loaderSrc).toMatch(/mapLatestAutoCreateBlockedByWorkflowBag/);
  expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/Auto-issue blocked:/);
});
```

(Use the file's existing source-reading helper; if there is no `repo(...)` helper for arbitrary paths, read the rows source the same way the file's other assertions do.)

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run lib/db/queries/audit-latest-per-target.test.ts 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add lib/db/queries/audit-log.ts lib/db/queries/po-closeout.ts 'app/(admin)/po-closeout/_drawer/closeout-rows.tsx' lib/db/queries/audit-latest-per-target.test.ts 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): surface latest auto-issue-blocked reason on rows"
```

---

### Task 2: Product-setup deep links from closeout

**Files:**
- Modify: `lib/db/queries/po-closeout.ts` (`PoCloseoutRow` gains `productId: string | null`; loader selects `workflowBags.productId` — check the existing bag select, it may already fetch it for the classifier; reuse if so)
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx` (`rowLink` FIX_PRODUCT_SETUP case)
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `PoCloseoutRow.productId` (added here).
- Produces: FIX_PRODUCT_SETUP rows link to `` `/products/${row.productId}?from=output-queue` `` (the `from=output-queue` value is what `app/(admin)/products/[id]/page.tsx` already understands from the packaging-backlog precedent — verify during implementation how that page renders the `from` param; if it accepts arbitrary values or ignores unknown ones gracefully, keep `output-queue`; do NOT invent a new value the page doesn't handle).

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-B: product-setup rows deep-link to the product page, not bare /products", () => {
  const rows = repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx");
  expect(rows).toMatch(/\/products\/\$\{row\.productId\}/);
  expect(rows).not.toMatch(/href: "\/products", label: "Open products"/);
});
```

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts'` — expected FAIL.

- [ ] **Step 2: Implement**

Loader: add `productId` to `PoCloseoutRow` and populate from the bag/workflow select (the classifier input already receives `tabletTypeId` etc. — find where `workflowBags.productId` is available in the loader's joins; add to the select if absent).

`rowLink` in `closeout-rows.tsx`:

```ts
case "FIX_PRODUCT_SETUP":
  return row.productId
    ? { href: `/products/${row.productId}?from=output-queue`, label: "Fix product setup" }
    : { href: "/products", label: "Open products" };
```

First read `app/(admin)/products/[id]/page.tsx` to confirm how `?from=output-queue` is handled (back-link) and keep the value it supports.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`

```bash
git add lib/db/queries/po-closeout.ts 'app/(admin)/po-closeout/_drawer/closeout-rows.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): deep-link product-setup fixes to the product page"
```

---

### Task 3: Widen PO bulk issue to repair-issue-ready rows

**Files:**
- Modify: `app/(admin)/po-closeout/actions.ts` (`autoIssueSafeLotsForPoAction` target filter, line ~53-55)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (`issueReady` count, line ~151)
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `repairAutoIssueFinishedLotForWorkflowBag` — safe for BOTH `AUTO_ISSUE_FINISHED_LOT` and `ISSUE_FINISHED_LOT` rows (it re-runs `assertAutoLotRepairAllowed` in its own transaction; the classifier's `ISSUE_FINISHED_LOT`+READY verdict comes from that same assert via `repairIssueReady`).
- Produces: `issueReady` on the page now counts both actions; `PoBatchButtons` and the guided safe-batch step inherit the wider count with no signature change.

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-B: PO bulk issue covers repair-issue-ready rows too", () => {
  expect(actionsSrc).toMatch(/AUTO_ISSUE_FINISHED_LOT" \|\| r\.action === "ISSUE_FINISHED_LOT/);
  expect(detailPageSrc).toMatch(/ISSUE_FINISHED_LOT/);
});
```

Run — expected FAIL. (Note: `actionsSrc`/`detailPageSrc` are the file's existing source constants; re-read them fresh if the file reads sources at module load.)

- [ ] **Step 2: Implement**

`actions.ts` target filter becomes:

```ts
const targets = summary.rows
  .filter(
    (r) =>
      r.status === "READY_FOR_ACTION" &&
      (r.action === "AUTO_ISSUE_FINISHED_LOT" || r.action === "ISSUE_FINISHED_LOT") &&
      r.workflowBagId,
  )
  .slice(0, PO_BATCH_CAP);
```

Also update the `capped` computation's filter identically. Page `issueReady`:

```ts
const issueReady = summary.rows.filter(
  (r) =>
    r.status === "READY_FOR_ACTION" &&
    (r.action === "AUTO_ISSUE_FINISHED_LOT" || r.action === "ISSUE_FINISHED_LOT"),
).length;
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' 'app/(admin)/po-closeout/closeout-freshness.test.ts' && npx tsc --noEmit`

```bash
git add 'app/(admin)/po-closeout/actions.ts' 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): bulk issue covers repair-issue-ready bags"
```

---

### Task 4: Auto-release clean lots on manual issue

**Files:**
- Modify: `app/(admin)/finished-lots/actions.ts` (`issueFinishedLotWithAllocationAndRedirect` after success ~line 104; `createFinishedLotAction` after success ~line 47)
- Test: create `app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts`

**Interfaces:**
- Consumes: `evaluateFinishedLotReleaseEligibility(finishedLotId)` and `setFinishedLotStatus(id, "RELEASED", actor, reason)` — both already imported in the file.
- Produces: manually issued lots that pass `AUTO_RELEASE_READY` land as `RELEASED` with no extra tap; anything else stays `PENDING_QC` untouched. Release failure is non-fatal to the issue.

- [ ] **Step 1: Failing structural test**

Create `app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts`:

```ts
// SIMPLIFY-B — a cleanly issued lot should not need a separate release tap.
// Structural (DB paths need Postgres).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/actions.ts"), "utf8");

describe("auto-release on issue", () => {
  it("both manual issue paths evaluate release eligibility and release only AUTO_RELEASE_READY", () => {
    const matches = src.match(/maybeAutoReleaseOnIssue\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
    expect(src).toMatch(/status === "AUTO_RELEASE_READY"/);
    expect(src).toMatch(/Auto-released on issue/);
  });
  it("release failure is swallowed (never fails the issue)", () => {
    expect(src).toMatch(/maybeAutoReleaseOnIssue[\s\S]{0,600}catch/);
  });
});
```

Run: `npx vitest run 'app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts'` — expected FAIL.

- [ ] **Step 2: Implement**

In `app/(admin)/finished-lots/actions.ts`, add a module-level helper (NOT exported as a server action — plain async function; place it above the actions and keep it in this file since it is glue, not policy):

```ts
// SIMPLIFY-B — a lot issued with clean, consistent counts should not need a
// separate release tap. Re-uses the exact eligibility evaluator + release
// path the auto-release batch uses. Never fails the issue: release is a
// best-effort follow-on, and anything not AUTO_RELEASE_READY stays PENDING_QC.
async function maybeAutoReleaseOnIssue(finishedLotId: string, actor: Awaited<ReturnType<typeof requireLead>>) {
  try {
    const evaluation = await evaluateFinishedLotReleaseEligibility(finishedLotId);
    if (evaluation.status === "AUTO_RELEASE_READY") {
      await setFinishedLotStatus(
        finishedLotId,
        "RELEASED",
        actor,
        "Auto-released on issue — passed QC auto-release eligibility. Zoho output NOT committed by this step.",
      );
    }
  } catch {
    // Best-effort: the lot stays PENDING_QC and shows in the release backlog.
  }
}
```

Call it in `createFinishedLotAction` right after `createFinishedLot` succeeds (before revalidates): `await maybeAutoReleaseOnIssue(lot.id, actor);` — and in `issueFinishedLotWithAllocationAndRedirect` right after `finishedLotId` is assigned (inside the try, after `result.ok`): `await maybeAutoReleaseOnIssue(finishedLotId, actor);`.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts' && npx tsc --noEmit`

```bash
git add 'app/(admin)/finished-lots/actions.ts' 'app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts'
git commit -m "feat(lots): auto-release clean lots at issue time"
```

---

### Task 5: PO-level bulk "Use calculated remaining"

**Files:**
- Modify: `app/(admin)/po-closeout/actions.ts` (new `useCalculatedRemainingForPoAction`)
- Modify: `app/(admin)/po-closeout/batch-buttons.tsx` (third button via the existing `useBatch()` hook)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (compute `calcReady`, pass to `PoBatchButtons`, widen the bulk-strip render condition)
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `computeSystemDerivedResolutionForBag(inventoryBagId)` (probe) and `resolveAllocationFromProductionOutput({ inventoryBagId, actor })` (apply; re-checks in its own tx; audits per-bag) from `@/lib/production/system-derived-allocation-resolution`.
- Produces: `useCalculatedRemainingForPoAction(poId: string): Promise<PoBatchResult>` and `PoBatchButtons` prop `calcReady: number`. Task 6's classifier work will make `calcReady` meaningful (until then it may be 0 — the button simply hides).

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-B: PO bulk calculated-remaining reuses the per-bag service and audits PO-scoped", () => {
  expect(actionsSrc).toMatch(/export async function useCalculatedRemainingForPoAction/);
  expect(actionsSrc).toMatch(/computeSystemDerivedResolutionForBag/);
  expect(actionsSrc).toMatch(/resolveAllocationFromProductionOutput/);
  expect(actionsSrc).toMatch(/raw_bag_allocation\.system_derived_batch/);
  expect(repo("app/(admin)/po-closeout/batch-buttons.tsx")).toMatch(/calcReady/);
});
```

Run — expected FAIL.

- [ ] **Step 2: Implement the action**

Append to `app/(admin)/po-closeout/actions.ts` (mirror the two existing PO batch actions exactly — requireLead, loadPoCloseout, cap, per-row service, one audit, revalidate, `PoBatchResult`):

```ts
/** Apply the system-calculated remaining to every bag on this PO where it is
 *  purely derivable (action RECORD_REMAINING_OR_CLOSE_PARTIAL). Probes each
 *  candidate read-only first; the per-bag service re-checks inside its own
 *  transaction. */
export async function useCalculatedRemainingForPoAction(poId: string): Promise<PoBatchResult> {
  const actor = await requireLead();
  try {
    const summary = await loadPoCloseout(poId);
    if (!summary) return { ok: false, error: "PO not found." };
    const candidates = summary.rows
      .filter((r) => r.action === "RECORD_REMAINING_OR_CLOSE_PARTIAL")
      .slice(0, PO_BATCH_CAP);

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const r of candidates) {
      const probe = await computeSystemDerivedResolutionForBag(r.inventoryBagId);
      if (!probe.available) {
        skipped.push(probe.message);
        continue;
      }
      const result = await resolveAllocationFromProductionOutput({
        inventoryBagId: r.inventoryBagId,
        actor,
        note: "Applied via PO Closeout bulk calculated-remaining.",
      });
      if (result.ok) applied.push(r.receiptNumber ?? r.inventoryBagId);
      else skipped.push(result.error);
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "raw_bag_allocation.system_derived_batch",
      targetType: "PoCloseout",
      targetId: poId,
      after: {
        source: "SYSTEM_DERIVED_FROM_PRODUCTION_OUTPUT",
        scope: "PO",
        po_id: poId,
        po_number: summary.poNumber,
        ready_at_scan: candidates.length,
        applied: applied.length,
        skipped: skipped.length,
        applied_bags: applied,
        skipped_reasons: skipped,
        zoho_output_committed: false,
        note: "PO-scoped calculated-remaining only; derived numbers, no operator input.",
      },
    });

    if (applied.length > 0) {
      revalidatePath(`/po-closeout/${poId}`);
      revalidatePath("/po-closeout");
      revalidatePath("/partial-bags");
    }
    return {
      ok: true,
      affected: applied.length,
      skipped: skipped.length,
      capped: summary.rows.filter((r) => r.action === "RECORD_REMAINING_OR_CLOSE_PARTIAL").length > PO_BATCH_CAP,
      skippedReasons: skipped,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "PO calculated-remaining failed." };
  }
}
```

Imports to add: `computeSystemDerivedResolutionForBag`, `resolveAllocationFromProductionOutput` from `@/lib/production/system-derived-allocation-resolution`.

Check the `resolveAllocationFromProductionOutput` result shape in the source before assuming `{ok, error}` — adapt the error extraction to its actual discriminated union (`{ok:false, reason, error}` per exploration).

- [ ] **Step 3: Implement the button + page wiring**

`batch-buttons.tsx`: add prop `calcReady: number` to `PoBatchButtons`; render a third button with the existing `useBatch()` hook when `calcReady > 0`:

```tsx
{calcReady > 0 ? (
  <BatchButton
    label={`Use calculated remaining (${calcReady})`}
    confirmText={`Apply the system-calculated remaining to ${calcReady} bag${calcReady === 1 ? "" : "s"}? Derived from production output; no operator input.`}
    run={() => useCalculatedRemainingForPoAction(poId)}
  />
) : null}
```

(Adapt mechanically to the file's actual internal component structure — the two existing buttons show the pattern; keep result/error rendering identical.)

Page: `const calcReady = summary.rows.filter((r) => r.action === "RECORD_REMAINING_OR_CLOSE_PARTIAL" && r.status === "READY_FOR_ACTION").length;` and pass `calcReady={calcReady}`; the bulk-strip render condition becomes `(issueReady > 0 || releaseReady > 0 || calcReady > 0)`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`

```bash
git add 'app/(admin)/po-closeout/actions.ts' 'app/(admin)/po-closeout/batch-buttons.tsx' 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): PO-level bulk Use-calculated-remaining"
```

---

### Task 6: Calculated-remaining availability in the classifier + inline row button

**Files:**
- Modify: `lib/production/po-closeout.ts` (classifier input + branch)
- Modify: `lib/db/queries/po-closeout.ts` (loader probes availability for the relevant rows)
- Modify: `app/(admin)/po-closeout/_drawer/row-action-button.tsx` (third inline case)
- Test: extend `lib/production/po-closeout.test.ts` + `po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `computeSystemDerivedResolutionForBag(inventoryBagId).available` (loader side); `useCalculatedRemainingAction(formData)` from `@/app/(admin)/partial-bags/actions` (button side — takes FormData with `inventoryBagId`).
- Produces: `PoCloseoutRowInput.calculatedRemainingAvailable?: boolean` (optional — existing callers/tests unchanged); rows in the `REPAIR_ALLOCATION`-not-rebaseable branch become `READY_FOR_ACTION` / "Use calculated remaining" when available. Task 5's `calcReady` count starts being non-zero because of this task.

- [ ] **Step 1: Write the failing classifier tests**

Append to `lib/production/po-closeout.test.ts` (reuse the file's existing `doneRow` fixture spread pattern; the repair branch needs `hasFinishedLot: false`, `autoIssue` with `action: "REPAIR_ALLOCATION"`, a non-`MISSING_ALLOCATION_SESSION` code, `rebaseAvailable: false`):

```ts
describe("SIMPLIFY-B: calculated-remaining availability upgrades the repair branch", () => {
  const repairRow: PoCloseoutRowInput = {
    ...doneRow,
    hasFinishedLot: false,
    finishedLotId: null,
    lotStatus: null,
    autoIssue: {
      autoIssuable: false,
      action: "REPAIR_ALLOCATION",
      code: "NEGATIVE_ENDING_BALANCE",
      repairIssueReady: false,
      label: "Needs allocation repair",
      nextStep: "Review starting balance / consumption",
    },
    rebaseAvailable: false,
  };

  it("available → READY_FOR_ACTION with Use calculated remaining", () => {
    const r = classifyPoCloseoutRow({ ...repairRow, calculatedRemainingAvailable: true });
    expect(r.status).toBe("READY_FOR_ACTION");
    expect(r.action).toBe("RECORD_REMAINING_OR_CLOSE_PARTIAL");
    expect(r.actionLabel).toBe("Use calculated remaining");
  });

  it("not available (or omitted) → unchanged NEEDS_REVIEW", () => {
    expect(classifyPoCloseoutRow({ ...repairRow, calculatedRemainingAvailable: false }).status).toBe("NEEDS_REVIEW");
    expect(classifyPoCloseoutRow(repairRow).status).toBe("NEEDS_REVIEW");
  });

  it("rebase still wins over calculated remaining", () => {
    const r = classifyPoCloseoutRow({ ...repairRow, rebaseAvailable: true, calculatedRemainingAvailable: true });
    expect(r.action).toBe("CORRECT_STARTING_BALANCE");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL (type error / wrong status).

- [ ] **Step 3: Implement the classifier branch**

In `lib/production/po-closeout.ts`:
- Add to `PoCloseoutRowInput`: `/** computeSystemDerivedResolutionForBag(...).available — remaining is purely derivable from production output. */ calculatedRemainingAvailable?: boolean;`
- In the `REPAIR_ALLOCATION` branch (current lines ~323-326), after the `rebaseAvailable` check and before the NEEDS_REVIEW fallback:

```ts
if (input.calculatedRemainingAvailable) {
  return verdict(
    "READY_FOR_ACTION",
    "Remaining is derivable from production output — no operator input needed",
    "RECORD_REMAINING_OR_CLOSE_PARTIAL",
    "Use calculated remaining",
  );
}
```

- [ ] **Step 4: Loader probe**

In `lib/db/queries/po-closeout.ts`, where each row's classifier input is assembled (~line 408): the availability probe is a DB call, so probe ONLY rows that would hit the repair branch — where the auto-issue evaluation exists with `action === "REPAIR_ALLOCATION"` and `code !== "MISSING_ALLOCATION_SESSION"` and rebase is unavailable. Follow the loader's existing per-row fail-closed pattern (wrap in the same try/catch the other evaluators use; on error pass `false`). Import `computeSystemDerivedResolutionForBag`.

- [ ] **Step 5: Inline row button**

In `row-action-button.tsx`, add a third case (import `useCalculatedRemainingAction` from `@/app/(admin)/partial-bags/actions`):

```ts
else if (row.action === "RECORD_REMAINING_OR_CLOSE_PARTIAL" && row.status === "READY_FOR_ACTION") {
  const inventoryBagId = row.inventoryBagId;
  button = {
    label: "Use calculated remaining",
    onClick: () =>
      void run(() => {
        const fd = new FormData();
        fd.set("inventoryBagId", inventoryBagId);
        return useCalculatedRemainingAction(fd);
      }),
  };
}
```

(The action returns `{ok:false, error}` on failure — the existing `run()` error handling covers it.)

- [ ] **Step 6: Structural test + verify + commit**

Add to `po-closeout-structural.test.ts` (row-action describe): `expect(repo("app/(admin)/po-closeout/_drawer/row-action-button.tsx")).toMatch(/useCalculatedRemainingAction/);`

Run: `npx vitest run lib/production/po-closeout.test.ts 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts lib/db/queries/po-closeout.ts 'app/(admin)/po-closeout/_drawer/row-action-button.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): consistent balance reviews become one-click Use-calculated-remaining"
```

---

### Task 7: Suggested QC reasons with the system's numbers

**Files:**
- Create: `components/admin/reason-presets.tsx`
- Modify: `app/(admin)/po-closeout/_drawer/lot-actions.tsx` (HOLD_REVIEW reason input gains presets)
- Modify: `app/(admin)/finished-lots/[id]/status-actions.tsx` (reason panel gains presets)
- Modify: `app/(admin)/finished-lots/new/issue-form.tsx` (over-consumption presets prefill the notes field)
- Modify: `app/(admin)/po-closeout/_drawer/partial-actions.tsx` (manual-correct reason gains presets)
- Test: create `components/admin/reason-presets-structural.test.ts`

**Interfaces:**
- Consumes: nothing new — presets only fill existing inputs; submission paths unchanged.
- Produces: `ReasonPresets({ presets, onPick }: { presets: string[]; onPick: (text: string) => void })` — renders one button chip per preset; clicking calls `onPick(preset)`. Data honesty: picking a chip fills the field; the operator still submits explicitly.

- [ ] **Step 1: Failing structural test**

Create `components/admin/reason-presets-structural.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("SIMPLIFY-B: reason presets", () => {
  it("component renders chips that fill, never submit", () => {
    const src = repo("components/admin/reason-presets.tsx");
    expect(src).toMatch(/type="button"/);
    expect(src).not.toMatch(/type="submit"/);
    expect(src).toMatch(/onPick/);
  });
  it("release + hold-review + over-consumption + manual-correct inputs offer presets", () => {
    expect(repo("app/(admin)/po-closeout/_drawer/lot-actions.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/finished-lots/[id]/status-actions.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/finished-lots/new/issue-form.tsx")).toMatch(/ReasonPresets/);
    expect(repo("app/(admin)/po-closeout/_drawer/partial-actions.tsx")).toMatch(/ReasonPresets/);
  });
  it("over-consumption presets carry the system's own numbers", () => {
    expect(repo("app/(admin)/finished-lots/new/issue-form.tsx")).toMatch(/Recount: consumed/);
  });
});
```

Run — expected FAIL.

- [ ] **Step 2: Implement the component**

Create `components/admin/reason-presets.tsx`:

```tsx
"use client";

// SIMPLIFY-B — preset reason chips so a tablet operator is not writing a
// novel. Picking a chip FILLS the input; nothing is submitted until the
// operator's explicit confirm (suggested is never confirmed).

export function ReasonPresets({
  presets,
  onPick,
}: {
  presets: string[];
  onPick: (text: string) => void;
}) {
  if (presets.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted hover:bg-surface hover:text-text-strong"
        >
          {p}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire the four call sites**

- `lot-actions.tsx` (HOLD_REVIEW mode, above the reason `<input>`): `<ReasonPresets presets={["Reviewed and cleared for release", "Overpack accepted after recount", "Waste/damage accounted for", "Hold resolved with supervisor"]} onPick={setReason} />`
- `status-actions.tsx` (inside the reason panel): `<ReasonPresets presets={["Reviewed and cleared for release", "Overpack accepted after recount", "Waste/damage accounted for", "QA sample retained"]} onPick={setReason} />`
- `issue-form.tsx`: near the notes `Textarea`, render only when over-consumed or negative balance (the component already computes `overConsumptionQty` at ~line 105 and `negativeEndingBalance` at ~line 103 with the consumed/starting values in scope — build presets from the real variables in that component, adapting names mechanically):

```tsx
{overConsumptionQty > 0 || negativeEndingBalance ? (
  <ReasonPresets
    presets={[
      `Recount: consumed ${consumedQty.toLocaleString()} vs starting ${(effectiveStartingBalance ?? 0).toLocaleString()} — system numbers used`,
      `Overpack: output exceeded intake by ${overConsumptionQty.toLocaleString()} tablets`,
      "Waste/damage during run accounted for in counts",
    ]}
    onPick={(t) => setNotes((prev) => (prev ? `${prev}\n${t}` : t))}
  />
) : null}
```

(If notes state has a different setter name, adapt; if notes is an uncontrolled field, convert it to controlled state within this task.)
- `partial-actions.tsx` (MANUAL tab reason input): presets `["Physical recount performed", "Weigh-back conversion", "Spillage/waste during run", "Counted with supervisor"]`, filling the reason input (convert that input to controlled state if needed).

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run components/admin/reason-presets-structural.test.ts && npx tsc --noEmit`

```bash
git add components/admin/reason-presets.tsx components/admin/reason-presets-structural.test.ts 'app/(admin)/po-closeout/_drawer/lot-actions.tsx' 'app/(admin)/finished-lots/[id]/status-actions.tsx' 'app/(admin)/finished-lots/new/issue-form.tsx' 'app/(admin)/po-closeout/_drawer/partial-actions.tsx'
git commit -m "feat(qc): preset reason chips prefilled with system numbers"
```

---

### Task 8: Allocation-repair zero balance + field-labeled validation errors

**Files:**
- Create: `lib/validation/format-zod-error.ts`
- Create: `lib/validation/format-zod-error.test.ts`
- Modify: `app/(admin)/finished-lots/actions.ts` (schema `.positive()` → `.nonnegative()` on `repairStartingBalanceQty` ~line 71; all three `parsed.error.issues[0]` sites use the formatter with labels)
- Modify: `app/(auth)/login/actions.ts` (friendly messages)
- Test: extend `app/(admin)/finished-lots/auto-release-on-issue-structural.test.ts` is WRONG scope — instead create `app/(admin)/finished-lots/repair-validation-structural.test.ts`

**Interfaces:**
- Consumes: existing zod schemas.
- Produces: `formatZodError(error: ZodError, labels?: Record<string, string>): string` returning `"<Label>: <message>"` for the first issue; `repairStartingBalanceQty` accepts 0. The service side (`issueFinishedLotWithAllocationCloseout` line ~194) already passes 0 through (`!= null` guard) — the task VERIFIES this by reading `lib/production/issue-lot-with-allocation-closeout.ts` and `resolveRepairStartingBalanceQty` (~line 298) for any lingering `> 0` gate, fixing truthfully if found.

- [ ] **Step 1: Failing formatter tests**

Create `lib/validation/format-zod-error.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { formatZodError } from "./format-zod-error";

describe("SIMPLIFY-B: formatZodError", () => {
  const schema = z.object({ repairStartingBalanceQty: z.coerce.number().int().nonnegative() });

  it("prefixes the field label", () => {
    const r = schema.safeParse({ repairStartingBalanceQty: -1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodError(r.error, { repairStartingBalanceQty: "Starting balance" });
      expect(msg.startsWith("Starting balance: ")).toBe(true);
    }
  });

  it("falls back to the raw path when unlabeled, and to a generic message with no issues", () => {
    const r = schema.safeParse({ repairStartingBalanceQty: -1 });
    if (!r.success) {
      expect(formatZodError(r.error)).toMatch(/^repairStartingBalanceQty: /);
    }
    expect(formatZodError(new z.ZodError([]))).toBe("Invalid input.");
  });

  it("zero passes the nonnegative schema (the 6337-46 case)", () => {
    expect(schema.safeParse({ repairStartingBalanceQty: 0 }).success).toBe(true);
  });
});
```

Run: `npx vitest run lib/validation/format-zod-error.test.ts` — expected FAIL (module missing).

- [ ] **Step 2: Implement the formatter**

Create `lib/validation/format-zod-error.ts`:

```ts
// SIMPLIFY-B — raw zod messages ("Number must be greater than 0") next to a
// button, with no field named, blocked real closeouts (6337-46). Name the
// field. First issue only — one clear error beats a wall of them.

import type { ZodError } from "zod";

export function formatZodError(
  error: ZodError,
  labels: Record<string, string> = {},
): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  const key = issue.path[0] != null ? String(issue.path[0]) : "";
  if (!key) return issue.message;
  const label = labels[key] ?? key;
  return `${label}: ${issue.message}`;
}
```

- [ ] **Step 3: Apply to finished-lots actions**

In `app/(admin)/finished-lots/actions.ts`:
- Line ~71: `repairStartingBalanceQty: z.coerce.number().int().nonnegative().optional().nullable(),`
- Define once near the schemas:

```ts
const LOT_FIELD_LABELS: Record<string, string> = {
  productId: "Product",
  workflowBagId: "Source bag",
  finishedLotNumber: "Lot number",
  producedOn: "Produced on",
  expiryDate: "Expiry date",
  unitsProduced: "Units produced",
  displaysProduced: "Displays produced",
  casesProduced: "Cases produced",
  consumedQty: "Tablets consumed",
  endingBalanceQty: "Ending balance",
  repairStartingBalanceQty: "Starting balance",
  status: "Status",
  reason: "Reason",
};
```

- Replace all three `return { error: parsed.error.issues[0]?.message ?? "Invalid input." };` sites with `return { error: formatZodError(parsed.error, LOT_FIELD_LABELS) };` (import the formatter).

Then read `lib/production/issue-lot-with-allocation-closeout.ts` (lines ~190-200 and `resolveRepairStartingBalanceQty` ~298) and confirm a `repairStartingBalanceQty` of `0` flows through (`!= null` guard) with no `> 0` rejection deeper in; if a deeper gate exists, relax it to `>= 0` with a comment citing the repair-exists-because-ledger-is-missing rationale.

- [ ] **Step 4: loginAction friendly messages**

In `app/(auth)/login/actions.ts`, give the schema human messages instead of raw defaults:

```ts
const schema = z.object({
  email: z.string().min(3, "Enter your email").max(254, "Email is too long").regex(/^.+@.+$/, "Email must contain @"),
  password: z.string().min(1, "Enter your password").max(200, "Password is too long"),
});
```

(The return site can keep its current shape — the messages themselves are now presentable.)

- [ ] **Step 5: Structural pin + verify + commit**

Create `app/(admin)/finished-lots/repair-validation-structural.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const src = readFileSync(join(process.cwd(), "app/(admin)/finished-lots/actions.ts"), "utf8");

describe("SIMPLIFY-B: repair validation", () => {
  it("starting balance accepts 0 and errors are field-labeled", () => {
    expect(src).toMatch(/repairStartingBalanceQty: z\.coerce\.number\(\)\.int\(\)\.nonnegative\(\)/);
    expect(src).toMatch(/formatZodError\(parsed\.error, LOT_FIELD_LABELS\)/);
    expect(src).not.toMatch(/parsed\.error\.issues\[0\]/);
  });
});
```

Run: `npx vitest run lib/validation/format-zod-error.test.ts 'app/(admin)/finished-lots/repair-validation-structural.test.ts' && npx tsc --noEmit`

```bash
git add lib/validation/format-zod-error.ts lib/validation/format-zod-error.test.ts 'app/(admin)/finished-lots/actions.ts' 'app/(auth)/login/actions.ts' 'app/(admin)/finished-lots/repair-validation-structural.test.ts'
git commit -m "fix(lots): accept zero starting balance in repair; field-labeled validation errors"
```

---

### Task 9: Phase gate — full suite, build

**Files:** none new.

**Interfaces:** consumes everything above; produces a green gate.

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint` — expected clean.
- [ ] **Step 2:** `npx vitest run` — all tests pass (baseline 5706 + this phase's additions). Any failure anywhere is this phase's to investigate (superpowers:systematic-debugging).
- [ ] **Step 3:** `npm run build` — completes.
- [ ] **Step 4:** Report in the canonical `luma-test-build-deploy` shape. Do NOT push or deploy — the human partner reviews first.
