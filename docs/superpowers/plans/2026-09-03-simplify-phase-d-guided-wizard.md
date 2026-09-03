# Luma Simplify Phase D — Guided Wizard Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the guided "Close this PO" wizard trustworthy — steps addressed by bag (no index drift), batch results that survive until Continue, a queue pre-filtered to bags an admin can act on, one action per step, a done-bag fallback instead of a blank panel, and navigation that can't resurrect the overlay from browser history.

**Architecture:** The step URL becomes `?guided=1&bag=<inventoryBagId>` with sentinels `batch`/`finish` (bare `?guided=1` is the entry point that resolves server-side). All position/navigation resolution is pure (`resolveGuidedNav` in `lib/production/guided-closeout.ts`) over a queue that now excludes EMPTY and ON_FLOOR buckets and reports what it excluded. Wizard navigation uses `router.replace` so the whole session occupies one history entry — one back-press exits for good. Bag steps render only the primary action panel via a `primaryOnly` mode on the existing drawer.

**Tech Stack:** Next.js 15 App Router (RSC + client nav), React 19, TypeScript strict, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-luma-simplify-design.md` (Phase D section)

## Global Constraints

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- No emoji anywhere in UI.
- The overlay adds NO mutation logic — bag steps reuse the existing drawer panels/server actions; the batch step reuses the existing PO batch actions. No new mutation endpoints.
- **Spec deviation (deliberate, record in commits where relevant):** the spec's URL sketch said `bag=<workflowBagId>`; rows and the guided queue are keyed by `inventoryBagId` (a bag can exist before any workflow), so the param carries `inventoryBagId`. Sentinels: `bag=batch`, `bag=finish`.
- The overlay keeps `useRefreshSuppression()` (Phase A) — do not remove it.
- Old `?step=N` URLs are dead: when `bag` is absent, `?guided=1` (with or without a stale `step` param) resolves to the entry step server-side. No redirect loops, no blank renders — every reachable state renders something.
- Structural tests assert source text: `po-closeout-structural.test.ts` has a `guided closeout mode (GUIDED-CLOSEOUT-1)` describe (~lines 224-256) pinning `?guided/step` parsing and plain-link navigation — those assertions must be updated truthfully (never weakened: each new assertion pins the replacement behavior). `closeout-freshness.test.ts` pins `useRefreshSuppression()` in the overlay — keep it green.
- Run focused tests with `npx vitest run <file>`; full suite only in the gate task.
- Commit messages: conventional commits + session trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01MYojhbV7ZEqC2M6m8m2B9T`

## Facts established by code exploration (implementers rely on these)

- `deriveGuidedCloseoutQueue(rows)` (lib/production/guided-closeout.ts:62-94) returns `GuidedStep[]` sorted by phase rank then receipt; single caller is the page; tests in `lib/production/guided-closeout.test.ts` (8 cases).
- Page guided block (app/(admin)/po-closeout/[poId]/page.tsx:173-211): parses `guided`/`step`, computes `bagIndex = guidedStep - (hasSafeBatch ? 1 : 0)` — the index-drift bug — and builds `guidedBagStep` with `rowFacts` from the matching `PoCloseoutRow`. `hasSafeBatch = issueReady + releaseReady > 0`; `bucketByBag: Map<string, CloseoutBucket>` and `bucketCounts` already exist earlier in the page (Phase A).
- `GuidedOverlay` (app/(admin)/po-closeout/_guided/guided-overlay.tsx) renders header/step counter, footer nav as plain `<Link href=?guided=1&step=N>`, `"Nothing to do on this step."` fallback (line 141 — the blank-panel bug), and mounts `useRefreshSuppression()`.
- `SafeBatchStep` (safe-batch-step.tsx) calls the two batch actions then `router.refresh()` (line 48) — which flips `hasSafeBatch` false and unmounts the results (the vanishing-results bug).
- `BagDrawer` renders `VerifyPanel` + `ActionPanels`; `ActionPanels` renders EVERY applicable panel from `deriveApplicableBagActions` including `CORRECTION_WIZARD` (the 6-action buffet). `deriveApplicableBagActions` returns `BagDrawerActionKey[]`; CORRECTION_WIZARD is appended last whenever the bag has a workflow.
- `deriveCloseoutBucket(row, producedTablets)` (Phase A) yields `"DO_HERE" | "ON_FLOOR" | "WAITING_ZOHO" | "DONE" | "EMPTY"`; the page builds `bucketByBag` before the guided block.
- Wizard entry CTA on the page header links `?guided=1&step=0` today.

