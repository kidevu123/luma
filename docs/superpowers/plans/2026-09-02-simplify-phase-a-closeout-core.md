# Luma Simplify Phase A — Closeout Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the PO closeout page around action-oriented buckets (Do here / On floor / Waiting on Zoho / Done, empty bags hidden), make every dead link real, put the primary action inline on each row, stop auto-refresh from wiping in-progress work, and collapse zero-bag POs on the index.

**Architecture:** All classification stays in the pure verdict layer (`lib/production/po-closeout.ts`) — the page maps buckets to tabs and never re-derives policy. Inline row actions call the same existing server actions the drawer panels call (the `_drawer` convention: no new mutation endpoints). Refresh suppression is a tiny module-level counter store shared by client components.

**Tech Stack:** Next.js 15 App Router (RSC + server actions), React 19, TypeScript strict, Drizzle/Postgres, Tailwind v3, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-luma-simplify-design.md` (Phase A section)

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index access yields `T | undefined`; don't assign `undefined` to optional props.
- No emoji anywhere in UI — Lucide icons + colored chips + text only.
- Every mutation writes `audit_log`; this phase adds NO new mutation endpoints — inline buttons reuse existing server actions verbatim.
- `workflow_events` is the source of truth; UI reads read models / existing loaders only.
- Operational pages keep `export const dynamic = "force-dynamic"` and `export const revalidate = 0`.
- Structural tests (`app/(admin)/po-closeout/po-closeout-structural.test.ts`, `closeout-freshness.test.ts`) assert on source text — when a task changes an asserted pattern, the same task updates the assertion to the new truthful pattern (never deletes a guarantee).
- Never push to `main` without typecheck + lint clean; full suite green before push (Task 9).
- Run tests with `npx vitest run <file>` (single file) — the full suite is ~5.6k tests, save it for Task 9.
- Commit messages: conventional commits (`feat(closeout): …`), body lines end with the repo's standard Co-Authored-By/Claude-Session trailers if the session provides them.

---

### Task 1: Bucket classifier in the verdict layer

**Files:**
- Modify: `lib/production/po-closeout.ts` (append after `summarizeRowStatuses`, ~line 476)
- Test: `lib/production/po-closeout.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: existing `PoCloseoutRowVerdict` (`status`, `action` fields).
- Produces: `type CloseoutBucket = "DO_HERE" | "ON_FLOOR" | "WAITING_ZOHO" | "DONE" | "EMPTY"`, `deriveCloseoutBucket(row, producedTablets): CloseoutBucket`, `summarizeBuckets(buckets: CloseoutBucket[]): Record<CloseoutBucket, number>`. Tasks 2, 3, 6 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `lib/production/po-closeout.test.ts`:

```ts
import { deriveCloseoutBucket, summarizeBuckets, type CloseoutBucket } from "./po-closeout";

describe("SIMPLIFY-A: deriveCloseoutBucket — action-oriented closeout buckets", () => {
  const base = { status: "NEEDS_REVIEW" as const, action: "REVIEW_MANUALLY" as const, workflowBagId: "wf-1" };

  it("DONE status is DONE regardless of action", () => {
    expect(deriveCloseoutBucket({ ...base, status: "DONE", action: "NONE" }, 0)).toBe("DONE");
    expect(deriveCloseoutBucket({ ...base, status: "DONE", action: "NONE" }, null)).toBe("DONE");
  });

  it("in-progress floor run (workflow exists) is ON_FLOOR even with 0 produced so far", () => {
    expect(
      deriveCloseoutBucket({ status: "NEEDS_REVIEW", action: "START_OR_FINALIZE_WORKFLOW", workflowBagId: "wf-1" }, 0),
    ).toBe("ON_FLOOR");
  });

  it("never-started bag with no production is EMPTY (hidden by default)", () => {
    expect(
      deriveCloseoutBucket({ status: "NEEDS_REVIEW", action: "START_OR_FINALIZE_WORKFLOW", workflowBagId: null }, 0),
    ).toBe("EMPTY");
    expect(
      deriveCloseoutBucket({ status: "NEEDS_REVIEW", action: "START_OR_FINALIZE_WORKFLOW", workflowBagId: null }, null),
    ).toBe("EMPTY");
  });

  it("Zoho queue/retry work is WAITING_ZOHO whether ready, not-ready, or failed", () => {
    expect(deriveCloseoutBucket({ status: "READY_FOR_ACTION", action: "QUEUE_OR_RETRY_ZOHO", workflowBagId: "wf-1" }, 100)).toBe("WAITING_ZOHO");
    expect(deriveCloseoutBucket({ status: "NEEDS_REVIEW", action: "QUEUE_OR_RETRY_ZOHO", workflowBagId: "wf-1" }, 100)).toBe("WAITING_ZOHO");
    expect(deriveCloseoutBucket({ status: "BLOCKED", action: "QUEUE_OR_RETRY_ZOHO", workflowBagId: "wf-1" }, 100)).toBe("WAITING_ZOHO");
  });

  it("everything else actionable on this page is DO_HERE", () => {
    const doHereActions = [
      "REPAIR_QR_RESERVATION",
      "CORRECT_STARTING_BALANCE",
      "RECORD_REMAINING_OR_CLOSE_PARTIAL",
      "AUTO_ISSUE_FINISHED_LOT",
      "ISSUE_FINISHED_LOT",
      "AUTO_RELEASE_FINISHED_LOT",
      "REVIEW_QC_HOLD",
      "FIX_PRODUCT_SETUP",
      "REVIEW_MANUALLY",
    ] as const;
    for (const action of doHereActions) {
      expect(deriveCloseoutBucket({ status: "NEEDS_REVIEW", action, workflowBagId: "wf-1" }, 500)).toBe("DO_HERE");
    }
  });

  it("summarizeBuckets counts every bucket, zero-filled", () => {
    const buckets: CloseoutBucket[] = ["DO_HERE", "DO_HERE", "DONE", "EMPTY"];
    expect(summarizeBuckets(buckets)).toEqual({
      DO_HERE: 2, ON_FLOOR: 0, WAITING_ZOHO: 0, DONE: 1, EMPTY: 1,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL — `deriveCloseoutBucket` is not exported.

- [ ] **Step 3: Implement**

Append to `lib/production/po-closeout.ts`:

```ts
// ── SIMPLIFY-A · action-oriented closeout buckets ───────────────────────────
// Rebuckets the row verdict by WHERE the next step happens, so the closeout
// page can answer "what needs a person HERE" without mixing floor state,
// lot work, and Zoho into one review pile. Pure derivation over the verdict
// the classifier already computed — adds no policy of its own.

