# Luma Simplify Phase C — Zoho Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Zoho work in its own lane — mapping gaps roll up to one PO-level banner instead of 51 disabled buttons, "Queue all ready" is one bulk action, the ops page accepts filtered deep-links with a way back, and failed Zoho ops stop painting the PO header red.

**Architecture:** The classifier stops emitting BLOCKED for Zoho-only failures (pure change); the closeout loader carries the op id and a needs-mapping flag per row (the normalized status currently destroys that signal); a pure rollup summarizes distinct SKUs needing mapping; the bulk queue follows the established PO-batch template around the existing `queueConsolidatedProductionOutputOp` service (which re-checks READY|FAILED in its own update). The ops page gains `?po=` filtering via the PO→receives→bags→lots chain — the only path that includes mapping-blocked ops, whose Zoho PO id is null.

**Tech Stack:** Next.js 15 App Router (RSC + server actions), React 19, TypeScript strict, Drizzle/Postgres, Tailwind v3, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-luma-simplify-design.md` (Phase C section)

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- No emoji anywhere in UI.
- All Zoho calls stay on `zoho-integration-service` (gateway-only). Queueing only flips op status to QUEUED — the cron/worker commits. Nothing in this phase performs a live Zoho write.
- PO-scoped batches: ONE audit with `scope: "PO"`, `po_id`, `ready_at_scan`, affected/skipped counts, `skipped_reasons`, `zoho_output_committed: false`; cap 100 (`PO_BATCH_CAP`).
- No new mutation endpoints under `_drawer/`.
- Data honesty: counts never contradict rows; "Blocked" must mean floor-blocked, not Zoho-retry.
- Structural tests assert source text — `po-closeout-structural.test.ts` (QUEUE-FIX-1 describe, lines ~136-189) pins exact literals in `_drawer/zoho-actions.tsx` and `zoho-production-operations/actions.ts` (result-object signatures, "Not authorized.", "Missing operation id.", `QUEUEABLE_STATUSES`, "Cannot queue" copy). Do not break those literals; when a task changes an asserted pattern it updates the assertion truthfully in the same task.
- Run focused tests with `npx vitest run <file>`; full suite only in the gate task.
- Commit messages: conventional commits + session trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01MYojhbV7ZEqC2M6m8m2B9T`

## Facts established by code exploration (implementers rely on these)

- `queueConsolidatedProductionOutputOp(opId, actor)` (lib/db/queries/zoho-production-output-consolidated.ts:1064-1106) requires status READY or FAILED (else returns an error result), sets QUEUED + idempotency key + `autoCommitEligibleAt`; it writes NO audit row itself. `queueProductionOutputOpAction` (app/(admin)/zoho-production-operations/actions.ts:33-45) is the OWNER|ADMIN FormData wrapper; it revalidates only `/zoho-production-operations`.
- `normalizeZohoStatus` (lib/db/queries/po-closeout.ts:105-121) collapses `DRAFT|PREVIEWED|NEEDS_MAPPING|HELD` into `NOT_READY` — the loader's op select (po-closeout.ts:274-283) currently fetches only `{finishedLotId, status, committedAt}`; widening it is the single place to recover NEEDS_MAPPING, the op id, and `finishedSku`.
- `PoCloseoutRow` already has `productId` (Phase B) and `finishedLotId`; the classifier's FAILED-Zoho branch (lib/production/po-closeout.ts:393) currently returns `BLOCKED`, which `derivePoOverallStatus` propagates to the PO header badge.
- Ops table has NO Luma `poId`; `zohoPurchaseorderId` is Zoho's external id and is NULL on every NEEDS_MAPPING op — `?po=` filtering MUST resolve the PO's finished-lot ids via the po-closeout chain (receives.poId → smallBoxes → inventoryBags → workflowBags → finishedLots) and filter `inArray(zohoProductionOutputOps.finishedLotId, lotIds)`.
- `deriveApplicableBagActions` (lib/production/bag-closeout-actions.ts:60-61) pushes `ZOHO_QUEUE` for any non-FAILED zoho — including NOT_READY rows, which is where the useless disabled queue button comes from.
- The drawer chain for props: `closeout-rows.tsx` → `BagDrawer` (has `poId`) → `ActionPanels` (no poId today) → `ZohoActions` (renders the bare `/zoho-production-operations` link).
- The ops page (app/(admin)/zoho-production-operations/page.tsx, 243 lines) takes no searchParams; loader `listConsolidatedProductionOutputOps(100)` select-all, no joins; per-op fields include `id, finishedLotId, productId, finishedSku, status, mappingBlockers`.
- `app/(admin)/zoho-production-operations/staging-buttons.test.ts` pins the route's action imports; there is no test on `page.tsx` today.
- Phase A/B shipped: bucket tabs (`WAITING_ZOHO` from action `QUEUE_OR_RETRY_ZOHO` regardless of status), `PoBatchButtons` with `useBatch()`, `qs()` URL helper, `PoBatchResult` shape, workflow `?bag=` UUID-guard precedent (strict UUID regex).