---

### Task 1: Pure layer — filtered queue with exclusions, nav resolution, primary action

**Files:**
- Modify: `lib/production/guided-closeout.ts`
- Modify: `lib/production/bag-closeout-actions.ts` (append `derivePrimaryBagAction`)
- Test: `lib/production/guided-closeout.test.ts` (update existing cases + new) and `lib/production/bag-closeout-actions.test.ts` (new describe)

**Interfaces:**
- Consumes: `CloseoutBucket` type from `@/lib/production/po-closeout`.
- Produces (Tasks 3-4 rely on these exact names):
  - `deriveGuidedCloseoutQueue(rows, buckets?: Map<string, CloseoutBucket>): { steps: GuidedStep[]; excluded: { onFloor: number; empty: number } }` — WHEN `buckets` is provided, rows whose bucket is `ON_FLOOR` or `EMPTY` are excluded and counted; without `buckets`, behavior is the old one (nothing excluded, counts 0). RETURN SHAPE CHANGES — update the existing tests to destructure `.steps`.
  - `type GuidedTarget = "batch" | "finish" | (string & {})` (a bag inventoryBagId).
  - `resolveGuidedNav(steps: GuidedStep[], current: GuidedTarget, hasSafeBatch: boolean): { mode: "batch" | "finish" | "bag" | "bag-done"; index: number | null; prevTarget: GuidedTarget | null; nextTarget: GuidedTarget }`.
  - `derivePrimaryBagAction(keys: BagDrawerActionKey[]): BagDrawerActionKey | null` — first key that is not `"CORRECTION_WIZARD"`, else null.

- [ ] **Step 1: Update/extend the failing tests**

In `lib/production/guided-closeout.test.ts`: mechanically update the 8 existing cases to read `deriveGuidedCloseoutQueue(rows).steps` (the `excluded` counts are `{onFloor: 0, empty: 0}` without buckets). Then append:

```ts
import type { CloseoutBucket } from "./po-closeout";

describe("SIMPLIFY-D: bucket-filtered queue", () => {
  const row = (id: string, action = "ISSUE_FINISHED_LOT") => ({
    inventoryBagId: id, receiptNumber: id, bagNumber: 1, tabletName: null,
    status: "READY_FOR_ACTION", action, reason: "r", actionLabel: "a",
  });
  it("excludes ON_FLOOR and EMPTY buckets and counts them", () => {
    const buckets = new Map<string, CloseoutBucket>([
      ["a", "DO_HERE"], ["b", "ON_FLOOR"], ["c", "EMPTY"], ["d", "EMPTY"],
    ]);
    const q = deriveGuidedCloseoutQueue(
      [row("a"), row("b", "START_OR_FINALIZE_WORKFLOW"), row("c"), row("d")],
      buckets,
    );
    expect(q.steps.map((s) => s.inventoryBagId)).toEqual(["a"]);
    expect(q.excluded).toEqual({ onFloor: 1, empty: 2 });
  });
  it("rows missing from the bucket map are kept (fail open into the queue, never dropped silently)", () => {
    const q = deriveGuidedCloseoutQueue([row("x")], new Map());
    expect(q.steps).toHaveLength(1);
  });
});

describe("SIMPLIFY-D: resolveGuidedNav", () => {
  const steps = [row("a"), row("b"), row("c")].map((r) => ({
    inventoryBagId: r.inventoryBagId, receiptNumber: r.receiptNumber, bagNumber: 1,
    tabletName: null, phase: "LOT" as const, floorOnly: false, reason: "r", actionLabel: "a",
  }));
  it("batch step: next is the first bag (or finish when queue empty)", () => {
    expect(resolveGuidedNav(steps, "batch", true)).toEqual({ mode: "batch", index: null, prevTarget: null, nextTarget: "a" });
    expect(resolveGuidedNav([], "batch", true).nextTarget).toBe("finish");
  });
  it("bag steps chain by identity with batch/exit at the head", () => {
    expect(resolveGuidedNav(steps, "a", true)).toEqual({ mode: "bag", index: 0, prevTarget: "batch", nextTarget: "b" });
    expect(resolveGuidedNav(steps, "a", false).prevTarget).toBeNull();
    expect(resolveGuidedNav(steps, "c", true)).toEqual({ mode: "bag", index: 2, prevTarget: "b", nextTarget: "finish" });
  });
  it("a bag no longer in the queue is bag-done, pointing at the live head", () => {
    expect(resolveGuidedNav(steps, "zz", true)).toEqual({ mode: "bag-done", index: null, prevTarget: null, nextTarget: "a" });
    expect(resolveGuidedNav([], "zz", false).nextTarget).toBe("finish");
  });
  it("finish is terminal", () => {
    expect(resolveGuidedNav(steps, "finish", true).mode).toBe("finish");
  });
});
```