export type CloseoutBucket = "DO_HERE" | "ON_FLOOR" | "WAITING_ZOHO" | "DONE" | "EMPTY";

export function deriveCloseoutBucket(
  row: Pick<PoCloseoutRowVerdict, "status" | "action"> & { workflowBagId: string | null },
  /** From the bag production summary; null when no summary exists. */
  producedTablets: number | null,
): CloseoutBucket {
  if (row.status === "DONE") return "DONE";
  if (row.action === "START_OR_FINALIZE_WORKFLOW") {
    // An existing run must be finished on the floor; a never-started bag with
    // zero production is empty noise on a closeout worklist.
    if (row.workflowBagId != null) return "ON_FLOOR";
    return (producedTablets ?? 0) > 0 ? "ON_FLOOR" : "EMPTY";
  }
  if (row.action === "QUEUE_OR_RETRY_ZOHO") return "WAITING_ZOHO";
  return "DO_HERE";
}

export function summarizeBuckets(buckets: CloseoutBucket[]): Record<CloseoutBucket, number> {
  const out: Record<CloseoutBucket, number> = {
    DO_HERE: 0, ON_FLOOR: 0, WAITING_ZOHO: 0, DONE: 0, EMPTY: 0,
  };
  for (const b of buckets) out[b] += 1;
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: PASS (all pre-existing tests in the file still green).

- [ ] **Step 5: Commit**

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts
git commit -m "feat(closeout): action-oriented bucket classifier (DO_HERE/ON_FLOOR/WAITING_ZOHO/DONE/EMPTY)"
```

---

### Task 2: Recommended-next-action derivation

**Files:**
- Create: `lib/production/closeout-recommendation.ts`
- Test: `lib/production/closeout-recommendation.test.ts`

**Interfaces:**
- Consumes: `Record<CloseoutBucket, number>` from Task 1's `summarizeBuckets`; the page's existing `issueReady` / `releaseReady` counts.
- Produces: `recommendCloseoutNextAction(input): CloseoutRecommendation | null` where `type CloseoutRecommendation = { headline: string; kind: "BULK_ISSUE" | "BULK_RELEASE" | "WORK_DO_HERE" | "FLOOR" | "ZOHO" }`. Task 3 renders it.

- [ ] **Step 1: Write the failing tests**

Create `lib/production/closeout-recommendation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recommendCloseoutNextAction } from "./closeout-recommendation";

const zero = { DO_HERE: 0, ON_FLOOR: 0, WAITING_ZOHO: 0, DONE: 0, EMPTY: 0 };