---

### Task 1: Failed Zoho ops stop blocking the PO header (pure classifier)

**Files:**
- Modify: `lib/production/po-closeout.ts` (FAILED branch, ~line 393)
- Test: `lib/production/po-closeout.test.ts` (update the FAILED expectation; add a header-derivation case)

**Interfaces:**
- Consumes: existing classifier structure.
- Produces: FAILED-Zoho rows are `NEEDS_REVIEW` (action `QUEUE_OR_RETRY_ZOHO`, label "Retry in Zoho operations", reason "Failed Zoho output op — retry"). `derivePoOverallStatus` therefore can no longer return BLOCKED for Zoho-only failure. Bucket derivation is untouched (action-based → still `WAITING_ZOHO`).

- [ ] **Step 1: Update the failing tests**

In `lib/production/po-closeout.test.ts`, find the existing case `"released + FAILED Zoho op = BLOCKED with retry action"` (~line 56) and replace it:

```ts
it("SIMPLIFY-C: released + FAILED Zoho op = NEEDS_REVIEW retry — Zoho retry is not a floor block", () => {
  const r = classifyPoCloseoutRow({ ...doneRow, zoho: "FAILED" });
  expect(r.status).toBe("NEEDS_REVIEW");
  expect(r.status).not.toBe("BLOCKED");
  expect(r.action).toBe("QUEUE_OR_RETRY_ZOHO");
  expect(r.reason).toMatch(/retry/i);
});

it("SIMPLIFY-C: a PO whose only open work is a failed Zoho op is not BLOCKED overall", () => {
  const statuses = [
    classifyPoCloseoutRow(doneRow).status,
    classifyPoCloseoutRow({ ...doneRow, zoho: "FAILED" }).status,
  ];
  expect(derivePoOverallStatus(statuses)).toBe("NEEDS_REVIEW");
});
```