(`row` helper reuse across describes — declare it once at an appropriate scope; adapt mechanically.)

In `lib/production/bag-closeout-actions.test.ts` append:

```ts
describe("SIMPLIFY-D: derivePrimaryBagAction", () => {
  it("first non-correction key wins; correction alone yields null", () => {
    expect(derivePrimaryBagAction(["ISSUE_LOT", "CORRECTION_WIZARD"])).toBe("ISSUE_LOT");
    expect(derivePrimaryBagAction(["CORRECTION_WIZARD"])).toBeNull();
    expect(derivePrimaryBagAction([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/guided-closeout.test.ts lib/production/bag-closeout-actions.test.ts`
Expected: FAIL (return shape/type errors; missing exports).

- [ ] **Step 3: Implement**

`lib/production/guided-closeout.ts` — change the derivation and append nav resolution:

```ts
import type { CloseoutBucket } from "./po-closeout";

export function deriveGuidedCloseoutQueue(
  rows: Array<{ /* unchanged row shape */ }>,
  buckets?: Map<string, CloseoutBucket>,
): { steps: GuidedStep[]; excluded: { onFloor: number; empty: number } } {
  let onFloor = 0;
  let empty = 0;
  const actionable = rows.filter((r) => {
    if (r.status === "DONE") return false;
    const bucket = buckets?.get(r.inventoryBagId);
    if (bucket === "ON_FLOOR") { onFloor += 1; return false; }
    if (bucket === "EMPTY") { empty += 1; return false; }
    return true; // no bucket info: fail open — a bag is never silently dropped
  });
  const steps = actionable
    .map(/* unchanged mapping */)
    .sort(/* unchanged sort */);
  return { steps, excluded: { onFloor, empty } };
}

// ── SIMPLIFY-D · bag-addressed navigation ───────────────────────────────────
// Steps are addressed by inventoryBagId (never by index) so a bag resolved
// out-of-band shortens the queue instead of silently skipping a neighbor.
// "batch" and "finish" are sentinels; a bag id not in the live queue is
// "bag-done" — the operator sees it completed and continues at the head.

export type GuidedTarget = "batch" | "finish" | (string & {});

export function resolveGuidedNav(
  steps: GuidedStep[],
  current: GuidedTarget,
  hasSafeBatch: boolean,
): {
  mode: "batch" | "finish" | "bag" | "bag-done";
  index: number | null;
  prevTarget: GuidedTarget | null;
  nextTarget: GuidedTarget;
} {
  const first: GuidedTarget = steps[0]?.inventoryBagId ?? "finish";
  if (current === "batch") return { mode: "batch", index: null, prevTarget: null, nextTarget: first };
  if (current === "finish") return { mode: "finish", index: null, prevTarget: null, nextTarget: "finish" };
  const index = steps.findIndex((s) => s.inventoryBagId === current);
  if (index === -1) return { mode: "bag-done", index: null, prevTarget: null, nextTarget: first };
  const prevTarget: GuidedTarget | null =
    index > 0 ? steps[index - 1]!.inventoryBagId : hasSafeBatch ? "batch" : null;
  const nextTarget: GuidedTarget = steps[index + 1]?.inventoryBagId ?? "finish";
  return { mode: "bag", index, prevTarget, nextTarget };
}
```

`lib/production/bag-closeout-actions.ts` — append:

```ts
// SIMPLIFY-D — the guided wizard shows ONE action per step, not the buffet.
// The correction wizard is a supervisor escape hatch, never the primary step.
export function derivePrimaryBagAction(keys: BagDrawerActionKey[]): BagDrawerActionKey | null {
  return keys.find((k) => k !== "CORRECTION_WIZARD") ?? null;
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run lib/production/guided-closeout.test.ts lib/production/bag-closeout-actions.test.ts && npx tsc --noEmit`
Expected: the two test files PASS; tsc will FAIL at the page call site (`.steps` shape) — that is expected until Task 4; note it and confirm the ONLY tsc errors are in `app/(admin)/po-closeout/[poId]/page.tsx`. To keep the branch bisectable, make the minimal page adaptation in THIS task: change line ~179 to `const guidedQueue = deriveGuidedCloseoutQueue(summary.rows).steps;` (behavior identical, exclusions unused until Task 4), then re-run tsc — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/production/guided-closeout.ts lib/production/guided-closeout.test.ts lib/production/bag-closeout-actions.ts lib/production/bag-closeout-actions.test.ts 'app/(admin)/po-closeout/[poId]/page.tsx'
git commit -m "feat(guided): bucket-filtered queue with exclusion counts; bag-addressed nav resolution; primary-action picker"
```

---

### Task 2: Drawer `primaryOnly` mode

**Files:**
- Modify: `app/(admin)/po-closeout/_drawer/action-panels.tsx`
- Modify: `app/(admin)/po-closeout/_drawer/bag-drawer.tsx`
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `derivePrimaryBagAction` (Task 1).
- Produces: `BagDrawer` and `ActionPanels` accept optional `primaryOnly?: boolean` (default false → behavior byte-identical for the list view). When true: `ActionPanels` computes `keys` as before, then reduces to `derivePrimaryBagAction(keys)` — rendering at most ONE panel and never the correction launcher; when the primary is null it renders nothing (the step shows state + Next).

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-D: guided steps render one primary panel, never the buffet", () => {
  const panels = repo("app/(admin)/po-closeout/_drawer/action-panels.tsx");
  expect(panels).toMatch(/primaryOnly/);
  expect(panels).toMatch(/derivePrimaryBagAction/);
  expect(repo("app/(admin)/po-closeout/_drawer/bag-drawer.tsx")).toMatch(/primaryOnly/);
});
```

Run the structural file — FAIL.

- [ ] **Step 2: Implement**

`action-panels.tsx`: add `primaryOnly?: boolean` prop. After computing `keys`:

```ts
const effectiveKeys = primaryOnly
  ? (() => {
      const primary = derivePrimaryBagAction(keys);
      return primary ? [primary] : [];
    })()
  : keys;
if (effectiveKeys.length === 0) return null;
```