describe("SIMPLIFY-A: recommendCloseoutNextAction — one recommended action, not a blocker stack", () => {
  it("bulk issue wins when issue-ready bags exist", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 7 }, issueReady: 5, releaseReady: 2 });
    expect(r).toEqual({ headline: "5 bags ready to issue finished lots", kind: "BULK_ISSUE" });
  });

  it("bulk release next when only release-ready bags exist", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 2 }, issueReady: 0, releaseReady: 2 });
    expect(r).toEqual({ headline: "2 lots ready to release", kind: "BULK_RELEASE" });
  });

  it("then remaining Do-here work", () => {
    const r = recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 3, WAITING_ZOHO: 40 }, issueReady: 0, releaseReady: 0 });
    expect(r).toEqual({ headline: "3 bags need a decision here", kind: "WORK_DO_HERE" });
  });

  it("then floor work, then Zoho", () => {
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, ON_FLOOR: 2, WAITING_ZOHO: 5 }, issueReady: 0, releaseReady: 0 }),
    ).toEqual({ headline: "2 bags still in production on the floor", kind: "FLOOR" });
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, WAITING_ZOHO: 5 }, issueReady: 0, releaseReady: 0 }),
    ).toEqual({ headline: "5 bags waiting on Zoho mapping or queueing", kind: "ZOHO" });
  });

  it("singular forms read correctly", () => {
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 1 }, issueReady: 1, releaseReady: 0 })?.headline,
    ).toBe("1 bag ready to issue finished lots");
    expect(
      recommendCloseoutNextAction({ buckets: { ...zero, DO_HERE: 1 }, issueReady: 0, releaseReady: 0 })?.headline,
    ).toBe("1 bag needs a decision here");
  });

  it("nothing open returns null (no banner)", () => {
    expect(recommendCloseoutNextAction({ buckets: { ...zero, DONE: 40, EMPTY: 15 }, issueReady: 0, releaseReady: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/closeout-recommendation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/production/closeout-recommendation.ts`:

```ts
// SIMPLIFY-A — collapse the closeout blocker stack into one recommended next
// action. Pure priority ladder over bucket counts; the page renders exactly
// one banner from this (details stay behind an expand).

import type { CloseoutBucket } from "./po-closeout";

export type CloseoutRecommendation = {
  headline: string;
  kind: "BULK_ISSUE" | "BULK_RELEASE" | "WORK_DO_HERE" | "FLOOR" | "ZOHO";
};

const bags = (n: number) => `${n} bag${n === 1 ? "" : "s"}`;

export function recommendCloseoutNextAction(input: {
  buckets: Record<CloseoutBucket, number>;
  issueReady: number;
  releaseReady: number;
}): CloseoutRecommendation | null {
  const { buckets, issueReady, releaseReady } = input;
  if (issueReady > 0) {
    return { headline: `${bags(issueReady)} ready to issue finished lots`, kind: "BULK_ISSUE" };
  }
  if (releaseReady > 0) {
    return { headline: `${releaseReady} lot${releaseReady === 1 ? "" : "s"} ready to release`, kind: "BULK_RELEASE" };
  }
  if (buckets.DO_HERE > 0) {
    return {
      headline: `${bags(buckets.DO_HERE)} need${buckets.DO_HERE === 1 ? "s" : ""} a decision here`,
      kind: "WORK_DO_HERE",
    };
  }
  if (buckets.ON_FLOOR > 0) {
    return { headline: `${bags(buckets.ON_FLOOR)} still in production on the floor`, kind: "FLOOR" };
  }
  if (buckets.WAITING_ZOHO > 0) {
    return { headline: `${bags(buckets.WAITING_ZOHO)} waiting on Zoho mapping or queueing`, kind: "ZOHO" };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/closeout-recommendation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/closeout-recommendation.ts lib/production/closeout-recommendation.test.ts
git commit -m "feat(closeout): single recommended-next-action derivation"
```

---

### Task 3: Restructure the closeout detail page around buckets

**Files:**
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (FILTERS block lines 46-104, tab render lines 320-359, top-blockers lines 308-318, summary cards lines 251-266)
- Modify: `app/(admin)/po-closeout/po-closeout-structural.test.ts` (the "detail page … filter tabs" assertion, ~line 70)
- Test: structural test file above + `npx vitest run` on it

**Interfaces:**
- Consumes: `deriveCloseoutBucket`, `summarizeBuckets` (Task 1), `recommendCloseoutNextAction` (Task 2), existing `qs()` URL helper, existing `PoBatchButtons`.
- Produces: URL contract `?tab=do-here|on-floor|zoho|done|all` and `?empty=1` (show empty bags). Wizard (Phase D) and Zoho work (Phase C) will read the same bucket fields — do not rename them.

- [ ] **Step 1: Replace the status FILTERS with bucket tabs**

In `app/(admin)/po-closeout/[poId]/page.tsx`, replace the `FILTERS` const and `matchesFilter` (lines 46-64) with:

```ts
// SIMPLIFY-A — tabs are action-oriented buckets: who/where does the next step.
const TABS = [
  { key: "do-here", label: "Do here", bucket: "DO_HERE" },
  { key: "on-floor", label: "On floor", bucket: "ON_FLOOR" },
  { key: "zoho", label: "Waiting on Zoho", bucket: "WAITING_ZOHO" },
  { key: "done", label: "Done", bucket: "DONE" },
  { key: "all", label: "All", bucket: null },
] as const;
type TabKey = (typeof TABS)[number]["key"];
```

In the component body (replacing the `filter` parse at line 123 and the `shown` computation):

```ts
const tab = (TABS.find((t) => t.key === rawTab)?.key ?? "do-here") as TabKey;
const showEmpty = rawEmpty === "1";

const bucketByBag = new Map(
  summary.rows.map((r) => [
    r.inventoryBagId,
    deriveCloseoutBucket(r, productionByBag.get(r.inventoryBagId)?.producedTablets ?? null),
  ]),
);
const bucketCounts = summarizeBuckets([...bucketByBag.values()]);
const activeBucket = TABS.find((t) => t.key === tab)?.bucket ?? null;
const shown = summary.rows.filter((r) => {
  const b = bucketByBag.get(r.inventoryBagId) ?? "DO_HERE";
  if (b === "EMPTY" && !showEmpty && activeBucket !== null) return false;
  if (activeBucket === null) return showEmpty || b !== "EMPTY";
  return b === activeBucket || (activeBucket === "DO_HERE" && b === "EMPTY" && showEmpty);
});
```

`searchParams` type gains `tab?: string; empty?: string` and drops `filter`. The `qs()` helper switches from `filter` to `tab` and includes `empty` only when set (remember `exactOptionalPropertyTypes` — build the params object conditionally, as the current code does for `tablet`).

- [ ] **Step 2: Collapse the production show-filters**

Delete `SHOW_FILTERS` keys now expressed by buckets — `has-production`, `no-production`, `awaiting-lot`, `zoho-blocked` — keeping `any`, `partial`, `multi-run`, `over-consumed` (and their `matchesShowFilter` cases). The filter row renders only when the remaining keys matter, with the label "Refine:".

- [ ] **Step 3: Render bucket tabs with counts, plus the empty-bags toggle**

Replace the filter-tabs JSX block (lines 320-341):

```tsx
<div className="flex flex-wrap items-center gap-1.5">
  {TABS.map((t) => {
    const count =
      t.bucket === null
        ? c.total - (showEmpty ? 0 : bucketCounts.EMPTY)
        : t.bucket === "DO_HERE" && showEmpty
          ? bucketCounts.DO_HERE + bucketCounts.EMPTY
          : bucketCounts[t.bucket];
    const active = t.key === tab;
    return (
      <Link key={t.key} href={qs({ tab: t.key })} className={/* same active/inactive pill classes as before */}>
        {t.label} ({count})
      </Link>
    );
  })}
  {bucketCounts.EMPTY > 0 ? (
    <Link href={qs({ empty: showEmpty ? "" : "1" })} className="text-[11px] text-text-muted underline decoration-dotted">
      {showEmpty ? "Hide" : "Show"} {bucketCounts.EMPTY} empty bag{bucketCounts.EMPTY === 1 ? "" : "s"} (no production)
    </Link>
  ) : null}
</div>
```

- [ ] **Step 4: Replace the top-blockers stack with the single recommendation banner**

Replace the "Top blockers" block (lines 308-318):

```tsx
{recommendation ? (
  <div className="rounded-lg border border-brand-300/40 bg-brand-50/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
    <p className="text-[12px] font-medium text-brand-900">Next: {recommendation.headline}</p>
    {summary.topBlockers.length > 0 ? (
      <details className="text-[11px] text-text-muted">
        <summary className="cursor-pointer">All open reasons</summary>
        <ul className="mt-1 space-y-0.5">
          {summary.topBlockers.map((b) => (
            <li key={b.reason}>{b.count}× {b.reason}</li>
          ))}
        </ul>
      </details>
    ) : null}
  </div>
) : null}
```

with `const recommendation = recommendCloseoutNextAction({ buckets: bucketCounts, issueReady, releaseReady });` computed alongside `issueReady`/`releaseReady`. Update the summary cards row (lines 252-266) to show bucket counts (`Do here`, `On floor`, `Waiting on Zoho`, `Done`, `Empty`, `Bags`) instead of Ready/Review/Blocked.

- [ ] **Step 5: Update the structural test**

In `po-closeout-structural.test.ts`, the detail-page assertion (~line 70) currently matches the old filter tabs. Update it to assert the new structure and add a guard that policy stays in the pure layer:

```ts
it("detail page renders bucket tabs from the pure bucket classifier (no inline policy)", () => {
  expect(detailPageSrc).toMatch(/deriveCloseoutBucket/);
  expect(detailPageSrc).toMatch(/summarizeBuckets/);
  expect(detailPageSrc).toMatch(/recommendCloseoutNextAction/);
  expect(detailPageSrc).toMatch(/"do-here"/);
  expect(detailPageSrc).toMatch(/Waiting on Zoho/);
  expect(detailPageSrc).toMatch(/empty bag/i);
});
```

(Keep every other existing assertion; adjust only ones that reference the removed `filter=`/`FILTERS` structure. The guided wizard still reads `?guided=1&step=N` this phase — do not touch `_guided/` here; if its `qs`-adjacent code referenced `filter`, leave the guided links as-is.)

- [ ] **Step 6: Verify**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' 'app/(admin)/po-closeout/closeout-freshness.test.ts' lib/production/po-closeout.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): action-oriented tabs, empty-bag toggle, single recommendation banner"
```

---

### Task 4: Refresh suppression

**Files:**
- Create: `lib/ui/refresh-suppression.ts`
- Create: `lib/ui/refresh-suppression.test.ts`
- Modify: `components/admin/auto-refresh-on-focus.tsx`
- Modify: `app/(admin)/po-closeout/_drawer/bag-drawer.tsx` (suppress while mounted)
- Modify: `app/(admin)/po-closeout/_guided/guided-overlay.tsx` (suppress while mounted — mechanism only; Phase D does the rest)
- Modify: `app/(admin)/po-closeout/closeout-freshness.test.ts` (add assertions)

**Interfaces:**
- Consumes: nothing.
- Produces: `acquireRefreshSuppression(): () => void` (returns a release fn), `isRefreshSuppressed(): boolean`, `useRefreshSuppression(active?: boolean): void` (React hook wrapping acquire/release in an effect). Phase D reuses `useRefreshSuppression`.

- [ ] **Step 1: Write the failing tests**

Create `lib/ui/refresh-suppression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { acquireRefreshSuppression, isRefreshSuppressed } from "./refresh-suppression";

describe("SIMPLIFY-A: refresh suppression counter", () => {
  it("not suppressed by default", () => {
    expect(isRefreshSuppressed()).toBe(false);
  });
  it("suppressed while any holder is active; released when all release", () => {
    const releaseA = acquireRefreshSuppression();
    const releaseB = acquireRefreshSuppression();
    expect(isRefreshSuppressed()).toBe(true);
    releaseA();
    expect(isRefreshSuppressed()).toBe(true);
    releaseB();
    expect(isRefreshSuppressed()).toBe(false);
  });
  it("double release is harmless (idempotent)", () => {
    const release = acquireRefreshSuppression();
    release();
    release();
    expect(isRefreshSuppressed()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/ui/refresh-suppression.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `lib/ui/refresh-suppression.ts`:

```ts
// SIMPLIFY-A — module-level suppression counter for AutoRefreshOnFocus.
// A drawer, an open form, or the guided overlay acquires suppression while
// mounted so a background router.refresh() cannot re-derive the page under
// an operator mid-task. Client-bundle singleton; no React state needed.

let holders = 0;

export function acquireRefreshSuppression(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
  };
}

export function isRefreshSuppressed(): boolean {
  return holders > 0;
}
```

Create the hook in the same file (kept together — it is 10 lines and changes with the store):

```ts
import * as React from "react";

/** Suppress auto-refresh while the calling component is mounted (and `active`). */
export function useRefreshSuppression(active: boolean = true): void {
  React.useEffect(() => {
    if (!active) return;
    return acquireRefreshSuppression();
  }, [active]);
}
```

- [ ] **Step 4: Wire into AutoRefreshOnFocus**

In `components/admin/auto-refresh-on-focus.tsx`, inside the `refresh` closure (line 28), add two guards before the gap check:

```ts
const refresh = () => {
  // Never refresh under an operator mid-task: an open drawer/overlay holds
  // suppression, and a focused form control means someone is typing.
  if (isRefreshSuppressed()) return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
  const now = Date.now();
  if (now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) return;
  lastRefreshRef.current = now;
  router.refresh();
};
```

with `import { isRefreshSuppressed } from "@/lib/ui/refresh-suppression";`.

- [ ] **Step 5: Acquire suppression in the drawer and guided overlay**

In `app/(admin)/po-closeout/_drawer/bag-drawer.tsx`, add at the top of the component body: `useRefreshSuppression();` (import from `@/lib/ui/refresh-suppression`). In `app/(admin)/po-closeout/_guided/guided-overlay.tsx` (a client component), add the same single line at the top of its component body. No other guided changes in this phase.

- [ ] **Step 6: Extend the freshness structural test**

In `app/(admin)/po-closeout/closeout-freshness.test.ts`, inside the "open tabs cannot silently go stale" describe, add:

```ts
it("auto-refresh is suppressed while a drawer/overlay is open or a form is focused", () => {
  const src = repo("components/admin/auto-refresh-on-focus.tsx");
  expect(src).toMatch(/isRefreshSuppressed\(\)/);
  expect(src).toMatch(/HTMLInputElement/);
  expect(repo("app/(admin)/po-closeout/_drawer/bag-drawer.tsx")).toMatch(/useRefreshSuppression\(\)/);
  expect(repo("app/(admin)/po-closeout/_guided/guided-overlay.tsx")).toMatch(/useRefreshSuppression\(\)/);
});
```

(Match the file's existing `repo(...)` helper name — check the top of the file; it may read sources differently. Use whatever source-reading helper that file already defines.)

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run lib/ui/refresh-suppression.test.ts 'app/(admin)/po-closeout/closeout-freshness.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add lib/ui/refresh-suppression.ts lib/ui/refresh-suppression.test.ts components/admin/auto-refresh-on-focus.tsx 'app/(admin)/po-closeout/_drawer/bag-drawer.tsx' 'app/(admin)/po-closeout/_guided/guided-overlay.tsx' 'app/(admin)/po-closeout/closeout-freshness.test.ts'
git commit -m "feat(closeout): suppress auto-refresh while drawers/overlays/forms are active"
```

---

### Task 5: Real links — bag deep-link into workflows, corrected rowLink targets

**Files:**
- Modify: `app/(admin)/workflow-submissions/page.tsx` (add `bag` search param → condition + pass-through)
- Modify: `app/(admin)/workflow-submissions/workflow-table.tsx` (accept `autoExpandBagId`, auto-expand that row)
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx` (`rowLink`, lines 28-52)
- Test: create `app/(admin)/workflow-submissions/workflow-deeplink-structural.test.ts`

**Interfaces:**
- Consumes: `PoCloseoutRow.inventoryBagId` / `.workflowBagId` (already on every row).
- Produces: URL contract `/workflow-submissions?bag=<inventoryBagId>` (filters the list to that inventory bag and auto-expands its row) and `/finished-lots/new?bagId=<inventoryBagId>` links from closeout. Phase D's wizard links reuse the same contract.

- [ ] **Step 1: Write the failing structural test**

Create `app/(admin)/workflow-submissions/workflow-deeplink-structural.test.ts`:

```ts
// SIMPLIFY-A — "Finalize workflow" from closeout must land ON the bag, not an
// unfiltered 85-row list. Structural (DB paths need Postgres).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pageSrc = repo("app/(admin)/workflow-submissions/page.tsx");
const tableSrc = repo("app/(admin)/workflow-submissions/workflow-table.tsx");
const rowsSrc = repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx");

describe("workflow deep-link (?bag=)", () => {
  it("page parses ?bag= and filters by inventoryBags.id", () => {
    expect(pageSrc).toMatch(/sp\["bag"\]/);
    expect(pageSrc).toMatch(/eq\(inventoryBags\.id,/);
  });
  it("table auto-expands the deep-linked bag row", () => {
    expect(tableSrc).toMatch(/autoExpandBagId/);
  });
  it("closeout rows deep-link workflows by bag and lot issuance by bagId", () => {
    expect(rowsSrc).toMatch(/\/workflow-submissions\?bag=/);
    expect(rowsSrc).toMatch(/\/finished-lots\/new\?bagId=/);
    expect(rowsSrc).not.toMatch(/href: "\/workflow-submissions", label: "Open workflows"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run 'app/(admin)/workflow-submissions/workflow-deeplink-structural.test.ts'`
Expected: FAIL on all three.

- [ ] **Step 3: Implement the page filter**

In `app/(admin)/workflow-submissions/page.tsx`, after the `to` parse (line 56):

```ts
// SIMPLIFY-A — deep-link target for closeout's "Finalize on floor" links.
const bag = typeof sp["bag"] === "string" && /^[0-9a-f-]{36}$/i.test(sp["bag"]) ? sp["bag"] : null;
```

Add to `conditions`: `if (bag !== null) conditions.push(eq(inventoryBags.id, bag));`

The query already left-joins `inventoryBags` (line 132). Find the workflow row for the bag after the query runs and pass it down at line 333:

```tsx
<WorkflowTable
  bags={bags}
  canAdminRepair={canAdminRepair}
  autoExpandBagId={bag !== null && bags.length === 1 ? bags[0]?.id ?? null : null}
/>
```

Also surface the active filter: when `bag !== null`, render above the table a small line — `Showing 1 bag from PO closeout.` with a `Clear filter` link to `/workflow-submissions` (plain `<Link>`, same pill styling as existing filter UI).

- [ ] **Step 4: Implement auto-expand in the table**

In `workflow-table.tsx`:
- `WorkflowTable` (line 770) gains prop `autoExpandBagId?: string | null` and passes `autoExpand={bag.id === autoExpandBagId}` to each `BagRow`.
- `BagRow` (line 580) gains prop `autoExpand?: boolean` and adds after the `toggle` callback:

```ts
const autoExpandedRef = useRef(false);
useEffect(() => {
  if (autoExpand && !autoExpandedRef.current && expand.status === "idle") {
    autoExpandedRef.current = true;
    void toggle();
  }
}, [autoExpand, expand.status, toggle]);
```

(`useEffect`/`useRef` are added to the existing react import at line 3.)

- [ ] **Step 5: Fix rowLink in closeout**

In `closeout-rows.tsx`, update `rowLink` cases:

```ts
case "START_OR_FINALIZE_WORKFLOW":
  return { href: `/workflow-submissions?bag=${row.inventoryBagId}`, label: "Finalize on floor" };
case "AUTO_ISSUE_FINISHED_LOT":
case "ISSUE_FINISHED_LOT":
  return { href: `/finished-lots/new?bagId=${row.inventoryBagId}`, label: "Open issue form" };
case "FIX_PRODUCT_SETUP":
  return { href: "/products", label: "Open products" };
```

(Verify during implementation that `/finished-lots/new?bagId=` preselects by **inventory** bag id — read `app/(admin)/finished-lots/new/page.tsx`'s `?bagId=` handling; if it keys on workflow bag id, pass `row.workflowBagId` instead and note it in the commit message. Keep every other case unchanged.)

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run 'app/(admin)/workflow-submissions/workflow-deeplink-structural.test.ts' 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add 'app/(admin)/workflow-submissions/page.tsx' 'app/(admin)/workflow-submissions/workflow-table.tsx' 'app/(admin)/po-closeout/_drawer/closeout-rows.tsx' 'app/(admin)/workflow-submissions/workflow-deeplink-structural.test.ts'
git commit -m "feat(closeout): real deep-links — workflows by bag with auto-expand, issue form by bag"
```

---

### Task 6: Inline primary action button on closeout rows

**Files:**
- Create: `app/(admin)/po-closeout/_drawer/row-action-button.tsx`
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx` (render it in the "What's next" cell)
- Modify: `app/(admin)/po-closeout/po-closeout-structural.test.ts` (assert the convention holds)

**Interfaces:**
- Consumes: `repairAutoIssueFinishedLotAction(workflowBagId: string)` and `setFinishedLotStatusAction({ id, status, reason? })` from `@/app/(admin)/finished-lots/actions` — the exact actions the drawer's `LotActions` already calls.
- Produces: `<RowActionButton row={PoCloseoutRow} />` rendering at most one button; rows without a safe inline action render nothing (the drawer stays the path for everything else).

- [ ] **Step 1: Extend the structural test (failing first)**

In `po-closeout-structural.test.ts`, add to the "bag drawer UI" describe:

```ts
it("SIMPLIFY-A: inline row action reuses EXISTING finished-lot actions, no new mutation endpoints", () => {
  const src = repo("app/(admin)/po-closeout/_drawer/row-action-button.tsx");
  expect(src).toMatch(/from "@\/app\/\(admin\)\/finished-lots\/actions"/);
  expect(src).toMatch(/repairAutoIssueFinishedLotAction/);
  expect(src).toMatch(/setFinishedLotStatusAction/);
  expect(src).not.toMatch(/"use server"/);
  expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/RowActionButton/);
});
```

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts'` — expected FAIL (file missing).

- [ ] **Step 2: Implement the button**

Create `app/(admin)/po-closeout/_drawer/row-action-button.tsx`:

```tsx
"use client";

// SIMPLIFY-A — the row's single primary action, inline. No expand, no wait.
// Calls the EXISTING finished-lots server actions verbatim (same as the
// drawer's LotActions). Only the two deterministic, safe actions render a
// button; everything else keeps the drawer/link path.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  repairAutoIssueFinishedLotAction,
  setFinishedLotStatusAction,
} from "@/app/(admin)/finished-lots/actions";
import type { PoCloseoutRow } from "@/lib/db/queries/po-closeout";

export function RowActionButton({ row }: { row: PoCloseoutRow }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    const r = (await fn()) as { error?: string } | null;
    setPending(false);
    if (r && typeof r === "object" && "error" in r && r.error) setError(r.error);
    else router.refresh();
  };

  let button: { label: string; onClick: () => void } | null = null;
  if (
    (row.action === "AUTO_ISSUE_FINISHED_LOT" || (row.action === "ISSUE_FINISHED_LOT" && row.status === "READY_FOR_ACTION")) &&
    row.workflowBagId
  ) {
    const workflowBagId = row.workflowBagId;
    button = { label: "Issue lot", onClick: () => void run(() => repairAutoIssueFinishedLotAction(workflowBagId)) };
  } else if (row.action === "AUTO_RELEASE_FINISHED_LOT" && row.finishedLotId && row.status === "READY_FOR_ACTION") {
    const finishedLotId = row.finishedLotId;
    button = {
      label: "Release lot",
      onClick: () => void run(() => setFinishedLotStatusAction({ id: finishedLotId, status: "RELEASED" })),
    };
  }

  if (!button) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={pending}
        onClick={button.onClick}
        className="rounded bg-brand-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
      >
        {pending ? "Working…" : button.label}
      </button>
      {error ? (
        <p className="mt-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-800">{error}</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Render it in the row**

In `closeout-rows.tsx`, import `RowActionButton` and add inside the "What's next" cell (after the reason div, line 136):

```tsx
<RowActionButton row={row} />
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add 'app/(admin)/po-closeout/_drawer/row-action-button.tsx' 'app/(admin)/po-closeout/_drawer/closeout-rows.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): inline Issue-lot / Release-lot button on the row"
```

---

### Task 7: One-click QC release from hold, unified wording

**Files:**
- Create: `app/(admin)/finished-lots/[id]/lot-transitions.ts` (pure transition table, moved out of the component so tests never import server-action modules)
- Modify: `app/(admin)/finished-lots/[id]/status-actions.tsx` (import the table; delete its inline `ALLOWED` const, lines 16-33; reason UI)
- Modify: `app/(admin)/po-closeout/_drawer/lot-actions.tsx` (HOLD_REVIEW heading wording)
- Test: create `app/(admin)/finished-lots/lot-release-transitions.test.ts`

**Interfaces:**
- Consumes: `setFinishedLotStatusAction` — server-side `setFinishedLotStatus` performs no transition validation and fires `FINISHED_GOODS_RELEASED` with `previous_status` on any `→ RELEASED` move, so `ON_HOLD → RELEASED` is already safe and audited in one call.
- Produces: pure module `lot-transitions.ts` exporting `type LotStatus`, `type LotTransition = { next: LotStatus; label: string; danger?: boolean; needsReason?: boolean; optionalReason?: boolean }`, and `ALLOWED: Record<LotStatus, LotTransition[]>` with `ON_HOLD → RELEASED` labeled "Release lot", reason **optional**. `status-actions.tsx` renders from it.

- [ ] **Step 1: Write the failing test**

Create `app/(admin)/finished-lots/lot-release-transitions.test.ts`:

```ts
// SIMPLIFY-A — one-click release from hold. The transition table is UI policy
// (the server accepts any transition and audits previous_status), so we pin
// the table itself.

import { describe, it, expect } from "vitest";
import { ALLOWED } from "./[id]/lot-transitions";

describe("finished-lot transition table", () => {
  it("ON_HOLD offers a direct Release lot (optional reason) — no two-step clear-then-release", () => {
    const onHold = ALLOWED.ON_HOLD;
    const release = onHold.find((m) => m.next === "RELEASED");
    expect(release).toBeDefined();
    expect(release?.label).toBe("Release lot");
    expect(release?.needsReason ?? false).toBe(false);
    expect(release?.optionalReason).toBe(true);
  });
  it("keeps Clear hold and Recall available from hold", () => {
    expect(ALLOWED.ON_HOLD.some((m) => m.next === "PENDING_QC" && m.label === "Clear hold")).toBe(true);
    expect(ALLOWED.ON_HOLD.some((m) => m.next === "RECALLED")).toBe(true);
  });
  it("PENDING_QC release keeps its existing label", () => {
    expect(ALLOWED.PENDING_QC.some((m) => m.next === "RELEASED" && m.label === "Approve & release")).toBe(true);
  });
});
```

Run: `npx vitest run 'app/(admin)/finished-lots/lot-release-transitions.test.ts'` — expected FAIL (`ALLOWED` not exported).

- [ ] **Step 2: Implement**

Create `app/(admin)/finished-lots/[id]/lot-transitions.ts` — move the existing `Status` type and `ALLOWED` const out of `status-actions.tsx` verbatim, renamed and extended:

```ts
// SIMPLIFY-A — pure finished-lot transition table (UI policy; the server
// accepts any transition and audits previous_status). Kept free of component
// and server-action imports so tests can pin the table directly.
//   PENDING_QC ↔ ON_HOLD     (QA flag / clear)
//   PENDING_QC → RELEASED    (QA approve)
//   ON_HOLD    → RELEASED    (QA release from hold, reason optional)
//   RELEASED   → SHIPPED     (ops mark shipped)
//   any        → RECALLED    (admin only, with required reason)

export type LotStatus = "PENDING_QC" | "RELEASED" | "ON_HOLD" | "SHIPPED" | "RECALLED";

export type LotTransition = {
  next: LotStatus;
  label: string;
  danger?: boolean;
  needsReason?: boolean;
  optionalReason?: boolean;
};

export const ALLOWED: Record<LotStatus, LotTransition[]> = {
  PENDING_QC: [
    { next: "RELEASED", label: "Approve & release" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  ON_HOLD: [
    { next: "RELEASED", label: "Release lot", optionalReason: true },
    { next: "PENDING_QC", label: "Clear hold" },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  RELEASED: [
    { next: "SHIPPED", label: "Mark shipped" },
    { next: "ON_HOLD", label: "Place on hold", needsReason: true },
    { next: "RECALLED", label: "Recall", danger: true, needsReason: true },
  ],
  SHIPPED: [{ next: "RECALLED", label: "Recall", danger: true, needsReason: true }],
  RECALLED: [],
};
```

In `status-actions.tsx`:
- Delete the inline `Status` type and `ALLOWED` const (lines 8-33) and import instead: `import { ALLOWED, type LotStatus } from "./lot-transitions";` (rename local `Status` references to `LotStatus`).
- In the click handler, treat `optionalReason` like `needsReason` (opens the reason box) except the Confirm button is enabled with an empty reason: change the confirm `disabled` condition to `(!reason.trim() && !reasonOpenIsOptional) || pending !== null`, tracking `optional` on the `reasonOpen` state: `setReasonOpen({ next: m.next, label: m.label, optional: m.optionalReason === true })`, and the Input `placeholder` becomes `"Optional"` when optional.

In `lot-actions.tsx` (drawer), change the HOLD_REVIEW heading from `"QC hold review"` to `"Release lot (on hold)"` and the helper copy stays. The drawer already does one-click release with optional reason — wording now matches the lot page.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/finished-lots/lot-release-transitions.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add 'app/(admin)/finished-lots/[id]/lot-transitions.ts' 'app/(admin)/finished-lots/[id]/status-actions.tsx' 'app/(admin)/po-closeout/_drawer/lot-actions.tsx' 'app/(admin)/finished-lots/lot-release-transitions.test.ts'
git commit -m "feat(lots): one-click Release lot from hold with optional reason; unify closeout wording"
```

---

### Task 8: Collapse zero-bag POs on the closeout index

**Files:**
- Modify: `app/(admin)/po-closeout/page.tsx` (table render, lines 128-200)
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `CloseoutPoIndexRow.bagCount` (already on every rollup row).
- Produces: Active tab renders POs with `bagCount === 0` in a collapsed `<details>` section, not as full table rows.

- [ ] **Step 1: Write the failing structural test**

Add to the "PO closeout pages" describe in `po-closeout-structural.test.ts`:

```ts
it("SIMPLIFY-A: zero-bag POs are collapsed, not full rows", () => {
  expect(listPageSrc).toMatch(/bagCount === 0/);
  expect(listPageSrc).toMatch(/nothing to close out/i);
  expect(listPageSrc).toMatch(/<details/);
});
```

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts'` — expected FAIL.

- [ ] **Step 2: Implement**

In `app/(admin)/po-closeout/page.tsx`, after `filtered` is computed (line 56):

```ts
// SIMPLIFY-A — a PO with no bags has nothing to close out; a full row costs a
// click just to learn that. Collapse them under the table.
const withBags = filtered.filter((p) => p.bagCount > 0);
const emptyPos = filtered.filter((p) => p.bagCount === 0);
```

Render the table from `withBags` (the existing `filtered.map(...)` becomes `withBags.map(...)`; the empty-state check becomes `withBags.length === 0 && emptyPos.length === 0`). After the `DataTable`, add:

```tsx
{emptyPos.length > 0 ? (
  <details className="rounded-lg border border-border bg-surface-2/40 px-4 py-2 text-[12px] text-text-muted">
    <summary className="cursor-pointer">
      {emptyPos.length} PO{emptyPos.length === 1 ? " has" : "s have"} no bags — nothing to close out
    </summary>
    <ul className="mt-2 space-y-1">
      {emptyPos.map((p) => (
        <li key={p.id} className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold">{p.poNumber}</span>
          <span>{p.vendorName ?? "—"}</span>
          <Link href={`/po-closeout/${p.id}`} className="text-xs text-brand-700 hover:underline">Open anyway</Link>
        </li>
      ))}
    </ul>
  </details>
) : null}
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`
Expected: PASS.

```bash
git add 'app/(admin)/po-closeout/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): collapse zero-bag POs into a nothing-to-do section"
```

---

### Task 9: Phase gate — full suite, build, closeout smoke

**Files:**
- No new files. Runs the canonical closeout gate from the `luma-test-build-deploy` skill.

**Interfaces:**
- Consumes: everything above.
- Produces: green gate; Phase A ready to push.

- [ ] **Step 1: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (baseline ~5.6k). Any failure in a file this phase did not touch is still this phase's to investigate before proceeding — use superpowers:systematic-debugging.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build completes; note any new route-size warnings but they are not blockers.

- [ ] **Step 4: Report in the canonical shape and stop**

Follow the `luma-test-build-deploy` skill's report format (typecheck / vitest count / build / smoke status). Do NOT push to main or deploy — the human partner reviews the phase first (per the phase-pipeline pattern: suite-gated push and health-SHA deploy confirm are their call).