Check for any other assertion in the file (and in `lib/production/guided-closeout.test.ts`, `lib/production/bag-closeout-actions.test.ts`, `lib/production/closeout-recommendation.test.ts`) that expects FAILED→BLOCKED and update those expectations truthfully (`grep -rn 'FAILED' lib/production/*.test.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/po-closeout.test.ts`
Expected: FAIL — classifier still returns BLOCKED.

- [ ] **Step 3: Implement**

In `lib/production/po-closeout.ts` (~line 393), change the FAILED case:

```ts
case "FAILED":
  // SIMPLIFY-C — a failed Zoho push is retryable Zoho-side work, not a
  // floor block. BLOCKED is reserved for work stuck on missing data/setup;
  // painting the PO header red for a Zoho retry misled operators.
  return verdict("NEEDS_REVIEW", "Failed Zoho output op — retry", "QUEUE_OR_RETRY_ZOHO", "Retry in Zoho operations");
```

- [ ] **Step 4: Verify**

Run: `npx vitest run lib/production/po-closeout.test.ts lib/production/guided-closeout.test.ts lib/production/bag-closeout-actions.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts
git commit -m "feat(closeout): failed Zoho ops are retryable review work, never floor-blocked"
```

(Include any other updated test files in the add.)

---

### Task 2: Loader carries op id + needs-mapping; pure SKU rollup

**Files:**
- Modify: `lib/db/queries/po-closeout.ts` (op select ~274-283; `PoCloseoutRow` + `PoCloseoutSummary`)
- Modify: `lib/production/po-closeout.ts` (append pure `summarizeMappingNeeds`)
- Test: `lib/production/po-closeout.test.ts` (pure rollup) + `lib/db/queries/po-closeout-zoho.test.ts` (structural wiring)

**Interfaces:**
- Consumes: existing op fetch and row assembly.
- Produces:
  - `PoCloseoutRow` gains `zohoOpId: string | null` and `zohoNeedsMapping: boolean`.
  - `PoCloseoutSummary` gains `zohoMapping: MappingNeedsSummary`.
  - Pure: `type MappingNeedsSummary = { rows: number; skus: Array<{ productId: string | null; sku: string; count: number }> }` and `summarizeMappingNeeds(rows: Array<{ productId: string | null; finishedSku?: string | null; zohoNeedsMapping: boolean }>): MappingNeedsSummary` — distinct by productId+sku, `sku` falls back to `"(unknown SKU)"`, sorted by count desc. Tasks 3 and 5 consume these exact names.

- [ ] **Step 1: Write the failing pure tests**

Append to `lib/production/po-closeout.test.ts`:

```ts
import { summarizeMappingNeeds } from "./po-closeout";

describe("SIMPLIFY-C: summarizeMappingNeeds", () => {
  it("rolls dozens of identical rows up to distinct SKUs with counts, sorted desc", () => {
    const rows = [
      ...Array.from({ length: 43 }, () => ({ productId: "p1", finishedSku: "SKU-A", zohoNeedsMapping: true })),
      ...Array.from({ length: 2 }, () => ({ productId: "p2", finishedSku: "SKU-B", zohoNeedsMapping: true })),
      { productId: "p3", finishedSku: "SKU-C", zohoNeedsMapping: false },
    ];
    const m = summarizeMappingNeeds(rows);
    expect(m.rows).toBe(45);
    expect(m.skus).toEqual([
      { productId: "p1", sku: "SKU-A", count: 43 },
      { productId: "p2", sku: "SKU-B", count: 2 },
    ]);
  });
  it("unknown SKU falls back honestly and empty input yields zero", () => {
    expect(summarizeMappingNeeds([{ productId: null, zohoNeedsMapping: true }])).toEqual({
      rows: 1,
      skus: [{ productId: null, sku: "(unknown SKU)", count: 1 }],
    });
    expect(summarizeMappingNeeds([])).toEqual({ rows: 0, skus: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/po-closeout.test.ts` — FAIL (not exported).

- [ ] **Step 3: Implement the pure rollup**

Append to `lib/production/po-closeout.ts`:

```ts
// ── SIMPLIFY-C · mapping-needs rollup ───────────────────────────────────────
// Dozens of closeout rows blocked on the same unmapped SKU are ONE product
// mapping to fix, not dozens of reviews. Pure aggregation for the PO-level
// "N SKUs need Zoho mapping" banner.

export type MappingNeedsSummary = {
  rows: number;
  skus: Array<{ productId: string | null; sku: string; count: number }>;
};

export function summarizeMappingNeeds(
  rows: Array<{ productId: string | null; finishedSku?: string | null; zohoNeedsMapping: boolean }>,
): MappingNeedsSummary {
  const byKey = new Map<string, { productId: string | null; sku: string; count: number }>();
  let total = 0;
  for (const r of rows) {
    if (!r.zohoNeedsMapping) continue;
    total += 1;
    const sku = r.finishedSku ?? "(unknown SKU)";
    const key = `${r.productId ?? ""}|${sku}`;
    const prev = byKey.get(key);
    if (prev) prev.count += 1;
    else byKey.set(key, { productId: r.productId, sku, count: 1 });
  }
  return { rows: total, skus: [...byKey.values()].sort((a, b) => b.count - a.count) };
}
```

- [ ] **Step 4: Widen the loader**

In `lib/db/queries/po-closeout.ts`:
- Op select (~line 276) adds `id: zohoProductionOutputOps.id`, `finishedSku: zohoProductionOutputOps.finishedSku` (keep existing fields; the map keyed by finishedLotId keeps the same shape plus the new fields).
- `PoCloseoutRow` gains `zohoOpId: string | null; zohoNeedsMapping: boolean;` populated per row: `zohoOpId: op?.id ?? null`, `zohoNeedsMapping: (op?.status ?? "").toUpperCase() === "NEEDS_MAPPING"`. The row also needs `finishedSku` available for the rollup — do NOT add it to `PoCloseoutRow`; instead build the rollup input inline.
- `PoCloseoutSummary` gains `zohoMapping: MappingNeedsSummary;` computed as
  `summarizeMappingNeeds(rows.map((r) => ({ productId: r.productId, finishedSku: opByLot.get(r.finishedLotId ?? "")?.finishedSku ?? null, zohoNeedsMapping: r.zohoNeedsMapping })))` — adapt the map variable name to the loader's actual one.

- [ ] **Step 5: Extend the zoho structural test**

In `lib/db/queries/po-closeout-zoho.test.ts` (it reads the loader source in its "loader wiring" describe — follow its existing pattern):

```ts
it("SIMPLIFY-C: loader carries op id + needs-mapping and builds the SKU rollup", () => {
  expect(loaderSrc).toMatch(/zohoOpId/);
  expect(loaderSrc).toMatch(/NEEDS_MAPPING/);
  expect(loaderSrc).toMatch(/summarizeMappingNeeds/);
});
```

(Adapt to that file's source-reading helper/const names.)

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run lib/production/po-closeout.test.ts lib/db/queries/po-closeout-zoho.test.ts && npx tsc --noEmit`

```bash
git add lib/production/po-closeout.ts lib/production/po-closeout.test.ts lib/db/queries/po-closeout.ts lib/db/queries/po-closeout-zoho.test.ts
git commit -m "feat(closeout): carry Zoho op id + needs-mapping per row; SKU mapping rollup"
```

---

### Task 3: Mapping banner in Waiting-on-Zoho; no disabled queue panels

**Files:**
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (banner in the Waiting-on-Zoho tab context)
- Modify: `lib/production/bag-closeout-actions.ts` (ZOHO_QUEUE only when READY_TO_QUEUE)
- Test: `lib/production/bag-closeout-actions.test.ts` + `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `summary.zohoMapping` (Task 2); existing `deriveApplicableBagActions` input shape.
- Produces: drawer renders a Zoho panel ONLY for `READY_TO_QUEUE` (queue) and `FAILED` (retry); `NOT_READY` rows get no Zoho action panel (state chip + banner cover them). Page shows one banner when `zohoMapping.skus.length > 0` and the active tab is `zoho` (or `all`).

- [ ] **Step 1: Write the failing pure tests**

Append to `lib/production/bag-closeout-actions.test.ts` (mirror its existing input fixture style):

```ts
describe("SIMPLIFY-C: Zoho panels only when actionable", () => {
  const base = {
    rowStatus: "NEEDS_REVIEW",
    rowAction: "QUEUE_OR_RETRY_ZOHO",
    hasWorkflow: true,
    hasFinishedLot: true,
    lotStatus: "RELEASED",
    allocationOpen: false,
  };
  it("NOT_READY renders no Zoho panel (mapping is fixed at product/PO level)", () => {
    expect(deriveApplicableBagActions({ ...base, zoho: "NOT_READY" })).not.toContain("ZOHO_QUEUE");
    expect(deriveApplicableBagActions({ ...base, zoho: "NOT_READY" })).not.toContain("ZOHO_RETRY");
  });
  it("READY_TO_QUEUE still queues; FAILED still retries", () => {
    expect(
      deriveApplicableBagActions({ ...base, rowStatus: "READY_FOR_ACTION", zoho: "READY_TO_QUEUE" }),
    ).toContain("ZOHO_QUEUE");
    expect(deriveApplicableBagActions({ ...base, zoho: "FAILED" })).toContain("ZOHO_RETRY");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/production/bag-closeout-actions.test.ts` — FAIL (NOT_READY currently yields ZOHO_QUEUE).

- [ ] **Step 3: Implement the dispatcher change**

In `lib/production/bag-closeout-actions.ts` (~lines 60-61):

```ts
case "QUEUE_OR_RETRY_ZOHO":
  // SIMPLIFY-C — a disabled queue button on a mapping-blocked op is noise;
  // mapping is fixed once at the product/PO level. Panels render only when
  // the op is actually actionable here.
  if (input.zoho === "FAILED") actions.push("ZOHO_RETRY");
  else if (input.zoho === "READY_TO_QUEUE") actions.push("ZOHO_QUEUE");
  break;
```

- [ ] **Step 4: Implement the banner**

In `app/(admin)/po-closeout/[poId]/page.tsx`, render after the recommendation banner, only when relevant:

```tsx
{(tab === "zoho" || tab === "all") && summary.zohoMapping.skus.length > 0 ? (
  <div className="rounded-lg border border-sky-300/40 bg-sky-50/40 px-4 py-2.5">
    <p className="text-[12px] font-medium text-sky-900">
      {summary.zohoMapping.skus.length} SKU{summary.zohoMapping.skus.length === 1 ? "" : "s"} need Zoho
      mapping — fixing {summary.zohoMapping.skus.length === 1 ? "it" : "them"} unblocks {summary.zohoMapping.rows} bag
      {summary.zohoMapping.rows === 1 ? "" : "s"}.
    </p>
    <ul className="mt-1 space-y-0.5 text-[11px] text-sky-900">
      {summary.zohoMapping.skus.map((s) => (
        <li key={`${s.productId ?? ""}|${s.sku}`} className="flex items-center gap-2">
          <span className="font-mono">{s.sku}</span>
          <span className="text-sky-700">({s.count} bag{s.count === 1 ? "" : "s"})</span>
          {s.productId ? (
            <Link href={`/products/${s.productId}?from=output-queue`} className="font-medium underline">
              Fix mapping
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
    <Link href={`/zoho-production-operations?po=${poId}`} className="mt-1 inline-block text-[11px] font-medium text-sky-800 underline">
      Open this PO's Zoho operations
    </Link>
  </div>
) : null}
```

(The `?po=` target ships in Task 4 — the link is correct once that lands; tasks merge in order.)

- [ ] **Step 5: Structural pins**

In `po-closeout-structural.test.ts` add (adapting helper names):

```ts
it("SIMPLIFY-C: mapping rolls up to one PO banner; drawer never renders a disabled queue panel", () => {
  expect(detailPageSrc).toMatch(/zohoMapping\.skus/);
  expect(detailPageSrc).toMatch(/need Zoho\s+mapping/);
  const dispatcher = repo("lib/production/bag-closeout-actions.ts");
  expect(dispatcher).toMatch(/READY_TO_QUEUE/);
});
```

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run lib/production/bag-closeout-actions.test.ts 'app/(admin)/po-closeout/po-closeout-structural.test.ts' && npx tsc --noEmit`

```bash
git add lib/production/bag-closeout-actions.ts lib/production/bag-closeout-actions.test.ts 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): PO-level mapping banner; Zoho panels only when actionable"
```

---

### Task 4: Filtered ops page (`?po=`, `?op=`) + round-trip links

**Files:**
- Modify: `lib/db/queries/zoho-production-output-consolidated.ts` (new `listConsolidatedProductionOutputOpsForPo`)
- Modify: `app/(admin)/zoho-production-operations/page.tsx` (searchParams, filter line, back link)
- Modify: `app/(admin)/po-closeout/_drawer/closeout-rows.tsx` (`rowLink` QUEUE_OR_RETRY_ZOHO case gains `?po=`)
- Modify: `app/(admin)/po-closeout/_drawer/zoho-actions.tsx` + `action-panels.tsx` + `bag-drawer.tsx` (thread `poId` so the panel's link is filtered)
- Test: create `app/(admin)/zoho-production-operations/ops-filter-structural.test.ts`

**Interfaces:**
- Consumes: the po-closeout PO→lots chain (mirror `receives.poId → smallBoxes → inventoryBags → workflowBags → finishedLots` joins from `lib/db/queries/po-closeout.ts:142-162`); UUID guard precedent `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` from `app/(admin)/workflow-submissions/page.tsx`.
- Produces: URL contract `/zoho-production-operations?po=<poId>` (ops for that PO's lots, incl. NEEDS_MAPPING ones) and `?op=<opId>` (single op); "Back to closeout" link when `?po=` present; `ZohoActions` gains prop `poId: string`. `rowLink(row, poId)` signature change in closeout-rows (it is called in the same file; update the call site).

- [ ] **Step 1: Write the failing structural test**

Create `app/(admin)/zoho-production-operations/ops-filter-structural.test.ts`:

```ts
// SIMPLIFY-C — "Fix mapping" must land on the relevant ops, not an
// unfiltered 100-row list, and must offer the way back to closeout.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
const repo = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const pageSrc = repo("app/(admin)/zoho-production-operations/page.tsx");
const querySrc = repo("lib/db/queries/zoho-production-output-consolidated.ts");

describe("zoho ops filtered deep-links", () => {
  it("page parses ?po= and ?op= with strict UUID guards", () => {
    expect(pageSrc).toMatch(/searchParams/);
    expect(pageSrc).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    expect(pageSrc).toMatch(/Back to closeout/);
  });
  it("PO filter resolves lots via the receives chain, never zohoPurchaseorderId", () => {
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo/);
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo[\s\S]{0,900}receives\.poId/);
    expect(querySrc).toMatch(/listConsolidatedProductionOutputOpsForPo[\s\S]{0,1500}finishedLotId/);
  });
  it("closeout rows and the drawer panel deep-link with ?po=", () => {
    expect(repo("app/(admin)/po-closeout/_drawer/closeout-rows.tsx")).toMatch(/\/zoho-production-operations\?po=/);
    expect(repo("app/(admin)/po-closeout/_drawer/zoho-actions.tsx")).toMatch(/\/zoho-production-operations\?po=/);
  });
});
```

Run: `npx vitest run 'app/(admin)/zoho-production-operations/ops-filter-structural.test.ts'` — FAIL.

- [ ] **Step 2: Implement the loader**

In `lib/db/queries/zoho-production-output-consolidated.ts`, beside `listConsolidatedProductionOutputOps`:

```ts
/** SIMPLIFY-C — ops for one PO, resolved via the PO's finished lots (the
 *  receives chain). NEEDS_MAPPING ops have zohoPurchaseorderId = null, so
 *  filtering on the Zoho PO id would hide exactly the ops an admin comes
 *  here to fix; the lot chain covers them. READ-ONLY. */