and render from `effectiveKeys` (the correction launcher's `keys.includes("CORRECTION_WIZARD")` check becomes `effectiveKeys.includes(...)` so it disappears in primaryOnly mode). Import `derivePrimaryBagAction`.

`bag-drawer.tsx`: add `primaryOnly?: boolean` prop, pass through to `ActionPanels` (build the prop object conditionally or pass `primaryOnly={primaryOnly ?? false}` — mind `exactOptionalPropertyTypes`).

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`

```bash
git add 'app/(admin)/po-closeout/_drawer/action-panels.tsx' 'app/(admin)/po-closeout/_drawer/bag-drawer.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(guided): primaryOnly drawer mode renders a single action panel"
```

---

### Task 3: SafeBatchStep — results persist until Continue

**Files:**
- Modify: `app/(admin)/po-closeout/_guided/safe-batch-step.tsx`
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: existing batch actions (unchanged).
- Produces: `SafeBatchStep({ poId, issueReady, releaseReady, continueHref })` — after running, the results panel stays (NO `router.refresh()` in `run()`); a "Continue" button calls `router.replace(continueHref)`. Task 4 passes `continueHref = /po-closeout/${poId}?guided=1` (the entry resolver decides what's next from live data).

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-D: batch results persist until Continue (no refresh-under-you)", () => {
  const src = repo("app/(admin)/po-closeout/_guided/safe-batch-step.tsx");
  expect(src).toMatch(/continueHref/);
  expect(src).toMatch(/router\.replace\(continueHref\)/);
  expect(src).not.toMatch(/router\.refresh\(\)/);
});
```

Run — FAIL.

- [ ] **Step 2: Implement**

In `safe-batch-step.tsx`: add `continueHref: string` prop; delete the `router.refresh()` call in `run()`; in the results branch replace the "Continue to the next step…" paragraph with:

```tsx
<button
  type="button"
  onClick={() => router.replace(continueHref)}
  className="rounded bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
>
  Continue
</button>
<p className="text-xs text-text-muted">
  The queue recomputes from live data when you continue.
</p>
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit` (tsc will flag the missing `continueHref` at the overlay call site — pass a temporary `continueHref={`/po-closeout/${poId}?guided=1`}` from `guided-overlay.tsx` in this task so the branch stays green; Task 4 rewrites that file anyway).

```bash
git add 'app/(admin)/po-closeout/_guided/safe-batch-step.tsx' 'app/(admin)/po-closeout/_guided/guided-overlay.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(guided): batch results persist until an explicit Continue"
```

---

### Task 4: Bag-addressed wizard — page derivation + overlay rewrite

**Files:**
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (guided block ~173-211, searchParams type, CTA link)
- Modify: `app/(admin)/po-closeout/_guided/guided-overlay.tsx` (rewrite navigation/modes)
- Test: update the GUIDED-CLOSEOUT-1 describe in `po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `deriveGuidedCloseoutQueue(rows, bucketByBag)` + `resolveGuidedNav` (Task 1); `primaryOnly` drawer (Task 2); `SafeBatchStep` with `continueHref` (Task 3); the page's existing `bucketByBag`, `hasSafeBatch`, `issueReady`, `releaseReady`.
- Produces: URL contract `?guided=1[&bag=<inventoryBagId|batch|finish>]`; `GuidedOverlay` props:

```ts
{
  poId: string;
  poNumber: string;
  mode: "batch" | "bag" | "bag-done" | "finish";
  stepNumber: number;        // 1-based display position (batch = 1; bag = index + 1 + (hasSafeBatch ? 1 : 0))
  totalSteps: number;        // steps.length + (hasSafeBatch ? 1 : 0)
  excluded: { onFloor: number; empty: number };
  issueReady: number;
  releaseReady: number;
  bagStep: GuidedBagStep | null;      // when mode === "bag"
  doneReceipt: string | null;          // when mode === "bag-done": the requested bag id's receipt if known, else null
  finish: { done: number; readyForAction: number; needsReview: number; blocked: number; topBlockers: Array<{reason: string; count: number}> } | null;
  prevTarget: GuidedTarget | null;
  nextTarget: GuidedTarget;
}
```

- [ ] **Step 1: Update the structural assertions (failing first)**

In the GUIDED-CLOSEOUT-1 describe of `po-closeout-structural.test.ts`, replace the assertions that pin `?guided/step` parsing and plain step links with (keep the safe-batch and finish-copy assertions that still hold; adapt helper names):

```ts
it("SIMPLIFY-D: steps are bag-addressed with sentinels; entry resolves server-side", () => {
  expect(detailPageSrc).toMatch(/resolveGuidedNav/);
  expect(detailPageSrc).toMatch(/"batch"/);
  expect(detailPageSrc).toMatch(/bag\?:/);
  expect(detailPageSrc).not.toMatch(/guidedStep - \(hasSafeBatch/);
});
it("SIMPLIFY-D: wizard nav replaces history (back cannot resurrect the overlay) and reports exclusions", () => {
  const overlay = repo("app/(admin)/po-closeout/_guided/guided-overlay.tsx");
  expect(overlay).toMatch(/router\.replace/);
  expect(overlay).toMatch(/not shown/);
  expect(overlay).toMatch(/primaryOnly/);
  expect(overlay).toMatch(/already handled|bag is done/i);
  expect(overlay).not.toMatch(/Nothing to do on this step/);
});
```

Run — FAIL.

- [ ] **Step 2: Rewire the page**

In `[poId]/page.tsx`:
- searchParams type: replace `step?: string` with `bag?: string` (keep accepting `step` in the type OPTIONALLY for stale links but ignore its value).
- Guided block becomes:

```ts
const guided = rawGuided === "1";
const { steps: guidedSteps, excluded: guidedExcluded } = deriveGuidedCloseoutQueue(summary.rows, bucketByBag);
const guidedTotalSteps = guidedSteps.length + (hasSafeBatch ? 1 : 0);
const rawBag = /* from searchParams */;
const requestedTarget: GuidedTarget | null =
  rawBag === "batch" || rawBag === "finish" || (typeof rawBag === "string" && rawBag.length > 0)
    ? (rawBag as GuidedTarget)
    : null;
// Entry: bare ?guided=1 resolves to batch, else the first live bag, else finish.
const currentTarget: GuidedTarget =
  requestedTarget ?? (hasSafeBatch ? "batch" : guidedSteps[0]?.inventoryBagId ?? "finish");
const nav = resolveGuidedNav(guidedSteps, currentTarget, hasSafeBatch);
const currentGuidedStep = nav.mode === "bag" && nav.index != null ? guidedSteps[nav.index] ?? null : null;
// guidedBagStep built exactly as before from currentGuidedStep (rowFacts lookup unchanged)
const guidedFinish = guided && nav.mode === "finish" ? { /* unchanged rollup */ } : null;
const doneReceipt =
  nav.mode === "bag-done"
    ? summary.rows.find((r) => r.inventoryBagId === currentTarget)?.receiptNumber ?? null
    : null;
const stepNumber =
  nav.mode === "batch" ? 1 : nav.mode === "bag" && nav.index != null ? nav.index + 1 + (hasSafeBatch ? 1 : 0) : guidedTotalSteps;
```

- Overlay invocation passes the new props; CTA link becomes `href={`/po-closeout/${poId}?guided=1`}` with label `Close this PO (${guidedTotalSteps} step${guidedTotalSteps === 1 ? "" : "s"})` — render it when `guidedTotalSteps > 0` as before.

- [ ] **Step 3: Rewrite the overlay**

`guided-overlay.tsx` becomes a client component with `useRouter()`; keep `useRefreshSuppression()`. Key pieces (adapt the existing JSX skeleton — header, scrollable body, footer):

```tsx
const router = useRouter();
const hrefFor = (t: GuidedTarget) => `/po-closeout/${poId}?guided=1&bag=${t}`;
const exitHref = `/po-closeout/${poId}`;
const go = (t: GuidedTarget) => router.replace(hrefFor(t));
const exit = () => router.replace(exitHref);
```

- Header: `Step ${stepNumber} of ${totalSteps}` (batch shows "apply all safe actions"; finish shows the finished headline; bag-done shows "already handled"). Exit is a `<button onClick={exit}>` (not a Link).
- Exclusion note, rendered under the header whenever `excluded.onFloor + excluded.empty > 0`:

```tsx
<p className="text-[10px] text-text-subtle">
  {excluded.onFloor > 0 ? `${excluded.onFloor} bag${excluded.onFloor === 1 ? "" : "s"} on floor` : null}
  {excluded.onFloor > 0 && excluded.empty > 0 ? ", " : null}
  {excluded.empty > 0 ? `${excluded.empty} empty bag${excluded.empty === 1 ? "" : "s"}` : null}
  {" — not shown (nothing for an admin to do here)."}
</p>
```

- Body by mode: `batch` → `<SafeBatchStep poId issueReady releaseReady continueHref={`/po-closeout/${poId}?guided=1`} />`; `bag` → the bag header line + `<BagDrawer … primaryOnly />` (the floorOnly notice block can be deleted — floor bags are excluded now); `bag-done` →

```tsx
<div className="rounded border border-good-200 bg-good-50/50 px-3 py-2 text-sm text-good-800">
  {doneReceipt ?? "This bag"} is already handled — it left the queue while you were working.
</div>
```

`finish` → unchanged rollup JSX.
- Footer: Back button — `prevTarget ? <button onClick={() => go(prevTarget)}>Back</button> : <button onClick={exit}>Exit</button>`; middle caption unchanged; forward button — finish mode: `<button onClick={exit}>Done — back to closeout</button>`; otherwise `<button onClick={() => go(nextTarget)}>{mode === "bag-done" ? "Continue" : "Next"}</button>`. "Skip for now" disappears with floor steps; Next always advances by identity.
- Delete the `"Nothing to do on this step."` branch entirely — every mode renders a real panel.
- Type imports: `GuidedTarget` from `@/lib/production/guided-closeout`.

- [ ] **Step 4: Verify**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' 'app/(admin)/po-closeout/closeout-freshness.test.ts' lib/production/guided-closeout.test.ts && npx tsc --noEmit`
Expected: PASS (freshness test still sees `useRefreshSuppression()` in the overlay).

- [ ] **Step 5: Commit**

```bash
git add 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/_guided/guided-overlay.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(guided): bag-addressed steps, replace-nav, done-bag fallback, exclusion note"
```

---

### Task 5: Phase gate — full suite, build

**Files:** none new.

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint` — clean.
- [ ] **Step 2:** `npx vitest run` — all pass (baseline 5735 + additions). Any failure anywhere is this phase's to investigate (superpowers:systematic-debugging).
- [ ] **Step 3:** `npm run build` — completes.
- [ ] **Step 4:** Report in the canonical `luma-test-build-deploy` shape. No push/deploy — human reviews first.