export async function listConsolidatedProductionOutputOpsForPo(poId: string, limit = 100) {
  const lotRows = await db
    .select({ finishedLotId: finishedLots.id })
    .from(receives)
    .innerJoin(smallBoxes, eq(smallBoxes.receiveId, receives.id))
    .innerJoin(inventoryBags, eq(inventoryBags.smallBoxId, smallBoxes.id))
    .innerJoin(workflowBags, eq(workflowBags.inventoryBagId, inventoryBags.id))
    .innerJoin(finishedLots, eq(finishedLots.workflowBagId, workflowBags.id))
    .where(eq(receives.poId, poId));
  const lotIds = [...new Set(lotRows.map((r) => r.finishedLotId))];
  if (lotIds.length === 0) return [];
  return db
    .select()
    .from(zohoProductionOutputOps)
    .where(
      and(
        eq(zohoProductionOutputOps.payloadKind, "consolidated"),
        inArray(zohoProductionOutputOps.finishedLotId, lotIds),
      ),
    )
    .orderBy(desc(zohoProductionOutputOps.updatedAt))
    .limit(limit);
}
```

IMPORTANT: before writing, read the existing po-closeout loader chain (lib/db/queries/po-closeout.ts:142-162) and mirror its actual join columns (e.g. whether inventoryBags links via `smallBoxId`); import whatever tables the file doesn't already import. Match the existing `listConsolidatedProductionOutputOps` return typing.

- [ ] **Step 3: Implement the page filter**

In `app/(admin)/zoho-production-operations/page.tsx`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// in the component:
const sp = await searchParams;
const po = typeof sp["po"] === "string" && UUID_RE.test(sp["po"]) ? sp["po"] : null;
const opFilter = typeof sp["op"] === "string" && UUID_RE.test(sp["op"]) ? sp["op"] : null;
let ops = po ? await listConsolidatedProductionOutputOpsForPo(po) : await listConsolidatedProductionOutputOps(100);
if (opFilter !== null) ops = ops.filter((o) => o.id === opFilter);
```

(Add `searchParams: Promise<Record<string, string | string[] | undefined>>` to the props and adapt names to the file.) Above the table, when `po !== null`:

```tsx
<div className="flex items-center gap-3 text-[12px] text-text-muted">
  <span>
    Showing {ops.length} operation{ops.length === 1 ? "" : "s"} for this PO.
  </span>
  <Link href={`/po-closeout/${po}`} className="font-medium text-brand-700 hover:underline">
    Back to closeout
  </Link>
  <Link href="/zoho-production-operations" className="hover:underline">
    Clear filter
  </Link>
</div>
```

Zero-param behavior must remain byte-identical.

- [ ] **Step 4: Thread poId through the drawer and rows**

- `closeout-rows.tsx`: change `rowLink(row)` to `rowLink(row, poId)` (single internal call site) and the `QUEUE_OR_RETRY_ZOHO` case to `` { href: `/zoho-production-operations?po=${poId}`, label: "Zoho output" } ``.
- `bag-drawer.tsx` already has `poId` — pass `poId={poId}` to `ActionPanels`; `action-panels.tsx` accepts `poId: string` and passes it to `ZohoActions`; `zoho-actions.tsx` accepts `poId: string` and its `<Link>` becomes `` href={`/zoho-production-operations?po=${poId}`} `` (keep the link text and every pinned literal — the QUEUE-FIX-1 structural assertions must stay green).

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run 'app/(admin)/zoho-production-operations/ops-filter-structural.test.ts' 'app/(admin)/po-closeout/po-closeout-structural.test.ts' 'app/(admin)/zoho-production-operations/staging-buttons.test.ts' && npx tsc --noEmit`

```bash
git add lib/db/queries/zoho-production-output-consolidated.ts 'app/(admin)/zoho-production-operations/page.tsx' 'app/(admin)/zoho-production-operations/ops-filter-structural.test.ts' 'app/(admin)/po-closeout/_drawer/closeout-rows.tsx' 'app/(admin)/po-closeout/_drawer/zoho-actions.tsx' 'app/(admin)/po-closeout/_drawer/action-panels.tsx' 'app/(admin)/po-closeout/_drawer/bag-drawer.tsx'
git commit -m "feat(zoho-ops): filtered deep-links by PO/op with round-trip back to closeout"
```

---

### Task 5: PO-level "Queue all ready"

**Files:**
- Modify: `app/(admin)/po-closeout/actions.ts` (new `queueZohoReadyForPoAction`)
- Modify: `app/(admin)/po-closeout/batch-buttons.tsx` (fourth button, `queueReady: number` prop)
- Modify: `app/(admin)/po-closeout/[poId]/page.tsx` (compute `queueReady`, widen strip condition)
- Test: extend `app/(admin)/po-closeout/po-closeout-structural.test.ts`

**Interfaces:**
- Consumes: `queueConsolidatedProductionOutputOp(opId, actor)` from `@/lib/db/queries/zoho-production-output-consolidated` (re-checks READY|FAILED in its own update; returns a result object — read its exact return shape before writing the loop); `PoCloseoutRow.zohoOpId` (Task 2).
- Produces: `queueZohoReadyForPoAction(poId: string): Promise<PoBatchResult>`; `PoBatchButtons` prop `queueReady: number`; page count `queueReady = rows where zoho === "READY_TO_QUEUE" && zohoOpId != null`.

- [ ] **Step 1: Failing structural test**

```ts
it("SIMPLIFY-C: PO bulk queue reuses the per-op service, audits PO-scoped, never commits", () => {
  expect(actionsSrc).toMatch(/export async function queueZohoReadyForPoAction/);
  expect(actionsSrc).toMatch(/queueConsolidatedProductionOutputOp\(/);
  expect(actionsSrc).toMatch(/zoho_production_output_op\.queue_batch/);
  expect(actionsSrc).toMatch(/queueZohoReadyForPoAction[\s\S]{0,300}requireAdmin\(\)/);
  expect(repo("app/(admin)/po-closeout/batch-buttons.tsx")).toMatch(/queueReady/);
});
```

Run the structural file — FAIL.

- [ ] **Step 2: Implement the action**

Append to `app/(admin)/po-closeout/actions.ts` (admin-gated to match the per-op queue action's OWNER|ADMIN rule — `requireAdmin`):

```ts
/** Queue every READY_TO_QUEUE Zoho output op on this PO. The per-op service
 *  re-checks status (READY|FAILED) inside its own update — a row that
 *  changed since the scan is skipped, never forced. Queueing only marks the
 *  op for the worker; committing to Zoho stays with the cron/worker via the
 *  integration gateway. */
export async function queueZohoReadyForPoAction(poId: string): Promise<PoBatchResult> {
  const actor = await requireAdmin();
  try {
    const summary = await loadPoCloseout(poId);
    if (!summary) return { ok: false, error: "PO not found." };
    const targets = summary.rows
      .filter((r) => r.zoho === "READY_TO_QUEUE" && r.zohoOpId != null)
      .slice(0, PO_BATCH_CAP);

    const queued: string[] = [];
    const skipped: string[] = [];
    for (const r of targets) {
      const result = await queueConsolidatedProductionOutputOp(r.zohoOpId!, actor);
      if (result.ok) queued.push(r.finishedLotNumber ?? r.zohoOpId!);
      else skipped.push(result.error);
    }

    await writeAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "zoho_production_output_op.queue_batch",
      targetType: "PoCloseout",
      targetId: poId,
      after: {
        source: "PO_QUEUE_ALL_READY",
        scope: "PO",
        po_id: poId,
        po_number: summary.poNumber,
        ready_at_scan: targets.length,
        queued: queued.length,
        skipped: skipped.length,
        queued_lot_numbers: queued,
        skipped_reasons: skipped,
        zoho_output_committed: false,
        note: "Queued for the worker only; commits happen via the Zoho integration gateway cron.",
      },
    });

    if (queued.length > 0) {
      revalidatePath(`/po-closeout/${poId}`);
      revalidatePath("/po-closeout");
      revalidatePath("/zoho-production-operations");
    }
    return {
      ok: true,
      affected: queued.length,
      skipped: skipped.length,
      capped: summary.rows.filter((r) => r.zoho === "READY_TO_QUEUE").length > PO_BATCH_CAP,
      skippedReasons: skipped,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "PO queue-all failed." };
  }
}
```

Verify `queueConsolidatedProductionOutputOp`'s exact return shape (`{ok:true,...}|{ok:false,error}` vs `reason`) by reading it first; adapt the error extraction truthfully. Import it and `requireAdmin` (already imported).

- [ ] **Step 3: Button + page wiring**

`batch-buttons.tsx`: prop `queueReady: number`; render (mirroring the calc button's structure, hidden at 0):
confirm text `"Queue N Zoho output ops? The worker commits them via the integration service; nothing is pushed immediately."`; label `` `Queue all ready for Zoho (${queueReady})` ``.

Page: `const queueReady = summary.rows.filter((r) => r.zoho === "READY_TO_QUEUE" && r.zohoOpId != null).length;`, pass `queueReady={queueReady}`, widen the strip render condition to include `queueReady > 0`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run 'app/(admin)/po-closeout/po-closeout-structural.test.ts' 'lib/db/queries/po-closeout-zoho.test.ts' && npx tsc --noEmit`

```bash
git add 'app/(admin)/po-closeout/actions.ts' 'app/(admin)/po-closeout/batch-buttons.tsx' 'app/(admin)/po-closeout/[poId]/page.tsx' 'app/(admin)/po-closeout/po-closeout-structural.test.ts'
git commit -m "feat(closeout): PO-level Queue-all-ready for Zoho output"
```

---

### Task 6: Phase gate — full suite, build

**Files:** none new.

- [ ] **Step 1:** `npx tsc --noEmit && npm run lint` — clean.
- [ ] **Step 2:** `npx vitest run` — all pass (baseline 5724 + additions). Any failure anywhere is this phase's to investigate (superpowers:systematic-debugging).
- [ ] **Step 3:** `npm run build` — completes.
- [ ] **Step 4:** Report in the canonical `luma-test-build-deploy` shape. No push/deploy — human reviews first.
